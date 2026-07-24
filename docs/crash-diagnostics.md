# Private crash diagnostics

Selene desktop crash diagnostics are local-first and disabled by default. The trusted main process accepts an explicit user choice from the main renderer before it records an event. The generated preview frame cannot reach this API.

## Data boundary

The local queue and export use `selene-crash-diagnostics/v1`. Each event contains only:

- a fixed source (`electron`, `preview`, `agent`, or `service`);
- a fixed category; and
- an ISO timestamp.

It never records error messages, stacks, design source, prompts, comments, file paths, IDs, environment values, secrets, credentials, tokens, or arbitrary metadata. Hostile error values are deliberately not inspected. The support export is built from this same bounded schema.

## Local operation

Use **Store local crash diagnostics on this device** in the desktop workspace to opt in. The choice is stored locally with a small, identifier-free history of choice and timestamp. Turning it off synchronously blocks collection and reporting, aborts any active sink call, and then deletes queued events and delivery state while retaining the minimal consent history. If persistence is unavailable during withdrawal, Selene remains fail-closed in memory and reports the local fault rather than resuming collection. **Delete diagnostics** also clears the queue; **Export diagnostics** downloads only the data-poor support bundle.

The queue retains at most 32 events and removes events older than 30 days when loaded. Queue, consent, and delivery metadata live in a versioned, app/profile-private subdirectory of Electron's user-data directory. The desktop runtime encrypts those files with Electron's OS-backed `safeStorage`; it has no plaintext command-line or test fallback and fails closed when that encryption service is unavailable. Files and their private parent directory are created with owner-only permissions, no-follow opens, randomized temporary names, bounded sizes, and atomic replacement. Persisted arrays are capped before validation, and malformed, oversized, or symlinked files are ignored rather than reported.

## Reporting and operators

Selene creates no network client for diagnostics and performs no automatic upload. A trusted main-process product integration may provide a `DiagnosticsReportingAdapter` sink, but it can receive a bundle only after persisted user consent is `granted` and immutable main-process policy permits reporting. Renderer code cannot change collection/reporting policy or supply a sink. Keep the sink replaceable, authenticate it outside the diagnostics payload, and do not add raw error data to the schema.

If a trusted sink is offline, Selene stores the bounded, data-poor bundle together with its SHA-256 fingerprint, attempt count, and next retry time in private delivery metadata. This is the exact payload associated with the idempotency key: retries never regenerate its timestamp or event list, even if newer local events arrive. Retries use bounded exponential backoff; a matching successfully delivered bundle is deduplicated and is never sent again. The metadata contains no endpoint, error text, token, user identity, or data beyond the already approved bounded support schema.

Before every port call, the retry record is persisted with the fingerprint as its idempotency key. A sink receives an abort signal and has a bounded deadline; synchronous throws, rejected promises, and hanging ports become an offline retry without blocking local capture, export, deletion, or consent changes.

## Crash recovery

Repeated unclean main/renderer termination enters recovery mode and pauses generated preview builds. Fatal main-process exceptions/rejections are captured only within a short bounded window and then terminate the process non-zero; Selene does not continue with an unknown runtime state. Normal shutdown waits for durable crash-loop cleanup before exit, while fatal termination bypasses that cleanup so evidence is retained across restart. The desktop UI explains recovery, preserves the local export/delete controls, and offers **Resume previews** as the explicit recovery action.

For a support request, ask the user to review and export their local bundle themselves. Operators should not request project files, prompts, comments, tokens, or paths as a substitute for the bundle. To remove all local diagnostics state during an account or device reset, delete the private diagnostics directory while Selene is not running.
