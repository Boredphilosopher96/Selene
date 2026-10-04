# Dependency security hardening review

## Gate status

As of 2026-10-04, both of these high-severity npm advisories have **no
published upstream patched version**:

- [GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm):
  `braces <= 3.0.3`, recursive AST stack exhaustion
- [GHSA-ch52-4w7c-c8xp / CVE-2026-93748](https://github.com/advisories/GHSA-ch52-4w7c-c8xp):
  `http-cache-semantics <= 4.2.0`, shared-cache response reuse despite
  security-driven zero freshness

The checked-in Bun patches are bounded local mitigations for independent review.
They keep the original package names, versions and registry integrity values.
They do not turn those versions into officially fixed releases. The unchanged
`audit:dependencies` script is still `bun audit && bun audit --production`.
No advisory is suppressed, renamed away, or omitted from its gate.

On the source used for this review, the full raw `bun audit --json` exits **1**
and reports these two high advisories before and after patch installation.
The separate raw `bun audit --production --json` exits **0**. Because the aggregate
script stops on the first failure, its production subcommand is not reached;
the production result above was obtained by running it separately. Dependency
CI therefore remains blocked. Local mitigation tests are not evidence of a green
registry audit, hosted CI, distribution readiness, or product acceptance.

## Resolution and exposure

The locked `braces@3.0.3` is required by `micromatch@4.0.8`. Paths include
Changesets (`@changesets/config`, `@changesets/git`) and
`@manypkg/get-packages -> globby -> fast-glob -> micromatch`. The root tools are
development dependencies. `fast-glob` actively calls the brace expansion API;
a replacement that only offers glob matching is not API-compatible.

The locked `http-cache-semantics@4.2.0` is reached through the desktop packaging
toolchain: `electron-builder -> app-builder-lib -> @electron/get@3.1.0 ->
got@11.8.6 -> cacheable-request`. The actual Electron dependency uses the modern
`@electron/get@5.1.0` separately. The legacy downloader does not enable a shared
HTTP response cache in its default request options, reducing exposure in this
specific packaging path. That observation does not qualify all consumers,
options, plugins, or future packaging paths.

The production audit finding above is about the resolved production graph. It
is not a substitute for inspecting the shipped runtime SBOM or proving every
packaged artifact's contents and security.

### Replacement assessment

The npm registry still reports `braces@3.0.3`, `micromatch@4.0.8`,
`http-cache-semantics@4.2.0`, and `electron-builder@26.15.3` as their latest
releases. There is no official patched version to select for the two advisory
packages. A same-version override is a no-op. An unreviewed fork or renamed
package must not be used just to make the original advisory disappear.

A plain `@electron/get@5.1.0` override would actually remove the legacy cache
chain, but is not a safe drop-in change. The
[official v5 breaking changes](https://github.com/electron/get/releases/tag/v5.0.0)
replace got options with Fetch `RequestInit`, and change proxy configuration.
`app-builder-lib@26.15.3` currently supplies got-style request timeouts and proxy
agents. A version override alone would silently stop honoring those options.
A future reviewed downloader migration must test timeout, proxy, progress,
cache, checksum, and packaging behavior together. It is outside this bounded
patch review.

## Braces patch

`patches/braces@3.0.3.patch` backports the five production-source changes proposed
in [upstream open PR #72](https://github.com/micromatch/braces/pull/72), inspected
at [commit 28d440b5dd449dbf1fe6f3506cf94ecca4d02660](https://github.com/FSDevelop/braces/commit/28d440b5dd449dbf1fe6f3506cf94ecca4d02660).
Only its security hunks are backported, preserving released 3.0.3 parsing
behavior rather than unrelated upstream-master changes. The PR was still open
at review time; it is not an upstream released or maintainer-approved fix.

- Cap combined brace/parenthesis parse nesting at 100 before creating a deeper
  node, including malformed input
- Bound recursive compile, expand and stringify walkers for caller-supplied
  ASTs, with root depth zero and non-root depth one
- Honor stricter finite `maxDepth` values, including fractional values, while
  preventing larger or non-finite values from disabling the 100-level cap
- Detect cycles in expansion's parent-chain traversal
- Preserve the existing stringify escaping behavior and normal expansion APIs

The character and range limits remain in force. This patch does not redesign
parsing, replace the recursive algorithms, promise a general expansion-output
budget, or audit all resource-exhaustion risks. Arbitrary externally supplied AST size, malformed values, and long acyclic
parent chains are not validated by this depth/cycle patch. Parsed string ASTs
remain subject to the 10,000-character and 100-level limits. Expected
`SyntaxError` and
`RangeError` validation failures still need to be handled by callers where
untrusted input is accepted. Package API and version are unchanged; unusually
deep inputs that used to reach the walkers now fail early and predictably.

## HTTP cache patch

`patches/http-cache-semantics@4.2.0.patch` is a local hardening implementation
based on [upstream issue #56](https://github.com/kornelski/http-cache-semantics/issues/56)
and the advisory's zero-freshness bypass. There is no released upstream patch
claimed for it.

A common reuse-restriction predicate denies response reuse for non-storable
entries, response `no-cache`, `must-revalidate`, and the package's existing
shared-cookie/proxy-revalidate restrictions. The shared restrictions are also
used by `maxAge()` without changing its preexisting freshness calculations.
The common predicate gates `evaluateRequest`, direct `useStaleWhileRevalidate`,
and stale-if-error fallback. Error fallback must additionally match the original
request URL, host, method and Vary fields.

This closes both client `max-stale` reuse and the independently identified
origin-error/asynchronous stale reuse paths. Conditional origin revalidation
remains available. Private caches, explicitly public/immutable cookie responses,
and legitimate nonrestricted stale reuse retain their preexisting behavior.
Those explicit cookie opt-ins remain an application trust decision; the patch
does not remove their upstream semantics or make a misconfigured shared cache
safe in general. Manually returning raw `responseHeaders()` without consulting
policy is outside the reuse APIs and remains the consumer's responsibility.

The HTTP patch leaves got, the downloader, timeout/proxy options, and package
resolution unchanged. Local policy/consumer tests do not prove real proxy
networks, downloaded Electron binaries, or signed installers.

## Reproduction and verification

The unpatched 4.2.0 policy on Node 24.19.0 returns another user's example
`Set-Cookie` header with `Cache-Control: max-stale=86400`, even though the shared
cookie response has `maxAge() === 0`. It also reuses `proxy-revalidate`,
`no-cache` and non-storable `private` entries. After this patch those requests
return no cached response and require synchronous origin validation.

The unpatched 3.0.3 `compile` and `expand` walkers on Node 24.19.0 with the
default stack overflow for 4,998 nested braces around `a,b`, a 9,999-character
input below the 10,000-character limit. After patching the input fails at level
101 with an explicit depth-validation error instead of reaching the walker.

Run the checked-in regressions after installing the exact lockfile:

```sh
bun install --frozen-lockfile
bun run test scripts/dependency-security-patches.test.mjs scripts/brace-expansion-compat.test.mjs
bun audit --json
bun audit --production --json
```

The focused suite currently has 39 passing tests across the new regression file
and existing brace-expansion compatibility file. It covers brace and parenthesis
100/101 boundaries, mixed nesting, stricter fractional bounds, attempted cap
disabling, excessive raw input, direct ASTs, child/parent cycles, normal ranges,
escaped/quoted/bracketed/invalid inputs, micromatch and fast-glob consumers,
serialized cache policies, numeric/unlimited max-stale, stale-if-error and direct
stale-while-revalidate bypasses, legitimate stale fallback, private/public cookie
semantics, Vary, and conditional validation. A localhost downloader regression
exercises the actual app-builder-lib dependency and checks successful checksum
validation, bad-checksum rejection, progress and got request timeout. No GUI
application was launched.

Additional verification on Node 24.19.0 / Bun 1.3.14:

- A fresh isolated `bun install --frozen-lockfile --ignore-scripts` installs all
  1,142 packages and passes the same 39 focused tests; disabling install scripts
  avoids downloading or launching Electron during this dependency check
- The existing packaging, SBOM and release fixture subset passes 72 tests
  across 10 files, including the 39 focused tests
- The unchanged released [braces 3.0.3 source suite](https://github.com/micromatch/braces/tree/3.0.3/test)
  passes all 764 tests against the patched five source files
- The unchanged HTTP suite at [advisory-pinned source f01112e954b83cfa8765b633ba880e5e980aa54c](https://github.com/kornelski/http-cache-semantics/tree/f01112e954b83cfa8765b633ba880e5e980aa54c/test)
  passes all 125 tests against the patched index.js; that source index.js was
  verified byte-for-byte identical to the registry 4.2.0 file before patching
- Focused formatting/lint and `git diff --check` pass

The newer upstream HTTP suite at commit
[b5dfe0c8c6e289aebc04462f1c36bc42d1469c52](https://github.com/kornelski/http-cache-semantics/commit/b5dfe0c8c6e289aebc04462f1c36bc42d1469c52)
also exposes a preexisting registry 4.2.0 Vary wildcard whitespace bug. Both
untouched registry source and this patched source produce the identical result:
127 passing, one failing, `Vary: * with whitespace does not match`, whose
assertion says `Vary "* " should not match`. Current upstream has a separate
Vary matching fix that is absent from the registry release. It was not folded
into this bounded advisory patch and remains a separately disclosed cache
policy limitation. There is no claim that the entire latest upstream suite
passes against registry 4.2.0 or that every cache security issue is remediated.

Patch SHA-256 values for this review (identification only; these are not audit
exemptions):

- `braces@3.0.3.patch`: `bd3f6afdc4bd267baa800567e57fbef5286a087df0bb6b5969b28fa85f6e0539`
- `http-cache-semantics@4.2.0.patch`: `55be84633a2977e49debb6c39abaa95b8bcd3471678e40556aceaffd383c2b30`

Independent code/security review remains required before publication. Keep the
raw registry findings visible and retire the local patches when a compatible,
reviewed official release can be selected and its regressions rerun. A decision
to accept residual risk belongs to the repository's security owners and does not
make the existing dependency gate pass.
