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
behavioral changes.
