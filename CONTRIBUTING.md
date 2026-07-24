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
`PostgreSQL 17 persistence`, and `CodeQL` checks are expected before merge. Contributors do not
use the emergency bypass; it is limited to documented maintainer incident response.
