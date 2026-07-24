# Contributing

Use Bun 1.3.14 or newer. Keep product behavior and schema semantics out of this repository
until the owning design work is available.

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
