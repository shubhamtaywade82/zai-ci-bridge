# Z.ai CI Bridge

A Cloudflare Worker that lets an external coding agent inspect selected GitHub Actions failures and submit proposed fixes as commits on `autofix/*` branches. The bridge **does not merge pull requests**. Every repair remains a pull request for human review.

See the repository README after bootstrap for configuration, token permissions, Cloudflare Workers Builds deployment, API examples, and security boundaries.