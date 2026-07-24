# Public API inventory and compatibility policy

Selene is a monorepo, but only documented package exports and host entrypoints
are supported integration surfaces. Files below `src/` that are not reachable
from a package export map are internal implementation details.

## Package exports

| Package                    | Public surface                                                                                                         | Internal boundary                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `@selene/agent-sdk`        | `.` protocol envelopes, session negotiation, adapters                                                                  | JSONL framing implementation and test fixtures                     |
| `@selene/collaboration`    | `.`, `./service`, `./history`, `./postgres`                                                                            | in-memory maps, SQL statements, HTTP routing helpers               |
| `@selene/config`           | `.` shared configuration contracts                                                                                     | package-local normalization helpers                                |
| `@selene/core`             | `.` workspace, prototype graph/runtime, federation, generation, baseline, handoff, and enterprise-governance contracts | command reducers and validation helpers not exported from the root |
| `@selene/design-inputs`    | `.` data-only resolver and SHA-256 integrity ports, async ingestion contract                                           | package metadata and Markdown parsing helpers                      |
| `@selene/extension-kernel` | `.` extension planning, validation, and host ports                                                                     | resolver and configuration implementation details                  |
| `@selene/project-schema`   | `.` Zod schemas and inferred portable types                                                                            | schema composition helpers                                         |
| `@selene/ui`               | `.` foundation primitives; `./workspace` commercial workspace; `./prototype` graph/runtime and example screens         | Storybook modules and component-local state                        |

All package code remains domain-level: it must not import Electron, Node,
database clients, transports, or concrete provider adapters. The repository
architecture test enforces this boundary across every package source file.

## Enterprise governance API

`@selene/core` exposes `selene-enterprise-security/v2`: small, provider-neutral
contracts for external governance. Local OSS callers use `allowLocalAccess()`;
it has no account, license, entitlement, IP, or external-control-plane check.
External hosts compile policy once with `compileEnterprisePolicy`, then call
`evaluateExternalAccess` with a host-trusted session, signed entitlement verifier,
and durable `RevisionStore`. A store key includes tenant, provider, audience,
subject, and resource. It must atomically retain the high-water revision and
revocation state; the exported in-memory store is a fail-closed test fixture,
never a production persistence recommendation.
Production providers are not invoked by the portable package directly: a
trusted host adapter composes their provider-neutral ports with the shared
`@selene/host-runtime` supervisor for descriptor capture, admission,
cancellation, settlement quarantine, recovery, and redacted errors.
Signed-policy activation additionally requires the verifier to return the
lowercase SHA-256 digest of the bytes it verified. The durable policy store binds
that digest, revision, and expiry, so a same-revision substitution or revoked
digest cannot reactivate a policy.

All strings, collections, timestamps, and events are runtime-validated and
bounded. Timestamps are canonical millisecond UTC instants. Inputs and public
results are copied/frozen where they cross the contract boundary. External
capability names are extensible but namespaced (for example,
`selene:workspace.read`). Verifier failures and store contention fail closed.

`ManagedKeyPort` deliberately exposes only opaque key references plus
encrypt/decrypt or authorization operations—not raw key material. DLP matching
lives behind the bounded `DlpScannerPort`; the core does not compile caller
regexes. `SiemOutboxPort` requires atomic claim/ack/nack/dead-letter lifecycle
operations; the in-memory self-host adapter preserves events enqueued during a
delivery and rejects duplicate IDs or capacity overflow. Retention respects legal
holds, and break-glass activation requires a versioned pending request, audit ID,
two distinct non-requester approvers with verified request-bound evidence, expiry
bound, and atomic replay-and-audit consumption.

## UI foundation API

`@selene/ui` exposes a deliberately small, additive foundation for screens owned
by other workstreams. The commercial `DesignerWorkspace` is available only from
`@selene/ui/workspace`, while executable graph/runtime views are available from
`@selene/ui/prototype`. Primitive consumers therefore load neither product
surface. Storybook modules are source-only catalog entries and are excluded from
the published runtime.

| Export                 | Public props                                                                                           | Accessibility contract                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `Button`               | `children`, native button attributes including `className` and typed `ref`, `variant`, `loading`       | Native button; loading disables activation and exposes `aria-busy`.                 |
| `IconButton`           | required `label`, required `icon`, native button attributes including `className` and typed `ref`      | Native button; `label` provides its accessible name.                                |
| `TextField`            | required `label`, native input attributes including `className` and typed `ref`, `hint`, `error`, `id` | Connects visible label, hint, and error text through native and ARIA semantics.     |
| `StatusBadge`          | `children`, normal span attributes including `className` and typed `ref`, optional `tone`              | Non-interactive text status; it never conveys the state by color alone.             |
| `Card`                 | `children`, optional `as`, native element attributes including `className` and typed `ref`             | A styling container only; callers choose any needed landmark and heading semantics. |
| `AddIcon`, `CloseIcon` | optional SVG attributes and `title`                                                                    | Decorative by default; a supplied `title` makes the SVG an image.                   |

Foundation tokens are local to `.sl-theme` or a primitive root, so importing
the package does not theme a host page. `.sl-theme[data-theme='dark']` exposes
the dark token set; `.sl-theme[data-contrast='more']` and `forced-colors: active`
use system colors. Reduced-motion rules are likewise scoped to Selene primitives.

`bun run audit:ui` combines the TypeScript package typecheck, compiler-checked
public primitive contract test, package export contract, dependency review, and
the 32 KiB primitive-root runtime cap. It also bundles a real primitive-only browser
consumer and proves that its output excludes both optional workspace and
prototype surfaces. The prior emitted-export scan was removed: a build-shape
regex is not treated as semantic API proof. The code-native icons intentionally
avoid adding an icon-library dependency.

The dependency audit permits only `react` and the headless `@selene/core`
runtime. Prototype UI imports its graph contracts from core; any other runtime
dependency is rejected until the allowlist and this public inventory are
reviewed together.

## Host APIs

| Host                  | Supported entrypoint                                                          | Compatibility commitment                                                               |
| --------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Web                   | `apps/web/src/main.tsx`                                                       | Browser host only; it consumes package APIs and does not define domain contracts.      |
| Desktop               | `apps/desktop/src/main/index.ts` and `selene-desktop-designer/v2` preload API | Electron-specific bridge; incompatible renderers fail before invoking host operations. |
| Collaboration service | `apps/collaboration-service/src/index.ts` and documented HTTP routes          | Fetch-compatible HTTP host with a discriminated memory/PostgreSQL environment.         |
| Migrations            | `apps/collaboration-service/src/migrate.ts`                                   | Ordered, forward-only migrations; applied migration files are never edited.            |

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
