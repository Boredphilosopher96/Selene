# Selene

[![Selene CI](https://github.com/Boredphilosopher96/Selene/actions/workflows/ci.yml/badge.svg)](https://github.com/Boredphilosopher96/Selene/actions/workflows/ci.yml)
[![Selene security](https://github.com/Boredphilosopher96/Selene/actions/workflows/security.yml/badge.svg)](https://github.com/Boredphilosopher96/Selene/actions/workflows/security.yml)
[![Selene Pages](https://github.com/Boredphilosopher96/Selene/actions/workflows/pages.yml/badge.svg)](https://github.com/Boredphilosopher96/Selene/actions/workflows/pages.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Runtime: Bun 1.3.14](https://img.shields.io/badge/runtime-Bun%201.3.14-fbf0df)

Selene is an open-source, local-first workspace for turning design intent into
reviewable React source. It is aimed at designers and product teams that want a
visual, conversational workflow without coupling their projects to one coding
agent, model vendor, hosted service, or proprietary design format.

> Selene is pre-alpha. The repository contains the production foundation,
> portable contracts, provider-neutral agent SDK, and federated project model;
> the full designer workspace is under active development.

## What Selene is building

- A designer-oriented Electron workspace with conversation, React preview,
  simulated states and navigation, node-level comments, and developer directions.
- Real React source as the design artifact—not an HTML-only mockup.
- A versioned adapter protocol so local or custom coding agents can connect
  without leaking provider concerns into the core.
- Portable shell and child-project manifests for independently owned areas such
  as Orders and Customer Service.
- npm design-system and Markdown design-language inputs with explicit provenance.
- Automatic generated-design changelogs: marking a design ready for review or
  handoff creates an immutable baseline; later design changes identify affected
  screens, scenarios, components, and stable nodes and make prior review status
  visibly stale until the team explicitly reviews again.
- Aggregated baseline status, Storybook, deployment, and handoff metadata across
  independently owned product projects.
- Static review deployments for GitHub Pages plus an optional collaboration
  service for threaded node/scenario comments, guest review links, approvals,
  audit events, and reconnectable updates. Local work does not require an
  account, database, or backend.

## Architecture

Selene keeps domain policy separate from runtimes and integrations:

- `apps/desktop` — Electron main, preload, and React/Vite renderer.
- `apps/web` — static React/Vite review application.
- `apps/collaboration-service` — optional Bun/PostgreSQL team review service.
- `packages/core` — deterministic, headless domain operations.
- `packages/agent-sdk` — provider-neutral protocol, negotiation, and test adapter.
- `packages/collaboration` — comments, approvals, sharing, sync, and storage ports.
- `packages/design-inputs` — validated, provenance-preserving design-library inputs.
- `packages/extension-kernel` — deterministic versioned extension manifests and host-port planning.
- `packages/project-schema` — portable project and federation contracts.
- `packages/ui` — shared React components and Storybook.
- `packages/config` — shared configuration exports.
- `schemas` — versioned wire and federation schemas with fixtures.
- `examples` — adapter and federated-project examples.

The core does not launch processes, access the filesystem or network, depend on
Electron, or know about agent vendors. Those capabilities live behind explicit
ports and host adapters.

Read the [architecture decisions](docs/architecture/README.md),
[public API and compatibility policy](docs/public-api.md),
[agent SDK guide](docs/agent-sdk.md), and
[extension kernel guide](docs/extensions.md),
[collaboration guide](docs/collaboration.md), and
[federation guide](docs/federation.md) for the binding contracts.

## Quick start

Requires [Bun](https://bun.sh/) 1.3.14 or newer.

```sh
git clone https://github.com/Boredphilosopher96/Selene.git
cd Selene
bun install --frozen-lockfile
bun run dev:web
```

Start the Electron workspace with `bun run dev:desktop` and Storybook with
`bun run storybook`.

## Verification

```sh
bun run format
bun run lint
bun run typecheck
bun run test
bun run build
bun run build-storybook
bun run check:emitted-size
bunx playwright install chromium
bun run test:e2e
bun run test:startup
bun run test:a11y
```

`test:a11y` runs axe-core 4.12.1 against the browser prototype, the shared-component
Storybook iframe (including loading, empty, error, and success scenarios), and the built
Electron renderer independently. It also proves the prototype's primary review path works
using only the keyboard, checks the visible focus treatment at each step, and observes the
polite status live region after its resulting actions. The renderer is served from its
production output, so the check does not require a native display server.
`test:startup` serves the production browser output and uses Resource Timing, not elapsed
wall-clock time, to limit startup to two same-origin JavaScript requests and 300 KiB of
JavaScript transfer. This is a deterministic runtime budget: it catches an added startup
chunk or transferred JavaScript growth without depending on runner speed.
`check:emitted-size` enforces separate uncompressed budgets for those same emitted
surfaces: 350 KiB for the browser prototype, 8,000 KiB for Storybook, and 800 KiB for the
Electron renderer. The gates intentionally measure emitted files rather than source
modules so dependency and bundler changes cannot silently expand a shipped surface.

Pull requests run the same quality gates plus dependency review, CodeQL, license checks,
and SBOM generation without repository secrets.

## Releases and deployment

Changesets provide versioning and release notes for Selene's own source
packages. They are separate from the product's generated-design changelog,
which tracks changes after a design is marked ready for review or handoff.
Release preparation is an intentional manual workflow: it can prepare a version
pull request and build unsigned Electron artifacts for Linux, macOS, and
Windows, but it does not publish packages or create a GitHub Release
automatically.

GitHub Pages assembles the public landing page, web demo, Storybook, and
architecture documentation. See [deployment](docs/DEPLOYMENT.md) and
[release operations](docs/RELEASES.md) for details.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and
[SUPPORT.md](SUPPORT.md) to participate. Report vulnerabilities through the
private process in [SECURITY.md](SECURITY.md), not a public issue.

## License

Selene is available under the [MIT License](LICENSE).
