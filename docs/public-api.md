# Public API inventory and compatibility policy

Selene is a monorepo, but only documented package exports and host entrypoints
are supported integration surfaces. Files below `src/` that are not reachable
from a package export map are internal implementation details.

## Package exports

| Package                    | Public surface                                                               | Internal boundary                                                  |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@selene/agent-sdk`        | `.` protocol envelopes, session negotiation, adapters                        | JSONL framing implementation and test fixtures                     |
| `@selene/collaboration`    | `.`, `./service`, `./history`, `./postgres`                                  | in-memory maps, SQL statements, HTTP routing helpers               |
| `@selene/config`           | `.` shared configuration contracts                                           | package-local normalization helpers                                |
| `@selene/core`             | `.` workspace, federation, generation, baseline, and handoff domain APIs     | command reducers and validation helpers not exported from the root |
| `@selene/design-inputs`    | `.` data-only resolver and SHA-256 integrity ports, async ingestion contract | package metadata and Markdown parsing helpers                      |
| `@selene/extension-kernel` | `.` extension planning, validation, and host ports                           | resolver and configuration implementation details                  |
| `@selene/project-schema`   | `.` Zod schemas and inferred portable types                                  | schema composition helpers                                         |
| `@selene/ui`               | `.` React workspace components and styles                                    | story fixtures and component-local state                           |

All package code remains domain-level: it must not import Electron, Node,
database clients, transports, or concrete provider adapters. The repository
architecture test enforces this boundary across every package source file.

## Host APIs

| Host                  | Supported entrypoint                                                 | Compatibility commitment                                                          |
| --------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Web                   | `apps/web/src/main.tsx`                                              | Browser host only; it consumes package APIs and does not define domain contracts. |
| Desktop               | `apps/desktop/src/main/index.ts` and preload API                     | Electron-specific bridge; changes require desktop integration coverage.           |
| Collaboration service | `apps/collaboration-service/src/index.ts` and documented HTTP routes | Fetch-compatible HTTP host with a discriminated memory/PostgreSQL environment.    |
| Migrations            | `apps/collaboration-service/src/migrate.ts`                          | Ordered, forward-only migrations; applied migration files are never edited.       |

## Compatibility policy

- Additive exports and optional, versioned wire fields are backward compatible.
- Removal, renaming, or semantic changes to a documented export require a new
  major package version (or a coordinated pre-1.0 migration note while all
  packages remain private).
- Portable wire/read models must carry their own format discriminant. Parsers
  accept `unknown`, validate before casting into a public type, and reject
  unsupported versions or illegal state combinations.
- `selene-collaboration/v1` snapshots may omit `designReviewState` for
  pre-baseline exports. When present, it must be
  `selene-design-review-state/v1` and pass full nested validation.
- Repository ports are behavioral contracts. In-memory and PostgreSQL adapters
  must return the same result variants and error categories for the same
  commands; adapter-specific connection behavior stays outside the domain API.
- `DesignInputIntegrityPort` is a required host capability. Its asynchronous
  `sha256` result must be lowercase 64-hex; all failures are normalized to
  `DesignInputValidationError` before public design context is returned.
