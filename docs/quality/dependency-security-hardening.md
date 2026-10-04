# Dependency security hardening review

## Current resolution

The dependency graph now removes both vulnerable packages instead of suppressing
an advisory or relying on a newer version outside an advisory range. The unchanged
`audit:dependencies` script remains `bun audit && bun audit --production`.
Both separate raw JSON audits return `{}` with exit code **0** on the migrated
lockfile. Hosted CI and platform release acceptance must still verify the final
published commit independently.

- Official `@changesets/cli@3.0.3` replaces the CLI 2 dependency chain with
  `@changesets/config@4.0.1`, `@changesets/git@4.0.1` and
  `@manypkg/get-packages@3.1.0`. Their upstream implementations use picomatch and
  tinyglobby, so `braces`, `micromatch`, `fast-glob` and `globby` leave the graph.
- Official `@electron/get@5.1.0` replaces the old packaging downloader through an
  exact override. It uses Fetch, removing `got`, `cacheable-request` and
  `http-cache-semantics`. A reviewed Bun patch adapts `app-builder-lib@26.15.3`
  to the v5 API; an override alone is insufficient.
- The obsolete braces and HTTP local patches are retired. The independent
  `brace-expansion@5.0.12` CommonJS compatibility patch remains required and tested.

The original advisories remain relevant evidence:
[GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
and
[GHSA-ch52-4w7c-c8xp / CVE-2026-93748](https://github.com/advisories/GHSA-ch52-4w7c-c8xp).
Neither advisory is ignored or excluded from an audit. Package versions and
registry integrity values retain their official identities.

## Changesets migration

The [official CLI 3 migration notes](https://github.com/changesets/changesets/blob/%40changesets/cli%403.0.3/packages/cli/CHANGELOG.md)
require configuration and runtime changes, beyond selecting a new package:

- `snapshot.useCalculatedVersion: true` replaces the removed experimental
  `useCalculatedVersionForSnapshots` option
- `privatePackages: { version: true, tag: false }` explicitly preserves the
  repository's CLI 2 behavior: private package versions and changelogs can be
  prepared without tagging or publishing them
- The schema moves to `@changesets/config@4.0.1`
- CLI 3 exits 1 when `changeset version` has no unreleased changesets. The
  release-preparation action v2 checks for pending changes before invoking the
  version script, so the no-op workflow remains supported
- Changesets action v2 uses `version-script`, `commit-message` and `pr-title`
  inputs. Its migration is coordinated with the CLI upgrade in the release
  workflow; no release workflow is dispatched as part of these local tests

The root Node engine is now `^22.12.0 || ^24.0.0 || >=26.0.0`, the supported
intersection of CLI 3 and downloader v5 requirements. Bun stays pinned at 1.3.14.
The isolated fixture initializes a Bun workspace and Git main branch, adds a
private-package changeset, checks dependent package bumps, applies versions and
changelogs, and checks the explicit empty-version exit. Its configuration keeps
publishing disabled; these checks never publish packages or create remote tags.

## Bounded desktop downloader migration

`patches/app-builder-lib@26.15.3.patch` changes only the released package's
`out/util/electronGet.js`, its public declarations, and `out/binDownload.js`.
Packaging target configuration, archive extraction, platform signing, artifact
staging, SBOM generation, and pinned Electron 43.5.0 stay on the existing stable
26.15.3 builder toolchain.

The proxy initialization and retry classification are adapted from the official
[electron-builder source at 4719d58ab68c9338617765d331766a5ca06d03f1](https://github.com/electron-userland/electron-builder/blob/4719d58ab68c9338617765d331766a5ca06d03f1/packages/app-builder-lib/src/util/electronGet.ts).
The npm provenance for `app-builder-lib@27.0.0-alpha.9` identifies that exact
upstream commit. Only the v5 downloader integration is backported; Selene does
not select the broader alpha packaging release.

The default Fetch downloader initializes undici's proxy dispatcher from
`HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, including lowercase equivalents.
As in upstream v27, this applies to Fetch requests in the packaging process.
Legacy `GLOBAL_AGENT_*` proxy variables must be migrated to these standard
variables. Install dependencies with optional packages enabled: v5's built-in
proxy implementation requires its optional undici package, which is present in
this lockfile and the verified clean install.

The previous ten-minute got request timeout becomes a fresh ten-minute
AbortSignal for each download attempt. Artifact and checksum requests within an
attempt share that budget. Retry backoff then creates a new default signal for
the next attempt. This bounds one complete attempt, whereas got previously
applied the limit to each request separately. Explicit caller signals stay
caller-owned. Custom downloaders retain arbitrary option values and own their
timeout policy. The generic `binDownload.download` path also initializes proxy
support and receives a ten-minute signal.

Default-download options accept Fetch RequestInit, `quiet`,
`getProgressCallback`, and the undici `dispatcher` extension. Unknown options,
including got authentication/body/agent/timeout options, fail with a migration
error instead of silently losing behavior. Use Fetch headers/body/signal or an
explicit custom downloader for those integrations. Legacy
`electronDownload.strictSSL: false` now fails explicitly in either configuration
shape; build networks must configure trusted CAs. Selene does not use these
unsupported options. The supported `force: false` plus inline-checksum
configuration retains verified offline cache operation.

Checksums remain enforced on downloaded and cached Electron artifacts. Mirrors,
artifact disk cache, corrupt-cache recovery, progress reporting, transient HTTP
and network retries, and extraction paths retain their supported APIs. The
Electron package's installer and `ensure-electron.mjs` resolve the same official
v5 module; the installer already used v5 before this change.

## Exploit evidence and historical mitigation

At the previous review commit
[6602ebd2e3a7c4f34ece847a1094c81f70d8e1c8](https://github.com/Boredphilosopher96/Selene/blob/6602ebd2e3a7c4f34ece847a1094c81f70d8e1c8/docs/quality/dependency-security-hardening.md),
raw full audit exited 1 with both high advisories; production audit exited 0.
The same-version local patches mitigated tested exploits but did not satisfy the
registry gate. The archived review contains the exact reproduction details,
upstream references, 39 focused tests, released-package suite results,
limitations, and original patch SHA-256 values. That is historical evidence,
not the current graph's gate status.

The old braces source backport came from
[upstream open PR #72](https://github.com/micromatch/braces/pull/72), inspected at
[28d440b5dd449dbf1fe6f3506cf94ecca4d02660](https://github.com/FSDevelop/braces/commit/28d440b5dd449dbf1fe6f3506cf94ecca4d02660).
The old HTTP hardening was based on
[upstream issue #56](https://github.com/kornelski/http-cache-semantics/issues/56).
Both package implementations are now absent from installed dependency resolution.

During this migration the registry published official
`http-cache-semantics@4.3.0` at 2026-10-04T02:56:05Z. Its source still returns
another user's Set-Cookie header when client max-stale overrides a security-zero
shared cache lifetime. Selecting 4.3.0 would escape the advisory's current
`<=4.2.0` range without fixing this exploit, so it was rejected.

The byte-exact 4.3.0 source is retained only as JSON regression data under
`scripts/fixtures/dependency-security`, with its license, registry URL, upstream
commit, and SHA-256. The test evaluates it in an isolated VM to prove the
historical disclosure, then exercises the real migrated builder: successive
forced requests with max-stale and shared-cookie responses retrieve the latest
verified artifact independently. That fixture is not a package dependency and
is not part of the desktop packaging inputs.

## Verification

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test scripts/dependency-security-migration.test.mjs scripts/changesets-migration.test.mjs scripts/brace-expansion-compat.test.mjs
bun audit --json
bun audit --production --json
```

The focused suite has 40 passing tests. It covers chain removal, original advisory evidence, official
module identity, good/bad checksums, fetched SHASUMS, progress, corrupt cache,
offline cache, stalled headers/body, real 503 retry, unsupported got options,
custom downloaders, and real HTTP/HTTPS proxy plus NO_PROXY behavior for both
packaging download paths. HTTPS fixtures generate a fresh, one-day self-signed
localhost certificate and key with the installed `openssl` command in a disposable
system temporary directory. A portable OpenSSL configuration supports macOS
LibreSSL without `-addext`. Only the isolated download process receives the
temporary certificate through `NODE_EXTRA_CA_CERTS`; TLS verification stays enabled.
The regression also proves untrusted certificates and mismatched hostnames fail,
and removes the temporary certificate/key directory afterward. Checkout-local
temporary-directory settings, including symlink aliases, fail before generation.
No certificate or private key is stored in the source tree or uploaded with it.
OpenSSL (or LibreSSL)
must be available on `PATH` for these unit tests; its absence fails the tests.
Changesets add/status/version and legacy brace-expansion
consumers are included.

The clean frozen install was tested on Node 24.19.0 / Bun 1.3.14. The official
Linux Electron archive was verified against pinned SHA-256
`3d93fb0b9517fcd74107c628f61990bff60d3c2543694c28b26b1ef78b80def1`;
Node `electron/install.js` installed from that cache, and Bun
`scripts/ensure-electron.mjs` verified the resulting runtime. Neither launches
the GUI. Local fixture verification does not establish macOS/Windows signed
installer readiness or final hosted CI. The bounded builder backport requires
independent review and should retire when a suitable stable upstream builder
release supplies the supported v5 integration.

Full local unit verification passes 1,185 tests with 9 existing skips when the
exact checkout's canonical `SELENE_HANDOFF_SHA`, `SELENE_HANDOFF_REPOSITORY`, and
`SELENE_HANDOFF_REF` are supplied, as hosted CI does through its GitHub metadata.
Workspace build, typecheck, formatting, lint, and esbuild resolution checks pass.
The optional `check:test-cold` scanner initially exhausted its Node heap while
scanning the unchanged `apps/desktop/src/main/designer-service.test.ts`, before
reaching these migration tests. Missing contextual template rescans exposed
markdown text as a zero-width private-identifier token, so the loop never
advanced. The scanner and affected source were byte-identical to the
pre-migration checkout.

The checker now uses the existing pinned TypeScript 6 structural parser API to
inspect import nodes. Its seven focused regressions cover nested templates,
regex and JSX exclusions, imports inside template expressions, literal dynamic
imports, all static import shapes, parse failures, and exact subpath aliases. A
separate 128 MB / ten-second child process checks the complete designer-service
source and a trailing import. The actual disposable frozen install, TypeScript 7
pre-build workspace typecheck, and pre-build test now pass through
`bun run check:test-cold`.
