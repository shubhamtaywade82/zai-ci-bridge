import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  classifyWorkflowRuns,
  isSafeRepositoryPath,
  loadConfig,
  normalizeFixBranch,
  parseAllowedRepos,
  validateFixFiles
} from "../src/index.js";

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
