const GITHUB_API = "https://api.github.com";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_FILES_PER_FIX = 20;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_LOG_ARCHIVE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_TAIL_CHARS = 24_000;
const MAX_LOG_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_TARGETS = 50;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

class GitHubApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = authorizeAndResolveRoute(request, url, env.CAPABILITY_SECRET);
    if (!route) return jsonResponse({ error: "Forbidden" }, 403);

    if (!env.GITHUB_TOKEN) {
      return jsonResponse({ error: "Server misconfigured: missing GITHUB_TOKEN secret" }, 503);
    }

    let config;
    try {
      config = loadConfig(env);
    } catch (error) {
      return jsonResponse({ error: `Invalid Worker configuration: ${error.message}` }, 500);
    }

    const ghHeaders = {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "zai-ci-bridge"
    };

    try {
      if (request.method === "GET" && route.action === "health") {
        return await healthCheck(config, ghHeaders);
      }

      if (request.method === "GET" && route.action === "diagnostics") {
        return await handleDiagnostics(url, config, ghHeaders);
      }

      if (request.method === "POST" && route.action === "apply-fix") {
        const body = await readJsonBody(request);
        const result = await applyFix(body, config, ghHeaders);
        return jsonResponse(result);
      }

      return jsonResponse({ error: "Route not found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : error instanceof GitHubApiError
          ? (error.status === 404 ? 404 : error.status === 403 ? 403 : 502)
          : 500;
      return jsonResponse({ error: safeErrorMessage(error) }, status);
    }
  }
};

export function loadConfig(env) {
  const allowedRepos = parseAllowedRepos(env.ALLOWED_REPOS || "");
  const prTargetMode = env.NON_DEFAULT_PR_TARGET_MODE || "original_base";
  if (!["original_base", "broken_branch"].includes(prTargetMode)) {
    throw new Error("NON_DEFAULT_PR_TARGET_MODE must be original_base or broken_branch");
  }

  const maxBotCommits = parseIntegerInRange(env.MAX_BOT_COMMITS_PER_BRANCH || "5", 1, 50,
    "MAX_BOT_COMMITS_PER_BRANCH");
  const maxTargets = parseIntegerInRange(env.MAX_DIAGNOSTIC_TARGETS || "50", 1, 100,
    "MAX_DIAGNOSTIC_TARGETS");

  return { allowedRepos, prTargetMode, maxBotCommits, maxTargets };
}

export function isValidRepoName(repo) {
  if (typeof repo !== "string") return false;
  const [owner, name] = repo.split("/");
  return (
    Boolean(owner) &&
    Boolean(name) &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) &&
    owner !== "." &&
    owner !== ".." &&
    name !== "." &&
    name !== ".."
  );
}

export function parseAllowedRepos(value) {
  const normalized = String(value).trim();
  if (normalized === "*") return "*";

  const repos = [...new Set(normalized.split(",").map(item => item.trim()).filter(Boolean))];
  for (const repo of repos) {
    if (!isValidRepoName(repo)) {
      throw new Error(`Invalid repository name: ${repo}`);
    }
  }
  return repos;
}

export function isRepoAllowed(repo, allowedRepos) {
  if (!isValidRepoName(repo)) return false;
  return allowedRepos === "*" || (Array.isArray(allowedRepos) && allowedRepos.includes(repo));
}

