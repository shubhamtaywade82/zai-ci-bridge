import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  classifyWorkflowRuns,
  discoverAccessibleRepos,
  isRepoAllowed,
  isSafeRepositoryPath,
  loadConfig,
  normalizeFixBranch,
  parseAllowedRepos,
  validateFixFiles
} from "../src/index.ts";

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

test("parseAllowedRepos trims entries and removes duplicates", () => {
  assert.deepEqual(parseAllowedRepos(" acme/api,acme/web, acme/api "), ["acme/api", "acme/web"]);
});

test("parseAllowedRepos rejects URL and traversal forms", () => {
  assert.throws(() => parseAllowedRepos("https://github.com/acme/api"), /Invalid repository name/);
  assert.throws(() => parseAllowedRepos("acme/api,../other"), /Invalid repository name/);
});

test("loadConfig validates the PR target mode and integer limits", () => {
  assert.equal(loadConfig({ NON_DEFAULT_PR_TARGET_MODE: "broken_branch" }).prTargetMode, "broken_branch");
  assert.throws(() => loadConfig({ NON_DEFAULT_PR_TARGET_MODE: "anywhere" }), /must be original_base or broken_branch/);
  assert.throws(() => loadConfig({ MAX_BOT_COMMITS_PER_BRANCH: "0" }), /between 1 and 50/);
});

test("repository path policy blocks traversal, absolute paths and control-plane files", () => {
  for (const path of ["../README.md", "/etc/passwd", "src\\app.js", ".git/config", ".github/workflows/ci.yml", "src//index.js"]) {
    assert.equal(isSafeRepositoryPath(path), false, path);
  }
  assert.equal(isSafeRepositoryPath("src/index.js"), true);
});

test("validateFixFiles rejects duplicate paths and missing content", () => {
  assert.throws(() => validateFixFiles([
    { path: "src/a.js", content: "one" },
    { path: "src/a.js", content: "two" }
  ]), /Duplicate file path/);
  assert.throws(() => validateFixFiles([{ path: "src/a.js" }]), /content must be a string/);
});

test("validateFixFiles accepts edits and explicit deletions", () => {
  assert.deepEqual(validateFixFiles([
    { path: "src/a.js", content: "export default true;" },
    { path: "src/old.js", deleted: true }
  ]), [
    { path: "src/a.js", content: "export default true;", deleted: false },
    { path: "src/old.js", deleted: true }
  ]);
});

test("normalizeFixBranch produces a stable autofix name", () => {
  assert.equal(normalizeFixBranch("feature/payment-flow"), "autofix/feature-payment-flow");
  assert.equal(normalizeFixBranch("autofix/feature-payment-flow"), "autofix/feature-payment-flow");
});

test("classifyWorkflowRuns evaluates the latest run per workflow", () => {
  const result = classifyWorkflowRuns([
    { id: 1, workflow_id: 10, status: "completed", conclusion: "failure", created_at: "2026-10-31T10:00:00Z" },
    { id: 2, workflow_id: 10, status: "completed", conclusion: "success", created_at: "2026-10-31T11:00:00Z" },
    { id: 3, workflow_id: 11, status: "completed", conclusion: "success", created_at: "2026-10-31T11:00:00Z" }
  ]);
  assert.equal(result.state, "success");
  assert.equal(result.latestRuns.length, 2);
});

test("cancelled or neutral workflow conclusions are inconclusive, not green", () => {
  assert.equal(classifyWorkflowRuns([
    { id: 1, workflow_id: 1, status: "completed", conclusion: "cancelled" }
  ]).state, "inconclusive");
});

test("Worker rejects requests without the capability secret", async () => {
  const response = await worker.fetch(new Request("https://bridge.example/health"), {
    GITHUB_TOKEN: "token",
    CAPABILITY_SECRET: "secret"
  });
  assert.equal(response.status, 403);
});

test("parseAllowedRepos supports wildcard and trims input", () => {
  assert.equal(parseAllowedRepos("*"), "*");
  assert.equal(parseAllowedRepos("  *  "), "*");
});

