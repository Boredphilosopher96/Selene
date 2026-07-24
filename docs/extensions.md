# Extension kernel

`@selene/extension-kernel` is Selene's versioned, headless extension-manifest
planner. It accepts data only: it does not import an extension, read a package,
render a preview, launch an agent, or hash an artifact.

## Manifests and policy

Every manifest uses `manifestVersion: "1.0"`, a semantic version, a stable
dotted ID, explicit capabilities and permissions, SHA-256 SRI integrity, and
publisher/source provenance. Supported kinds cover agents, npm design libraries,
React TypeScript templates and generators, validators, exporters, preview
decorators, and policies. The [composed sample set](../examples/extensions/composed)
contains an enterprise policy plus a custom agent, npm design-system/component
library, template, preview decorator, validator, and exporter.

Design-library contributions are typed data: token collections contain tokens,
aliases, and theme/brand/locale/viewport modes; components declare export names,
variants, and slots. Configuration supports a small JSON-schema-like object
shape with typed properties, enums, patterns, minimums, arrays, nested objects,
and explicit additional-property policy.

Hosts supply the policy: allowed permissions, minimum trust, optional publisher
allowlist, and whether integrity is required. Validation fails closed for bad
configuration, missing or incompatible dependencies, conflicts, cycles,
ungranted permissions, and insufficient trust. Exact, `^`, `~`, and comparator
semver ranges are supported. Resolution is lexical and topological, so equal
inputs produce the same extension and lifecycle order.

## Host ports and lifecycle

`createExtensionPlan` is synchronous and pure. `activateExtensionPlan` only
uses host ports to verify each manifest and emit planned lifecycle events.
`ExtensionHostPorts` exposes adapter-shaped, type-only integration points for
`@selene/agent-sdk` and `@selene/design-inputs`; a host chooses how agent
execution, npm retrieval, artifact integrity, preview rendering, and exports
occur. The core never performs those effects.

`createAgentExtensionBridge` provides capability-guarded streaming over an
existing agent SDK adapter. `createDesignInputExtensionBridge` resolves through
the design-input package's shared supervised input boundary and accepts a
host-owned context decoder. The kernel migrates the supported v0.9 `type`
manifest field to v1 `kind`; it rejects all other schema versions.

Lifecycle commands are declarative `install`, `configure`, `activate`, and
`deactivate` events. Their inputs merge with validated configuration and are
emitted in deterministic dependency order. A host may map an approved declared
capability to an agent adapter, input adapter, preview renderer, exporter, or
policy engine; the kernel never executes that mapping itself.

## Security

Integrity must be verified by the host against the resolved artifact, never
self-attested manifest data. Preserve provenance in audit records, apply least
privilege policy, reject untrusted publishers in production, and never interpret
templates, generators, package metadata, or lifecycle inputs as executable code
without a sandboxed host adapter. This extends [ADR-0005](architecture/ADR-0005-trust-boundaries.md).