export function validateFixFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new HttpError(400, "files must be a non-empty array");
  }
  if (files.length > MAX_FILES_PER_FIX) {
    throw new HttpError(413, `A fix may change at most ${MAX_FILES_PER_FIX} files`);
  }

  const seenPaths = new Set();
  return files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new HttpError(400, `files[${index}] must be an object`);
    }
    const path = file.path;
    if (typeof path !== "string" || path.length === 0 || path.length > 1024 || !isSafeRepositoryPath(path)) {
      throw new HttpError(403, `Path blocked by policy: ${String(path ?? "")}`);
    }
    if (seenPaths.has(path)) throw new HttpError(400, `Duplicate file path: ${path}`);
    seenPaths.add(path);

    if (file.deleted === true) return { path, deleted: true };
    if (typeof file.content !== "string") {
      throw new HttpError(400, `files[${index}].content must be a string unless deleted is true`);
    }
    const byteLength = new TextEncoder().encode(file.content).byteLength;
    if (byteLength > MAX_FILE_BYTES) {
      throw new HttpError(413, `File exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
    }
    return { path, content: file.content, deleted: false };
  });
}

export function isSafeRepositoryPath(path) {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes("//")) return false;
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return false;
  if (segments.some(segment => [".git", ".github"].includes(segment.toLowerCase()))) return false;
  return true;
}

export function normalizeFixBranch(sourceBranch) {
  if (typeof sourceBranch !== "string" || sourceBranch.length === 0 || sourceBranch.length > 240) {
    throw new HttpError(400, "sourceBranch must be a non-empty branch name no longer than 240 characters");
  }
  if (sourceBranch.startsWith("autofix/")) return sourceBranch;
  const safeSuffix = sourceBranch.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  return `autofix/${safeSuffix}`;
}

export function classifyWorkflowRuns(runs) {
  const latestByWorkflow = new Map();
  for (const run of runs) {
    const key = String(run.workflow_id ?? run.name ?? run.id);
    const current = latestByWorkflow.get(key);
    const runTime = Date.parse(run.run_started_at || run.created_at || "") || 0;
    const currentTime = current
      ? Date.parse(current.run_started_at || current.created_at || "") || 0
      : -1;
    if (!current || runTime > currentTime || (runTime === currentTime && (run.run_attempt || 1) > (current.run_attempt || 1))) {
      latestByWorkflow.set(key, run);
    }
  }

  const latestRuns = [...latestByWorkflow.values()];
  if (latestRuns.some(run => ["queued", "in_progress", "requested", "waiting", "pending"].includes(run.status))) {
    return { state: "in_progress", latestRuns };
  }
  const failedRuns = latestRuns.filter(run => ["failure", "timed_out", "action_required"].includes(run.conclusion));
  if (failedRuns.length > 0) return { state: "failure", latestRuns, failedRuns };
  if (latestRuns.length > 0 && latestRuns.every(run => run.conclusion === "success")) {
    return { state: "success", latestRuns };
  }
  return { state: "inconclusive", latestRuns };
}

export async function extractLogTail(zipBytes, maxChars = MAX_LOG_TAIL_CHARS) {
  const bytes = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endRecordOffset = findZipEndRecord(bytes);
  if (endRecordOffset < 0) throw new Error("GitHub log response is not a supported ZIP archive");

  const entryCount = view.getUint16(endRecordOffset + 10, true);
  const centralDirectoryOffset = view.getUint32(endRecordOffset + 16, true);
  if (entryCount > 500 || centralDirectoryOffset >= bytes.byteLength) {
    throw new Error("GitHub log ZIP archive has invalid directory metadata");
  }

  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  const textFiles = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Invalid ZIP central directory entry");
    const flags = view.getUint16(cursor + 8, true);
    const compressionMethod = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const fileNameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const fileNameStart = cursor + 46;
    const fileName = new TextDecoder().decode(bytes.subarray(fileNameStart, fileNameStart + fileNameLength));
    cursor = fileNameStart + fileNameLength + extraLength + commentLength;

    if (!fileName.toLowerCase().endsWith(".txt")) continue;
    if ((flags & 1) !== 0) throw new Error("Encrypted ZIP entries are not supported");
    if (uncompressedSize > MAX_LOG_TEXT_BYTES || totalUncompressedBytes + uncompressedSize > MAX_LOG_TEXT_BYTES) {
      return "GitHub log text exceeds the 4 MiB diagnostic decoding limit.";
    }
    totalUncompressedBytes += uncompressedSize;
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) throw new Error("Invalid ZIP local file header");
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    if (compressed.byteLength !== compressedSize) throw new Error("Truncated ZIP log entry");

    let content;
    if (compressionMethod === 0) {
      content = compressed;
    } else if (compressionMethod === 8) {
      content = await inflateRawBounded(compressed, MAX_LOG_TEXT_BYTES - (totalUncompressedBytes - uncompressedSize));
    } else {
      throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
    }
    if (content.byteLength !== uncompressedSize) throw new Error("ZIP log entry size did not match its directory metadata");
    textFiles.push([fileName, new TextDecoder().decode(content)]);
  }

  if (textFiles.length === 0) return "No readable text log found in GitHub log archive.";
  textFiles.sort(([a], [b]) => a.localeCompare(b));
  const output = textFiles.map(([name, content]) => `===== ${name.replace(/[\r\n]/g, " ")} =====\n${content}`).join("\n");
  return output.slice(-maxChars);
}

async function inflateRawBounded(compressed, maxOutputBytes) {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxOutputBytes) {
        await reader.cancel("Decompressed GitHub logs exceed diagnostic limit");
        throw new Error("Decompressed GitHub logs exceed the 4 MiB diagnostic limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function findZipEndRecord(bytes) {
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
        bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) return offset;
  }
  return -1;
}

function authorizeAndResolveRoute(request, url, capabilitySecret) {
  if (!capabilitySecret || typeof capabilitySecret !== "string") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const pathSecretMatches = segments.length >= 2 && constantTimeEqual(segments[0], capabilitySecret);
  const bearerMatches = constantTimeEqual(bearer, capabilitySecret);
  if (!pathSecretMatches && !bearerMatches) return null;
  const action = pathSecretMatches ? segments[1] : segments[0];
  if (segments.length !== (pathSecretMatches ? 2 : 1)) return null;
  return { action };
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }
  return difference === 0;
}

function parseIntegerInRange(value, min, max, name) {
  if (!/^\d+$/.test(String(value))) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

async function readJsonBody(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body exceeds 1 MiB");
  const text = await readRequestText(request, MAX_REQUEST_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON");
  }
}

async function readRequestText(request, maxBytes) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Request body exceeds size limit");
        throw new HttpError(413, "Request body exceeds 1 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handleDiagnostics(url, config, ghHeaders) {
  const requestedRepo = url.searchParams.get("repo");
  if (requestedRepo && !isRepoAllowed(requestedRepo, config.allowedRepos)) {
    throw new HttpError(400, "Repository not in ALLOWED_REPOS");
  }

  const repos = requestedRepo
    ? [requestedRepo]
    : (config.allowedRepos === "*"
        ? await discoverAccessibleRepos(ghHeaders)
        : config.allowedRepos);

  if (repos.length === 0) {
    throw new HttpError(400, config.allowedRepos === "*"
      ? "No accessible repositories found for GitHub token"
      : "ALLOWED_REPOS is empty; configure at least one repository");
  }

  const reports = [];
  for (const repo of repos) {
    reports.push(await inspectRepository(repo, ghHeaders, config));
  }

  return jsonResponse({ timestamp: new Date().toISOString(), reports });
}

export async function discoverAccessibleRepos(headers, maxRepos = 100, pageSize = Math.min(100, maxRepos)) {
  const repos = [];
  let page = 1;
  while (repos.length < maxRepos) {
    const data = await ghFetch(
      `${GITHUB_API}/user/repos?per_page=${pageSize}&page=${page}&sort=updated`,
      headers
    );
    if (!Array.isArray(data) || data.length === 0) break;
    for (const item of data) {
      if (item.full_name && !item.archived && !item.disabled) {
        repos.push(item.full_name);
        if (repos.length >= maxRepos) break;
      }
    }
    if (data.length < pageSize) break;
    page += 1;
  }
  return repos;
}

async function healthCheck(config, headers) {
  const [user, rateLimit] = await fetchGitHubIdentity(headers);
  const targetRepos = config.allowedRepos === "*"
    ? await discoverAccessibleRepos(headers)
    : config.allowedRepos;

  const repositoryReports = [];
  for (const repo of targetRepos) {
    repositoryReports.push(await checkRepositoryAccess(repo, headers));
  }

  const repositoriesHealthy = repositoryReports.every(report => report.status === "ok");
  return jsonResponse({
    status: repositoriesHealthy ? "ok" : "degraded",
    githubAuthentication: "ok",
    githubUser: user.login,
    allowedRepos: config.allowedRepos,
    discoveredRepos: config.allowedRepos === "*" ? targetRepos : undefined,
    repositoryAccess: repositoryReports,
    prTargetMode: config.prTargetMode,
    maxBotCommitsPerBranch: config.maxBotCommits,
    githubRateLimitRemaining: rateLimit.rate?.remaining ?? null,
    warning: healthCheckWarning(config.allowedRepos, targetRepos)
  }, repositoriesHealthy ? 200 : 207);
}

async function fetchGitHubIdentity(headers) {
  try {
    return await Promise.all([
      ghFetch(`${GITHUB_API}/user`, headers),
      ghFetch(`${GITHUB_API}/rate_limit`, headers)
    ]);
  } catch (error) {
    throw new HttpError(502, `GitHub authentication check failed: ${safeErrorMessage(error)}`);
  }
}

function healthCheckWarning(allowedRepos, targetRepos) {
  if (allowedRepos !== "*" && allowedRepos.length === 0) {
    return "ALLOWED_REPOS is empty; diagnostics and apply-fix are disabled until it is configured.";
  }
  if (allowedRepos === "*" && targetRepos.length === 0) {
    return "No accessible repositories found for the GitHub token.";
  }
  return "Push permission is reported for the linked GitHub user; GitHub does not expose fine-grained token write grants through this read-only health check.";
}

async function checkRepositoryAccess(repo, headers) {
  const encoded = encodeRepo(repo);
  try {
    const metadata = await ghFetch(`${GITHUB_API}/repos/${encoded}`, headers);
    const [contents, actions, pullRequests] = await Promise.all([
      ghFetch(`${GITHUB_API}/repos/${encoded}/git/ref/heads/${encodeURIComponent(metadata.default_branch)}`, headers),
      ghFetch(`${GITHUB_API}/repos/${encoded}/actions/runs?per_page=1`, headers),
      ghFetch(`${GITHUB_API}/repos/${encoded}/pulls?state=open&per_page=1`, headers)
    ]);
    return {
      repo,
      status: "ok",
      contentsRead: contents.object?.sha ? "ok" : "unknown",
      actionsRead: "ok",
      pullRequestsRead: "ok",
      accountPushPermission: metadata.permissions?.push ?? null,
      defaultBranch: metadata.default_branch,
      workflowRunsVisible: actions.total_count ?? null,
      openPullRequestsVisible: Array.isArray(pullRequests) ? pullRequests.length : null
    };
  } catch (error) {
    return { repo, status: "error", error: safeErrorMessage(error) };
  }
}

async function inspectRepository(repo, headers, config) {
  const encoded = encodeRepo(repo);
  const [repoData, openPRs] = await Promise.all([
    ghFetch(`${GITHUB_API}/repos/${encoded}`, headers),
    ghFetch(`${GITHUB_API}/repos/${encoded}/pulls?state=open&per_page=100`, headers)
  ]);
  const defaultBranch = repoData.default_branch;
  const targetsByBranch = new Map();
  const defaultRef = await ghFetch(`${GITHUB_API}/repos/${encoded}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, headers);
  targetsByBranch.set(defaultBranch, {
    branch: defaultBranch,
    headSha: defaultRef.object.sha,
    isDefaultBranch: true,
    isAutofixBranch: false,
    prNumber: null,
    baseBranch: defaultBranch
  });

  for (const pr of openPRs) {
    if (pr.head.repo?.full_name !== repo || !pr.head.ref || !pr.head.sha) continue;
    targetsByBranch.set(pr.head.ref, {
      branch: pr.head.ref,
      headSha: pr.head.sha,
      isDefaultBranch: false,
      isAutofixBranch: pr.head.ref.startsWith("autofix/"),
      prNumber: pr.number,
      baseBranch: pr.base.ref
    });
  }

  const targets = [...targetsByBranch.values()].slice(0, config.maxTargets);
  const actionableFailures = [];
  const inProgressBranches = [];
  const greenBranches = [];
  const inconclusiveBranches = [];

  for (const target of targets) {
    const expectedFixBranch = normalizeFixBranch(target.branch);
    const existingAutofixPR = !target.isAutofixBranch
      ? openPRs.find(pr => pr.head.repo?.full_name === repo && pr.head.ref === expectedFixBranch) || null
      : null;
    const runsResponse = await ghFetch(
      `${GITHUB_API}/repos/${encoded}/actions/runs?head_sha=${encodeURIComponent(target.headSha)}&per_page=100`,
      headers
    );
    const classification = classifyWorkflowRuns(runsResponse.workflow_runs || []);
    if (classification.latestRuns.length === 0) continue;

    if (classification.state === "in_progress") {
      inProgressBranches.push({ branch: target.branch, headSha: target.headSha, prNumber: target.prNumber });
      continue;
    }
    if (classification.state === "success") {
      greenBranches.push({ branch: target.branch, headSha: target.headSha, prNumber: target.prNumber });
      continue;
    }
    if (classification.state === "inconclusive") {
      inconclusiveBranches.push({
        branch: target.branch,
        headSha: target.headSha,
        prNumber: target.prNumber,
        conclusions: classification.latestRuns.map(run => run.conclusion)
      });
      continue;
    }
    if (existingAutofixPR) continue;

    const primaryFailedRun = classification.failedRuns[0];
    const jobsResponse = await ghFetch(
      `${GITHUB_API}/repos/${encoded}/actions/runs/${primaryFailedRun.id}/jobs?per_page=100`,
      headers
    );
    const failedJob = (jobsResponse.jobs || []).find(job => ["failure", "timed_out", "action_required"].includes(job.conclusion));
    const logTail = failedJob
      ? await fetchJobLogTail(repo, failedJob.id, headers)
      : "No failed job details available.";

    actionableFailures.push({
      ...target,
      failedWorkflowName: primaryFailedRun.name || primaryFailedRun.display_title || "unknown",
      failedJobName: failedJob?.name || "unknown",
      failedSteps: failedJob?.steps?.filter(step => step.conclusion === "failure").map(step => step.name) || [],
      runUrl: primaryFailedRun.html_url,
      logTail
    });
  }

  actionableFailures.sort((a, b) => {
    if (a.isAutofixBranch !== b.isAutofixBranch) return a.isAutofixBranch ? -1 : 1;
    if (a.isDefaultBranch !== b.isDefaultBranch) return a.isDefaultBranch ? -1 : 1;
    return 0;
  });

  return {
    repo,
    defaultBranch,
    truncatedTargets: targetsByBranch.size > config.maxTargets,
    greenBranches,
    inProgressBranches,
    inconclusiveBranches,
    actionableFailures
  };
}

