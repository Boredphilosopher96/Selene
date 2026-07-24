# Enterprise security operator guide

`@selene/core` is data-only. Hosts own identity, signature verification, durable
stores, KMS, DLP scanning, SIEM delivery, timers, and audit effects. Local OSS
uses `allowLocalAccess()` and never needs an account or control plane.

## Required production adapters

- Activate external policy only with `activateSignedPolicy`. A raw compiled
  policy is intentionally rejected by `evaluateExternalAccess`. The signature
  verifier must return the SHA-256 digest of the exact bytes it verified; store
  revision, digest, expiry, and revocation atomically by organization/policy.
- Revision stores must bind entitlement revision to its verified digest and
  expiry. Read revocation on every decision, including provider-outage grace;
  never evict high-water or revocation records for cache pressure.
- Break-glass activation requires two distinct signed, request-bound approvals.
  The activation adapter must atomically consume the replay key and record the
  audit event. A false, timed-out, or unavailable verifier denies access.
- KMS adapters receive only opaque key references and byte buffers. DLP adapters
  receive bounded text and return bounded redaction metadata. SIEM adapters own
  persistent leased claim/ack/nack/dead-letter operations; settle only a live
  lease and retain a stable reason code with redacted dead-letter evidence.

All production adapters must be constructed in a trusted host with the one
shared `@selene/host-runtime` supervisor. The Electron composition captures
ordinary data methods once, owns bounded inputs and results, bridges
cancellation, quarantines timed-out owners until actual settlement, and emits
only stable redacted failures. Do not pass a raw provider, accessor property,
or proxy into the core. The portable core validates provider-neutral data; it
does not own timers, races, provider admission, or a process-wide pool.
