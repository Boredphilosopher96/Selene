# ADR-0001: Local-first headless core

- Status: accepted
- Date: 2026-07-23

## Context

Design exploration must work on a laptop, in CI, and in a host application
with different storage and rendering choices. Requiring a service or an agent
provider would make the core harder to embed, test, and trust.

## Decision

The Selene core is a headless, local-first library. It operates only on explicit
project inputs and returns explicit outputs. Persistence, networking, rendering,
authentication, and agent execution are adapter concerns. A core invocation is
expected to be reproducible from a project snapshot, simulator inputs, and the
selected schema/protocol versions.

Selene has **no built-in agent API** and **no required backend**. A host may
connect any agent, local process, remote service, or no agent at all through the
portable protocol in ADR-0003. The core must not import provider SDKs, send
telemetry, or open network connections as part of ordinary project operations.

## Consequences

- Core tests can run without credentials, a browser, or a network.
- Hosts choose storage, synchronization, auth, and UI policy.
- Features that need privileged effects must be represented as requested effects
  and explicitly approved by the host.
- A future React UI, TUI, or native app is a consumer of the same core, not the
  architectural center.
