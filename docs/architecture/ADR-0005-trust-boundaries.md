# ADR-0005: Trust boundaries and threat model

- Status: accepted
- Date: 2026-07-23

## Assets

Project source, local files, repository history, user intent, credentials,
design-library artifacts, and generated handoffs are protected assets.

## Boundaries and threats

| Boundary                            | Main threats                                                 | Required controls                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown/design language -> parser  | prompt injection, unsafe links, huge input                   | Treat as untrusted data; size-limit; sanitize rendering; never execute instructions.                                                                |
| npm metadata -> resolver            | typosquatting, compromised package, install scripts          | Resolve through host lockfile; integrity-check; do not auto-install or execute lifecycle scripts.                                                   |
| agent JSONL -> dispatcher           | malformed frames, capability spoofing, request replay        | Strict schema/version validation; negotiated capabilities; request IDs; length/rate limits.                                                         |
| shell -> child manifest             | ownership collision, stale status                            | Validate parent/project IDs; enforce single writer; preserve provenance and timestamp.                                                              |
| handoff descriptor -> downloader    | credential disclosure, link substitution, expired data       | Exclude secrets; checksum artifacts; honor expiry; require host authorization and HTTPS where remote.                                               |
| source transform -> workspace       | path traversal, destructive edit, semantic corruption        | Constrain writes to configured roots; preview/diff; stable-ID mapping; host approval for effects.                                                   |
| signed policy -> core               | policy substitution, rollback, stale revocation              | Verify the signed payload digest; bind policy revision, digest, and expiry in a durable organization/policy store; deny equivocation or revocation. |
| external entitlement -> core        | stale grant, downgrade, cross-tenant replay, verifier outage | Validate canonical versioned claims; bind tenant/provider/audience/resource; fail closed; use durable atomic revision high-water/revocation state.  |
| host session/IP -> core             | forged evidence, stale session, CIDR bypass                  | Accept only explicit host-trusted evidence; validate bounded canonical timestamps; compile canonical CIDRs once into immutable policy.              |
| content -> DLP scanner              | regex ReDoS, output amplification, watermark injection       | Keep matching in a bounded host scanner port; bound UTF-8 input/output/findings; expose watermark as data, not executable markup.                   |
| security event -> SIEM              | duplicate delivery, lost event, concurrent flush             | Persist atomic claim/ack/nack/dead-letter lifecycle; bound batches and capacity; retain dead-letter evidence.                                       |
| break-glass approval -> core        | forged approver, replay, unaudited emergency access          | Verify two distinct request-bound approvals before atomically consuming the replay key and persisting the activation audit record.                  |
| enterprise provider -> trusted host | timeout bypass, late settlement, mutable provider output     | Capture exact data methods once; use one shared host-effect pool with owned values, cancellation, quarantine, recovery, and redacted errors.        |

## Policy

An agent direction, protocol request, package manifest, or Markdown document does
not grant authority. The host is the policy enforcement point for filesystem,
process, network, credential, and publication effects. Defaults are deny-by-
default for external effects and least privilege for child processes.

Security-relevant parser or protocol changes require fixture coverage for invalid
inputs and a review of this ADR.

Enterprise governance remains an optional external-host policy layer. Local
OSS use does not require an account, license, entitlement service, or network
control plane. Key-management contracts expose opaque references and managed
operations only; raw key material never crosses into the core.
