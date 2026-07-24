# Contributing

Use Bun 1.3.14 or newer. Discuss compatibility-sensitive public API or schema changes in
an issue before implementation, and include migration notes for accepted breaking changes.

Before opening a change, run:

```sh
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
```

Add a changeset when a published package changes. Keep commits focused and include tests for
behavioral changes. Pull requests are reviewed under [the governance policy](GOVERNANCE.md):
maintainer approval, CODEOWNERS review, resolved conversations, and the required `Verify`,
`PostgreSQL 17 persistence`, `CodeQL`, and `Dependency review` checks are expected before merge.
New pushes dismiss stale approvals and required checks must be current for the exact head.
Contributors do not use the emergency bypass; it is limited to documented maintainer incident
response. Commit signatures are not currently required; the documented provenance path is the
GitHub-authenticated reviewed pull request, exact-SHA hosted checks, release attestations, and
CycloneDX SBOM.
