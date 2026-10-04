# Product readiness checkpoint

This candidate continues the complete scope in
[remaining product work](../product/remaining-product-work.md). It depends on
PR #191's element-removal and durable review-stream changes. It is an engineering
checkpoint for further implementation and cloud GUI verification. It does not
close the roadmap or the independent persona acceptance gate.

| Workstream                                | Implemented in this candidate                                                                                                                                                                | Remaining work and required evidence                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Designer workspace                        | Durable compiled manual undo/redo, source-backed safe duplication, truthful committed-removal feedback after presentation failure, preserved history after unrelated changes                 | Multi-selection and keyboard traversal; batch service/UI integration; remaining safe source authoring controls; compact/zoom/focus acceptance; signed AD-01–07         |
| Integrated prototype authoring            | Undo/redo for graph actions; keyboard connection editing, reconnect/delete and scenario restoration; atomic graph/review-state persistence                                                   | Shell plus child-project ownership/federation journey; exact-candidate GUI regression and hosted playback acceptance                                                   |
| Provider-neutral AI                       | Stored candidate compiler evidence, exact source diff and explicit unrun checks; runnable supervised CLI example; real gpt-6.1-sol proposal/compile/accept proof                             | Real custom-provider rejection, cancellation, disconnect/reconnect, stale and unsupported target journeys in the product UI; independent acceptance                    |
| Publishing and handoff                    | Arbitrary generated prototype/catalog/review/download outputs; exact-source publishing validation; compiler-bound handoff where evidence exists; verified arbitrary-project web review route | Configured team artifact ingestion, validation, persistence and deployment receipt; actual publication/recovery and independent DH-01–07                               |
| Design systems, templates and extensions  | Bounded public npm retrieval and provenance; active-input baseline invalidation; source-import-aware disable denial; refreshed preview authority after input changes                         | External package with shell/two children through update and handoff; component discovery/insertion/replacement, extension approval/revocation and product acceptance   |
| Baselines and generated-design changelogs | Atomic flow/baseline commit; stale metadata fences; design-system and developer-direction deltas                                                                                             | Complete relevant resolution/component/token/scenario change coverage; federated readiness; independent collaborator/developer identification of the same delta        |
| Team operations                           | Transactional project backup/restore and audit preservation; encrypted browser download/import; stale-revision denial; tested real PostgreSQL restore through the running service            | Durable assignments/review inbox and requests; tenant-wide backup/retention/deletion operations; deployed two-session CR-01–07 and recovery drill                      |
| Enterprise identity and administration    | Existing provider-neutral contracts retained; backup uses authenticated owner/admin authority and tenant fences                                                                              | Real OIDC/SAML/SCIM tenant proof; admin policy/membership/break-glass UI; entitled connector and automation operations; no mocked headers counted as IdP acceptance    |
| macOS distribution and operations         | Existing packaging and updater foundations retained; local foreground test guard; CI evidence paths expanded                                                                                 | Signing/notarization credentials and release channel; clean Apple Silicon/Intel install/update/rollback/corruption/recovery; performance and long-session measurements |
| Independent acceptance                    | Automated source, compiler, browser, service and PostgreSQL evidence retained                                                                                                                | Every required persona row must receive its own immutable independent reviewer packet and failed journeys must be rerun                                                |

The batch duplicate adapter accepts disjoint safe subtrees with one atomic
compilation and persistence operation. The desktop API and selection UI currently
expose a single subtree. Adapter coverage does not establish multi-selection.

Project recovery excludes organization identity policy, sessions, guest grants,
connector credentials and external artifacts. Its authenticated proxy fixture
proves local service behavior; it does not prove a production IdP deployment.

Generated publication prepares content-addressed files and a workflow. It reports
that build/deployment is still required. A prepared Git commit is not a live
hosted team deployment.

## Frozen-candidate GUI verification

Local macOS Electron launches are paused because test windows activate the user's
desktop. The required actual GUI run belongs on the cloud desktop. Hosted CI
provides additional checks; it does not replace that interactive run.

Clone the published candidate and check out its exact commit. Use Bun 1.3.14,
a non-root Linux desktop user, its existing display and working Electron sandbox:

```sh
bun install --frozen-lockfile
bun run build
bun apps/desktop/e2e/build-prototype-flow-harness.mjs
verification_profile="$(mktemp -d)"
apps/desktop/node_modules/.bin/electron \
  apps/desktop/out/main/index.js \
  --user-data-dir="$verification_profile"
```

Retain the commit SHA, environment, actual screenshots, observed interactions,
diagnostics and results. Close the application before removing the disposable
verification profile. Keep this profile distinct from existing user data.

Automated desktop coverage against that same source is:

```sh
bunx playwright test --config apps/desktop/playwright.config.ts \
  apps/desktop/e2e/prototype.spec.ts \
  apps/desktop/e2e/prototype-flow.spec.ts \
  apps/desktop/e2e/duplicate.spec.ts \
  --workers 1 --output /tmp/selene-candidate-native-evidence
```

The current regression targets include committed removal when preview refresh
fails, history across restart, safe duplicate/undo/redo and unsafe-source refusal,
flow editing/undo/redo, and restored compiler authority after design-system staging.
Some older local native runs failed before the final fixes. The new candidate's
GUI result must be recorded independently; historical passing captures cannot
qualify the new commit.

Use the [verification playbook](usability-verification-playbook.md) for persona
acceptance and [native test host guidance](native-electron-verification.md) for
foreground launch restrictions. Do not set CI or a foreground override on the
local Mac to bypass the pause.