async function fetchJobLogTail(repo, jobId, headers) {
  const encoded = encodeRepo(repo);
  try {
    const response = await fetch(`${GITHUB_API}/repos/${encoded}/actions/jobs/${jobId}/logs`, {
      headers,
      redirect: "follow"
    });
    if (!response.ok) return `GitHub log download failed with HTTP ${response.status}.`;
    const bytes = await readResponseBytes(response, MAX_LOG_ARCHIVE_BYTES);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) return await extractLogTail(bytes);
    return new TextDecoder().decode(bytes).slice(-MAX_LOG_TAIL_CHARS);
  } catch (error) {
    return `Unable to retrieve job logs: ${safeErrorMessage(error)}`;
  }
}


async function readResponseBytes(response, maxBytes) {
  const announcedLength = Number(response.headers.get("content-length") || 0);
  if (announcedLength > maxBytes) throw new Error(`GitHub log archive exceeded the ${maxBytes}-byte download limit`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("GitHub log archive exceeded diagnostic download limit");
        throw new Error(`GitHub log archive exceeded the ${maxBytes}-byte download limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function applyFix(body, config, headers) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  const { repo, sourceBranch, originalBaseBranch, commitMessage } = body;
  if (!isRepoAllowed(repo, config.allowedRepos)) {
    throw new HttpError(400, "Repository not in ALLOWED_REPOS");
  }
  if (typeof sourceBranch !== "string" || sourceBranch.length === 0) {
    throw new HttpError(400, "Missing sourceBranch");
  }
  const files = validateFixFiles(body.files);
  if (commitMessage !== undefined && (typeof commitMessage !== "string" || commitMessage.length > 200)) {
    throw new HttpError(400, "commitMessage must be a string no longer than 200 characters");
  }

  const fixBranch = normalizeFixBranch(sourceBranch);
  const encoded = encodeRepo(repo);
  const repoData = await ghFetch(`${GITHUB_API}/repos/${encoded}`, headers);
  const defaultBranch = repoData.default_branch;
  const sourceRef = await ghFetch(
    `${GITHUB_API}/repos/${encoded}/git/ref/heads/${encodeURIComponent(sourceBranch)}`,
    headers
  );
  let parentCommitSha = sourceRef.object.sha;

  const existingRef = await ghFetchOptional(
    `${GITHUB_API}/repos/${encoded}/git/ref/heads/${encodeURIComponent(fixBranch)}`,
    headers
  );
  const fixBranchExists = Boolean(existingRef);
  if (existingRef) {
    parentCommitSha = existingRef.object.sha;
    const recentCommits = await ghFetch(
      `${GITHUB_API}/repos/${encoded}/commits?sha=${encodeURIComponent(fixBranch)}&per_page=${config.maxBotCommits}`,
      headers
    );
    const consecutiveBotCommits = countConsecutiveBotCommits(recentCommits);
    if (consecutiveBotCommits >= config.maxBotCommits) {
      throw new HttpError(429,
        `Circuit breaker: ${fixBranch} reached ${consecutiveBotCommits} consecutive automated commits.`);
    }
  }

  const existingPRs = await ghFetch(
    `${GITHUB_API}/repos/${encoded}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${fixBranch}`)}&per_page=100`,
    headers
  );
  let prUrl = existingPRs[0]?.html_url || null;
  let prBase = existingPRs[0]?.base?.ref || null;

  if (!prUrl) {
    if (sourceBranch === defaultBranch) {
      prBase = defaultBranch;
    } else if (config.prTargetMode === "original_base") {
      prBase = originalBaseBranch || defaultBranch;
    } else {
      prBase = sourceBranch;
    }
    if (typeof prBase !== "string" || prBase.length === 0 || prBase.startsWith("autofix/")) {
      throw new HttpError(400, "Invalid pull request base branch");
    }
    await ghFetch(
      `${GITHUB_API}/repos/${encoded}/git/ref/heads/${encodeURIComponent(prBase)}`,
      headers
    );
    if (prBase === fixBranch) throw new HttpError(400, "Pull request base cannot equal the autofix branch");
  }

  const baseCommit = await ghFetch(`${GITHUB_API}/repos/${encoded}/git/commits/${parentCommitSha}`, headers);
  const treeItems = files.map(file => file.deleted
    ? { path: file.path, sha: null }
    : { path: file.path, mode: "100644", type: "blob", content: file.content });
  const newTree = await ghFetch(`${GITHUB_API}/repos/${encoded}/git/trees`, headers, "POST", {
    base_tree: baseCommit.tree.sha,
    tree: treeItems
  });
  const normalizedMessage = (commitMessage || "Resolve pipeline failure")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim() || "Resolve pipeline failure";
  const formattedMessage = normalizedMessage.startsWith("[autofix]")
    ? normalizedMessage
    : `[autofix] ${normalizedMessage}`;
  const newCommit = await ghFetch(`${GITHUB_API}/repos/${encoded}/git/commits`, headers, "POST", {
    message: formattedMessage,
    tree: newTree.sha,
    parents: [parentCommitSha]
  });

  if (!fixBranchExists) {
    await ghFetch(`${GITHUB_API}/repos/${encoded}/git/refs`, headers, "POST", {
      ref: `refs/heads/${fixBranch}`,
      sha: newCommit.sha
    });
  } else {
    await ghFetch(
      `${GITHUB_API}/repos/${encoded}/git/refs/heads/${encodeURIComponent(fixBranch)}`,
      headers,
      "PATCH",
      { sha: newCommit.sha, force: false }
    );
  }

  if (!prUrl) {
    const createdPR = await ghFetch(`${GITHUB_API}/repos/${encoded}/pulls`, headers, "POST", {
      title: `fix(ci): automated pipeline repair for ${sourceBranch}`,
      head: fixBranch,
      base: prBase,
      body: [
        "### Automated CI/CD Pipeline Repair",
        `- **Source branch:** \`${sourceBranch}\``,
        `- **Target base branch:** \`${prBase}\``,
        `- **Fix commit:** \`${newCommit.sha}\` (${formattedMessage})`,
        "",
        "This pull request was opened by the Z.ai CI bridge. Review every change before merging."
      ].join("\n")
    });
    prUrl = createdPR.html_url;
  }

  return {
    status: "success",
    repo,
    sourceBranch,
    fixBranch,
    baseBranch: prBase,
    commitSha: newCommit.sha,
    pullRequestUrl: prUrl
  };
}

function countConsecutiveBotCommits(commits) {
  let count = 0;
  for (const commit of commits) {
    if (!commit.commit?.message?.startsWith("[autofix]")) break;
    count += 1;
  }
  return count;
}

function encodeRepo(repo) {
  const [owner, name] = repo.split("/");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

async function ghFetch(url, headers, method = "GET", body = null) {
  const response = await fetch(url, {
    method,
    headers: body ? { ...headers, "Content-Type": "application/json" } : headers,
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 1200);
    throw new GitHubApiError(response.status, `GitHub ${method} ${response.status}: ${responseText}`);
  }
  return response.json();
}

async function ghFetchOptional(url, headers) {
  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    const responseText = (await response.text()).slice(0, 1200);
    throw new GitHubApiError(response.status, `GitHub GET ${response.status}: ${responseText}`);
  }
  return response.json();
}

function safeErrorMessage(error) {
  if (error instanceof GitHubApiError) return error.message;
  if (error instanceof HttpError) return error.message;
  return error?.message || "Unexpected server error";
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}
