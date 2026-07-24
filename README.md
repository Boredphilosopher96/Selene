# Selene

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Selene is a Bun workspace for a web application and an Electron desktop shell that share
typed packages. Product requirements and domain design are intentionally not defined here.

## Workspace

- `apps/web` — React and Vite web application.
- `apps/desktop` — Electron application using React and Vite.
- `packages/core` — product-neutral domain primitives.
- `packages/agent-sdk` — typed boundary for agent integrations.
- `packages/project-schema` — runtime project-shape validation.
- `packages/ui` — shared React components and Storybook stories.
- `packages/config` — shared configuration exports.

## Development

Requires Bun 1.3.14 or newer.

```sh
bun install --frozen-lockfile
bun run dev:web
```

Run the verification suite with `bun run format`, `bun run lint`, `bun run typecheck`,
`bun run test`, `bun run build`, and `bun run build-storybook`. Browser smoke tests require
the Playwright Chromium binary: `bunx playwright install chromium`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and
[SECURITY.md](SECURITY.md) for vulnerability reporting.

For the JSONL adapter contract, local Electron host policy, and deterministic
test adapter, see [the agent SDK guide](docs/agent-sdk.md).
