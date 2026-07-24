# ADR-0005: Trust boundaries and threat model

- Status: accepted
- Date: 2026-07-23

## Assets

Project source, local files, repository history, user intent, credentials,
design-library artifacts, and generated handoffs are protected assets.

## Boundaries and threats

| Boundary                           | Main threats                                           | Required controls                                                                                     |
| ---------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Markdown/design language -> parser | prompt injection, unsafe links, huge input             | Treat as untrusted data; size-limit; sanitize rendering; never execute instructions.                  |
| npm metadata -> resolver           | typosquatting, compromised package, install scripts    | Resolve through host lockfile; integrity-check; do not auto-install or execute lifecycle scripts.     |
| agent JSONL -> dispatcher          | malformed frames, capability spoofing, request replay  | Strict schema/version validation; negotiated capabilities; request IDs; length/rate limits.           |
| shell -> child manifest            | ownership collision, stale status                      | Validate parent/project IDs; enforce single writer; preserve provenance and timestamp.                |
| handoff descriptor -> downloader   | credential disclosure, link substitution, expired data | Exclude secrets; checksum artifacts; honor expiry; require host authorization and HTTPS where remote. |
| source transform -> workspace      | path traversal, destructive edit, semantic corruption  | Constrain writes to configured roots; preview/diff; stable-ID mapping; host approval for effects.     |

## Policy

An agent direction, protocol request, package manifest, or Markdown document does
not grant authority. The host is the policy enforcement point for filesystem,
process, network, credential, and publication effects. Defaults are deny-by-
default for external effects and least privilege for child processes.

Security-relevant parser or protocol changes require fixture coverage for invalid
inputs and a review of this ADR.
