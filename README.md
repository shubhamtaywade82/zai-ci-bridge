# Z.ai CI Bridge

A Cloudflare Worker that lets an external coding agent inspect selected GitHub Actions failures and submit proposed fixes as commits on `autofix/*` branches. The bridge **does not merge pull requests**. Every repair remains a pull request for human review.

## Repository layout

```text
zai-ci-bridge/
├── .env.example
├── .gitignore
├── package.json
├── README.md
├── wrangler.toml
├── src/
│   └── index.js
└── test/
    └── index.test.js
```

## Configuration

Edit `ALLOWED_REPOS` in `wrangler.toml` with a comma-separated allowlist of repositories in `owner/name` form. It is intentionally empty in the initial commit; no repository is enabled until you select it.

`NON_DEFAULT_PR_TARGET_MODE` controls the base of newly opened autofix pull requests:

- `original_base`: use `originalBaseBranch` supplied with the repair request, falling back to the monitored repository's default branch.
- `broken_branch`: target the broken source branch itself.

`MAX_BOT_COMMITS_PER_BRANCH` is a circuit breaker. The Worker stops when the most recent commits on an autofix branch contain this many consecutive `[autofix]` commits. `MAX_DIAGNOSTIC_TARGETS` bounds the number of branches scanned per repository.

## GitHub token and secret

Create a **fine-grained personal access token** scoped only to the repositories in `ALLOWED_REPOS`, with:

- Metadata: Read (GitHub requires repository metadata access).
- Actions: Read (workflow runs, jobs, and job logs).
- Contents: Read and write (Git trees, commits, and branch refs).
- Pull requests: Read and write (inspect and open repair PRs).

The Worker does not merge PRs. Do not grant Administration or Actions write permission.

In Cloudflare Dashboard, open the Worker → **Settings → Variables and Secrets** and add these as **Secret** values (not plaintext vars):

- `GITHUB_TOKEN`: the fine-grained GitHub token.
- `CAPABILITY_SECRET`: a random secret generated with `openssl rand -hex 32`.

For local development, copy `.env.example` to `.dev.vars` and set local test credentials. `.dev.vars` is ignored by Git. Never commit real credentials.

## Local development and tests

```bash
npm install
npm test
npm run dev
```

Local Worker routes require both secrets in `.dev.vars`. Test the health endpoint with:

```bash
curl -sS -H "Authorization: Bearer $CAPABILITY_SECRET" \
  http://localhost:8787/health | jq .
```

## Cloudflare Workers Builds deployment

1. Push the repository to GitHub with `main` as the production branch.
2. In Cloudflare Dashboard, open **Workers & Pages → Create application → GitHub**, authorize the Cloudflare GitHub App, select `shubhamtaywade82/zai-ci-bridge`, and choose **Save and Deploy**. For an already-created Worker, use **Settings → Builds → Connect**.
3. Set the production branch to `main`. Set the build command to `npm test` so the unit suite runs before each deployment. Use `npx wrangler deploy` as the deploy command. Workers Builds uses the Wrangler version pinned in `package.json`.
4. Add `GITHUB_TOKEN` and `CAPABILITY_SECRET` in **Settings → Variables and Secrets** as encrypted Secrets, then deploy the Worker.
5. Keep the Worker name in Cloudflare equal to `name = "zai-ci-bridge"` in `wrangler.toml`.

Cloudflare Workers Builds deploys on pushes to the selected production branch. Do not put either secret in `wrangler.toml`, repository variables, source code, or commit history.

## API

All endpoints require the capability secret. A bearer header is preferred because putting a secret in a URL can expose it through request logs, browser history, analytics, and copied links. The legacy `/<CAPABILITY_SECRET>/...` route format is also supported for compatibility with scheduled-task clients.

### `GET /health`

Checks GitHub token authentication and reads repository metadata, Actions runs, and pull requests for each allowed repository. It reports account-level push permission where GitHub exposes it; it cannot prove the token's fine-grained Contents write grant without performing a real write.

```bash
curl -sS -H "Authorization: Bearer $CAPABILITY_SECRET" \
  https://zai-ci-bridge.<your-subdomain>.workers.dev/health | jq .
```

### `GET /diagnostics`

Scans each allowlisted repository's default branch and open pull-request branches, then classifies the latest run per workflow for each exact head SHA. Failed job logs are downloaded as GitHub ZIP archives, decoded, and truncated to a bounded tail.

```bash
curl -sS -H "Authorization: Bearer $CAPABILITY_SECRET" \
  "https://zai-ci-bridge.<your-subdomain>.workers.dev/diagnostics?repo=owner/repo" | jq .
```

### `POST /apply-fix`

Creates or updates an `autofix/*` branch and opens a pull request if one does not already exist. The request is limited to 20 text files, 400 KiB per file, 1 MiB per request, and rejects `.git`, `.github`, absolute paths, traversal segments, duplicate paths, and backslash paths.

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $CAPABILITY_SECRET" \
  -H "Content-Type: application/json" \
  https://zai-ci-bridge.<your-subdomain>.workers.dev/apply-fix \
  -d '{
    "repo": "owner/repo",
    "sourceBranch": "feature/example",
    "originalBaseBranch": "main",
    "commitMessage": "Fix failing test setup",
    "files": [{"path": "src/example.js", "content": "export const ready = true;\\n"}]
  }' | jq .
```

Deletion example: `{ "path": "src/obsolete.js", "deleted": true }`.

## Operational and security boundaries

- The allowlist is checked on every request; a caller cannot target an arbitrary repository.
- GitHub Actions logs and failure details are returned only to an authenticated caller. Treat diagnostic responses as sensitive.
- `.github/**` is blocked so an agent cannot silently alter CI workflows or repository automation through this bridge.
- Branch updates are non-force pushes. Concurrent/stale writes fail rather than rewriting branch history.
- The circuit breaker counts consecutive `[autofix]` commits at the branch head, not merely the number in a sample containing unrelated human commits.
- Cancelled, neutral, skipped, or otherwise non-success conclusions are **inconclusive**, not green.
- Validate and review every agent-proposed diff. Protect `main` with GitHub branch rules and required reviews/checks. The bridge does not bypass branch protection or merge PRs.
- Configure Cloudflare rate limiting or equivalent edge protections for the public Worker URL before exposing it to untrusted callers.

## Known limits

The initial implementation scans the default branch and up to `MAX_DIAGNOSTIC_TARGETS - 1` open-PR branches per repository (first page, up to 100 open PRs). It does not enumerate every inactive branch or create fixes automatically; an external scheduled agent must call `/diagnostics`, reason about the failure, then call `/apply-fix` with a proposed patch.
