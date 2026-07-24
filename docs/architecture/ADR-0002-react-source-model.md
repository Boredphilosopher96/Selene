# ADR-0002: React-source project model and simulation

- Status: accepted
- Date: 2026-07-23

## Decision

The canonical project model is React source plus Selene metadata. React source
is preserved as source, not lowered into a lossy visual document. Selene metadata
may identify component roots, props, routes, comments, developer directions,
and simulation fixtures; it never replaces application source ownership.

Every addressable node has a stable `nodeId`. A node ID is a persistent opaque
identifier, not a byte offset, rendered position, generated key, or display
name. Source transformations must preserve IDs when semantic identity is
preserved, carry an explicit old-to-new mapping when identity changes, and never
silently reuse a deleted ID for another node.

The headless simulator accepts a named state and navigation action, then emits a
deterministic snapshot. Simulated states include loading, empty, error, signed
out, and user-defined fixtures. Navigation is a transition log over declared
routes or host-supplied navigation rules; it is not browser automation and does
not fetch live data.

Comments and developer directions attach to stable IDs. Comments are reviewable
annotations. Developer directions are non-executable guidance for people and
agents; they must not be treated as permission to run shell commands, access
secrets, or override host policy.

## Consequences

- Design review can point to stable locations across formatting and rendering
  changes.
- Snapshot tests do not need a browser or production service.
- Consumers must resolve IDs defensively and report stale references rather than
  guessing an attachment target.