test("isRepoAllowed validates repositories under wildcard and explicit lists", () => {
  assert.equal(isRepoAllowed("acme/api", "*"), true);
  assert.equal(isRepoAllowed("acme/api", ["acme/api"]), true);
  assert.equal(isRepoAllowed("acme/web", ["acme/api"]), false);
  assert.equal(isRepoAllowed("../etc/passwd", "*"), false);
  assert.equal(isRepoAllowed("not-a-valid-repo", "*"), false);
  assert.equal(isRepoAllowed(null, "*"), false);
  assert.equal(isRepoAllowed(undefined, ["acme/api"]), false);
});

test("loadConfig accepts wildcard ALLOWED_REPOS", () => {
  assert.equal(loadConfig({ ALLOWED_REPOS: "*" }).allowedRepos, "*");
});

test("discoverAccessibleRepos paginates and filters archived or disabled repos", async () => {
  const originalFetch = globalThis.fetch;
  const calls: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    const urlObj = new URL(getRequestUrl(input));
    const page = urlObj.searchParams.get("page");
    if (page === "1") {
      return new Response(JSON.stringify([
        { full_name: "acme/api", archived: false, disabled: false },
        { full_name: "acme/old", archived: true, disabled: false },
        { full_name: "acme/dead", archived: false, disabled: true },
        { full_name: "acme/web", archived: false, disabled: false }
      ]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const repos = await discoverAccessibleRepos({ Authorization: "Bearer token" }, 10);
    assert.deepEqual(repos, ["acme/api", "acme/web"]);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverAccessibleRepos handles multiple pages until limit is reached", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const page = new URL(getRequestUrl(input)).searchParams.get("page");
    if (page === "1") {
      return new Response(JSON.stringify([{ full_name: "acme/repo-1", archived: false, disabled: false }]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify([{ full_name: "acme/repo-2", archived: false, disabled: false }]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const repos = await discoverAccessibleRepos({ Authorization: "Bearer token" }, 2, 1);
    assert.deepEqual(repos, ["acme/repo-1", "acme/repo-2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker healthCheck enumerates discovered repos under wildcard mode", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const parsed = new URL(getRequestUrl(input));
    calls.push(parsed.pathname);
    if (parsed.pathname === "/user") {
      return new Response(JSON.stringify({ login: "bot-user" }), { status: 200 });
    }
    if (parsed.pathname === "/rate_limit") {
      return new Response(JSON.stringify({ rate: { remaining: 4999 } }), { status: 200 });
    }
    if (parsed.pathname === "/user/repos") {
      return new Response(JSON.stringify([{ full_name: "acme/api", archived: false, disabled: false }]), {
        status: 200
      });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    const response = await worker.fetch(new Request("https://bridge.example/health", {
      headers: { Authorization: "Bearer test-secret" }
    }), {
      GITHUB_TOKEN: "token",
      CAPABILITY_SECRET: "test-secret",
      ALLOWED_REPOS: "*"
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      status: string;
      allowedRepos: string;
      discoveredRepos: string[];
      repositoryAccess: Array<{ repo: string }>;
    };
    assert.equal(body.status, "ok");
    assert.equal(body.allowedRepos, "*");
    assert.deepEqual(body.discoveredRepos, ["acme/api"]);
    assert.equal(body.repositoryAccess.length, 1);
    assert.equal(body.repositoryAccess[0].repo, "acme/api");
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker healthCheck supports deep check for single repo with ?repo=...", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const parsed = new URL(getRequestUrl(input));
    if (parsed.pathname === "/user") {
      return new Response(JSON.stringify({ login: "bot-user" }), { status: 200 });
    }
    if (parsed.pathname === "/rate_limit") {
      return new Response(JSON.stringify({ rate: { remaining: 4999 } }), { status: 200 });
    }
    if (parsed.pathname === "/repos/acme/api") {
      return new Response(JSON.stringify({ default_branch: "main", permissions: { push: true } }), { status: 200 });
    }
    if (parsed.pathname === "/repos/acme/api/git/ref/heads/main") {
      return new Response(JSON.stringify({ object: { sha: "abc123" } }), { status: 200 });
    }
    if (parsed.pathname === "/repos/acme/api/actions/runs") {
      return new Response(JSON.stringify({ total_count: 5 }), { status: 200 });
    }
    if (parsed.pathname === "/repos/acme/api/pulls") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    const response = await worker.fetch(new Request("https://bridge.example/health?repo=acme/api", {
      headers: { Authorization: "Bearer test-secret" }
    }), {
      GITHUB_TOKEN: "token",
      CAPABILITY_SECRET: "test-secret",
      ALLOWED_REPOS: "*"
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { repositoryAccess: Array<{ repo: string; contentsRead: string }> };
    assert.equal(body.repositoryAccess.length, 1);
    assert.equal(body.repositoryAccess[0].contentsRead, "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker diagnostics in wildcard mode rejects unparameterized call to prevent subrequest limits", async () => {
  const response = await worker.fetch(new Request("https://bridge.example/diagnostics", {
    headers: { Authorization: "Bearer test-secret" }
  }), {
    GITHUB_TOKEN: "token",
    CAPABILITY_SECRET: "test-secret",
    ALLOWED_REPOS: "*"
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /In wildcard mode, specify \?repo=owner\/repo/);
});

test("Worker diagnostics in wildcard mode handles requested repo", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const parsed = new URL(getRequestUrl(input));
    if (parsed.pathname === "/repos/acme/api") {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (parsed.pathname === "/repos/acme/api/pulls") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (parsed.pathname === "/repos/acme/api/git/ref/heads/main") {
      return new Response(JSON.stringify({ object: { sha: "sha1" } }), { status: 200 });
    }
    if (parsed.pathname === "/repos/acme/api/actions/runs") {
      return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  try {
    const response = await worker.fetch(new Request("https://bridge.example/diagnostics?repo=acme/api", {
      headers: { Authorization: "Bearer test-secret" }
    }), {
      GITHUB_TOKEN: "token",
      CAPABILITY_SECRET: "test-secret",
      ALLOWED_REPOS: "*"
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { reports: Array<{ repo: string }> };
    assert.equal(body.reports.length, 1);
    assert.equal(body.reports[0].repo, "acme/api");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Worker diagnostics rejects invalid repo or disallowed repo", async () => {
  const response = await worker.fetch(new Request("https://bridge.example/diagnostics?repo=invalid..repo", {
    headers: { Authorization: "Bearer test-secret" }
  }), {
    GITHUB_TOKEN: "token",
    CAPABILITY_SECRET: "test-secret",
    ALLOWED_REPOS: "*"
  });
  assert.equal(response.status, 400);

  const disallowed = await worker.fetch(new Request("https://bridge.example/diagnostics?repo=forbidden/repo", {
    headers: { Authorization: "Bearer test-secret" }
  }), {
    GITHUB_TOKEN: "token",
    CAPABILITY_SECRET: "test-secret",
    ALLOWED_REPOS: "allowed/repo"
  });
  assert.equal(disallowed.status, 400);
});

test("Worker apply-fix checks authorization against allowlist and wildcard", async () => {
  const disallowedResponse = await worker.fetch(new Request("https://bridge.example/apply-fix", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      repo: "unauthorized/repo",
      sourceBranch: "fix",
      files: [{ path: "a.js", content: "x" }]
    })
  }), {
    GITHUB_TOKEN: "token",
    CAPABILITY_SECRET: "test-secret",
    ALLOWED_REPOS: "allowed/repo"
  });
  assert.equal(disallowedResponse.status, 400);

  const invalidRepoResponse = await worker.fetch(new Request("https://bridge.example/apply-fix", {
    method: "POST",
    headers: {
      Authorization: "Bearer test-secret",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      repo: "../evil/repo",
      sourceBranch: "fix",
      files: [{ path: "a.js", content: "x" }]
    })
  }), {
    GITHUB_TOKEN: "token",
    CAPABILITY_SECRET: "test-secret",
    ALLOWED_REPOS: "*"
  });
  assert.equal(invalidRepoResponse.status, 400);
});
