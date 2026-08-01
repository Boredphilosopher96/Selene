# Remaining product work

This document records the product outcomes Selene still needs before it can be
presented as a polished, sellable designer-to-code product. It is a product
readiness map, not a claim that every listed foundation is absent.

The execution source of truth remains Beads, headed by `se-5y5`. Public
implementation and acceptance history is available in the
[direct-manipulation editor](https://github.com/Boredphilosopher96/Selene/issues/38),
[closed designer-workspace reset](https://github.com/Boredphilosopher96/Selene/issues/41),
and [persona validation](https://github.com/Boredphilosopher96/Selene/issues/44).
Update those trackers when work starts or finishes. Update this document only
when the product outcome or acceptance standard changes.

## Current posture

As of `ff38b6118a02fe4de607bce5fba427130504e1e6` on 2026-08-01, Selene has
production-oriented contracts, CI, a provider-neutral agent boundary, React
artifact compilation, source-backed editing primitives, prototype and catalog
manifests, collaboration and handoff schemas, and an Electron workspace.

The Figma-style selection and comment replacement is complete at this snapshot:

- A designer selects a compiler-authenticated React element, not an arbitrary
  rectangle or an unverified DOM fragment.
- Artifact-local pins and thread dialogs replace the persistent comment rail.
- Multiple human review threads support replies, resolution, reopening, and
  explicitly authorized `@AI` escalation.
- Presentation mode omits review chrome.
- AI context is carried through a short-lived host capability bound to the
  project, revision, preview, binding, element, and measured pointer evidence.
- React Flow remains the prototype-flow foundation.

These are important foundations. They do not establish that the complete
designer, collaborator, developer, or enterprise-admin journey is independently
usable. The remaining work below is intentionally phrased as observable product
outcomes rather than implementation tasks.

## Status and completion rules

Use these labels when translating this roadmap into execution work:

- **Foundation present**: code or automated evidence exists, but the complete
  operator journey has not been independently accepted.
- **Product completion pending**: a primary journey is incomplete, fragmented,
  misleading, or not available in the intended product surface.
- **Deployment proof pending**: provider-neutral code exists, but no configured
  deployment and recovery exercise proves the claim.
- **Acceptance pending**: the product may be implemented, but the required
  persona has not completed the exact immutable build or deployment.

CI, a screenshot, a source review, and an implementation-author walkthrough do
not by themselves close a product outcome. Use the
[usability verification playbook](../quality/usability-verification-playbook.md)
and attach the immutable evidence packet it requires.

## P0: Complete the macOS designer workspace

**Status:** Product completion and acceptance pending.

Electron is the primary authoring product. It must feel like one coherent,
professional design tool with AI built into it, not a collection of inspector
forms, demos, or disconnected modes.

### Required experience

- Make the artifact the visual center of the workspace, with stable left/right
  supporting areas that never overlap or obscure the canvas.
- Provide a useful page/layer hierarchy, breadcrumbs, selection state, visible
  bounds, handles, alignment feedback, and clear source-bound limitations.
- Support multi-selection and deterministic keyboard selection without ever
  inventing a source target from an arbitrary screen region.
- Complete source-backed text, content, prop, token, color, typography,
  spacing, layout, position, resize, reorder, reparent, insert, duplicate, and
  delete operations.
- Add constraints, responsive behavior, auto-layout/flex/grid controls,
  component instances, variants, slots, and asset replacement where the source
  adapter can prove a safe edit.
- Provide drag/drop and direct manipulation with truthful previews. Renderer
  feedback may be ephemeral; accepted changes must update canonical React
  TypeScript through a revision-fenced host capability.
- Provide dependable undo/redo and a causal history covering manual edits, AI
  proposals, flow edits, and accepted conflict resolutions.
- Preserve pan, trackpad zoom, fit, canvas zoom, keyboard alternatives, focus
  return, compact-window usability, reduced motion, and 200% zoom.
- Replace raw exceptions and terminal output with concise, actionable product
  errors that retain useful non-secret diagnostics.
- Remove any control that looks editable, draggable, selectable, or publishable
  when it cannot perform that operation or clearly explain why it is unavailable.

### Acceptance evidence

An independent macOS designer must complete AD-01 through AD-07 in the
verification playbook using a signed, immutable desktop artifact. The run must
include a new project, a manual edit, an AI edit, undo/redo, a flow change,
scenario playback, a baseline, and publishing without source inspection.

## P0: Integrate pages, states, and prototype wiring into the canvas

**Status:** Foundation present; product completion and acceptance pending.

Prototype authoring must use the same spatial design workspace. It must not
send designers to an unrelated tab or make a static list look like a canvas.

### Required experience

- Show screens/pages and meaningful states as draggable nodes with persistent
  positions, zoom, pan, fit, selection, and keyboard alternatives.
- Let a designer create an action from a selected React element and wire it to
  another screen, state, overlay, or back/close outcome with visible handles.
- Support selecting, editing, reconnecting, and deleting edges and make every
  resulting action undoable.
- Model loading, empty, error, success, modal, overlay, and alternate scenario
  states without a backend or fake API contract.
- Execute the committed graph through real React navigation or simulated state
  transitions in run/presentation mode.
- Keep prototype screens distinct from Storybook cases. The prototype is an
  assembled product experience; Storybook documents reusable components and
  their important props, variants, and states.
- Preserve the shell/child-project boundary so a product shell can define
  shared navigation while Orders, Customer Service, or another area owns its
  own screens and flows.
- Aggregate federated screens and flows without silently overwriting ownership,
  provenance, scenario identity, or editor layout.

### Acceptance evidence

The designer must visually create and persist a multi-screen flow, reconnect an
edge, run all required scenarios, reload the project, and observe identical
positions and behavior. A hosted collaborator must run the same immutable flow
without receiving authoring controls.

## P0: Finish the provider-neutral AI authoring journey

**Status:** Foundation present; product completion and acceptance pending.

Selene must let the user connect an approved coding agent without embedding a
specific vendor in the core. The agent edits React TypeScript; Selene compiles,
renders, reviews, and persists the result.

### Required experience

- Provide clear provider setup, capability negotiation, health, reconnect,
  cancellation, timeout, teardown, and non-secret diagnostic states.
- Support local agents, CLI-backed agents, and custom adapters through the same
  versioned protocol and host supervision boundary.
- Provide a dedicated AI conversation workspace for broad requests.
- Let a designer select an exact artifact element and privately direct the AI
  to change it. This is distinct from a persistent human review thread.
- Allow a human review thread to mention the AI only through explicit
  authorization and a fresh compiler-authenticated element capability.
- Show the proposed source and visual delta, affected component/screen/scenario,
  warnings, validation, and agent identity before acceptance.
- Support accept, reject, revise, cancel, and undo without leaving the preview,
  source revision, and conversation out of sync.
- Fence stale, replayed, cross-project, cross-preview, unsupported, and legacy
  geometry-only context. General AI chat may be untargeted; targeted changes
  may never use guessed context.
- Ensure generated prototypes contain hard-coded or simulated UI data only and
  do not imply a backend/API integration.

### Acceptance evidence

The same disposable project must work with the deterministic fixture provider
and one real custom provider adapter. The reviewer must exercise success,
rejection, cancellation, disconnect/reconnect, stale context, and unsupported
selection without leaking secrets or orphaning agent processes.

## P0: Complete publishing, hosted review, and developer handoff

**Status:** Foundation present; end-to-end acceptance pending.

Publishing starts in Electron and must produce a revision that product/design
collaborators can review and developers can adopt without hidden local context.

### Required experience

- Publish a named project/revision from Electron to a user-owned GitHub
  repository with an unambiguous progress, error, retry, and recovery path.
- Assemble a hosted prototype, component catalog/Storybook, review metadata,
  and immutable developer handoff without conflating the surfaces.
- Support GitHub Pages for static review and a configurable cloud deployment
  for team features.
- Expose exact React TypeScript source, dependency/design-system provenance,
  source ownership, scenarios, navigation, simulated-data boundary, validation
  receipts, developer directions, and unresolved decisions.
- Give developers a stable link that their tools or AI agents can consume to
  download the exact revision without receiving host capabilities, secrets, or
  local filesystem paths.
- Make later handoff changes actionable: identify affected files, components,
  screens, scenarios, comments, design-system implications, and the safe target
  revision.
- Prove URLs, checksums, archives, and deployment identities are immutable or
  explicitly versioned; never ask developers to trust `latest`.

### Acceptance evidence

An independent developer must complete DH-01 through DH-07 starting only from
the handoff link, including first meaningful use in a disposable workspace and
adoption of a later design delta.

## P1: Finish design-system, template, and extension integration

**Status:** Portable contracts exist; product integration and acceptance pending.

### Required experience

- Add npm design-system packages by exact package/version with lockfile,
  integrity, license, provenance, and compatibility reporting.
- Add Markdown design-language sources with location, retrieval metadata,
  ownership, revision, conflict handling, and explicit refresh/relink behavior.
- Discover tokens, components, templates, assets, variants, and meaningful
  Storybook cases without executing untrusted package code in the core.
- Let designers browse, preview, insert, replace, and update approved components
  while retaining source ownership and package provenance.
- Support organization templates and small feature projects built on a shared
  shell rather than forcing every team to own the entire product.
- Provide extension approval, isolation, version compatibility, capability
  disclosure, revocation, and actionable failure states.
- Aggregate federated component catalogs and screen inventories while keeping
  project ownership and version conflicts visible.

### Acceptance evidence

Run one shell plus two independently owned child projects using a versioned
external package and Markdown design language. Update each input and prove the
affected screens, catalog cases, and handoff provenance without cross-project
mutation.

## P1: Complete review baselines and generated-design changelogs

**Status:** Domain foundations exist; product lifecycle acceptance pending.

This is the changelog for the generated design—not the Selene repository's
release notes.

### Required experience

- Create an immutable baseline when a design is marked ready for design review
  or ready for developer handoff.
- Automatically track every later accepted manual, AI, flow, scenario,
  component, token, direction, and relevant comment-resolution change.
- Name affected screens, components, scenarios, stable elements, source files,
  design-system inputs, and owners.
- Mark prior review/approval/handoff status stale when a meaningful post-baseline
  change occurs; never silently carry approval to a new revision.
- Let reviewers compare baseline/current visual and semantic evidence and accept
  a new baseline explicitly.
- Aggregate readiness and post-baseline deltas across a shared shell and child
  projects without erasing local ownership.
- Preserve a durable, auditable distinction between draft, review-ready,
  changes-requested, approved, handoff-ready, and superseded states.

### Acceptance evidence

Complete the playbook's baseline-to-revision and handoff-update cross-persona
scenarios. Both collaborator and developer must independently identify the same
meaningful delta and target revision.

## P1: Complete shared collaboration and team operations

**Status:** Local and service contracts exist; configured deployment proof pending.

### Required experience

- Persist multiple artifact-local threads with author identity, timestamps,
  replies, resolution/reopening, mentions, permissions, and revision identity.
- Support notification inboxes, assignments, review requests, unread state,
  deep links, and ownership without reintroducing a comments side rail as the
  primary conversation surface.
- Support guest review links, expiration, revocation, role-scoped capabilities,
  and clear read-only behavior.
- Recover reconnectable event streams from durable cursors and handle offline,
  retry, conflict, duplicate, and quota states without losing threads.
- Add optional presence and conflict-safe co-editing only after durable revision
  identity and recovery are proven.
- Provide tenant/project backup, restore, retention, deletion, audit, and
  disaster-recovery operations.
- Keep local-only desktop use account-free while allowing a team to opt into a
  hosted PostgreSQL collaboration service.

### Acceptance evidence

Two independent collaborators must complete CR-01 through CR-07 in separate
sessions, reconnect after interruption, and recover the same thread and review
state. A restore drill must preserve tenant, revision, comment, and audit identity.

## P1: Complete enterprise identity and administration

**Status:** Provider-neutral foundations exist; deployment proof pending.

### Required experience

- Implement organization membership, groups, invitations, role mapping,
  project permissions, service accounts, and capability policy.
- Configure and exercise OIDC and SAML authentication, SCIM provisioning and
  deprovisioning, session revocation, access-version changes, and group mapping.
- Deny unknown issuers/subjects and expired or revoked membership without a
  local, guest, email, or display-name fallback.
- Provide admin UI and runbooks for configuration validation, break-glass
  access, expiry, audit redaction, backup, restore, and policy rollback.
- Add webhooks, automation APIs, connector credentials, rotation, delivery
  history, replay protection, and bounded retries behind explicit entitlements.
- Preserve local-first behavior when enterprise services are absent.

### Acceptance evidence

Exercise a real disposable IdP tenant through sign-in, group/role change,
deprovisioning, session revocation, audit inspection, backup, and restore. Code
contracts or mocked headers do not qualify as deployment evidence.

## P1: Finish macOS distribution and operations

**Status:** Packaging/updater foundations exist; release-channel proof pending.

### Required experience

- Produce signed and notarized macOS artifacts for supported architectures with
  checksums, provenance, SBOM, license inventory, and release notes.
- Validate first install, launch, project creation, import, upgrade, rollback,
  interrupted update, corrupted package, revoked update, and recovery.
- Provide stable/beta channels with explicit user choice and safe downgrade
  policy.
- Complete privacy-safe local crash diagnostics, user-controlled export,
  consented reporting, retention, deletion, symbolication, and support runbooks.
- Measure startup, preview readiness, interaction latency, memory, CPU, agent
  process cleanup, large-project behavior, and long-session stability on macOS.
- Keep Windows production distribution as an explicit backlog until the macOS
  product journey is accepted; continue preventing cross-platform contract
  regressions in CI.

### Acceptance evidence

Install a signed/notarized release on clean Apple Silicon and Intel macOS
accounts, complete the designer journey, upgrade and roll back through the real
channel, and verify diagnostics and project data remain recoverable.

## P1: Independent product acceptance and polish loop

**Status:** Acceptance pending.

### Required experience

- Run independent authoring-designer, hosted-collaborator, developer-handoff,
  and enterprise-admin journeys on immutable artifacts.
- Have reviewers file only concrete product findings with screenshots/video
  when relevant. Implementation owners resolve them; the same reviewers rerun
  the failed journeys.
- Gate acceptance on discoverability, visual hierarchy, interaction quality,
  accessibility, performance, error recovery, collaboration clarity, and time
  to meaningful outcome—not only functional assertions.
- Treat a misleading control, inert canvas, overlapping layout, unusable compact
  view, lost selection, unavailable handoff, or comment detached from its
  artifact as a release blocker at the severity defined by the playbook.
- Preserve environment failures separately from verified product failures.

### Acceptance evidence

Every required persona row in
[enterprise persona journeys](enterprise-persona-journeys.md) must link to a
public-safe immutable run packet and be marked **Independently verified**. A
candidate is not sellable while a primary journey remains planned/blocked.

## Suggested delivery sequence

1. Complete the macOS designer workspace and integrated prototype authoring.
2. Complete AI proposal/recovery and publish/handoff from that same workspace.
3. Prove design-system and federated-project integration with real external inputs.
4. Complete baseline/changelog behavior and hosted multi-user collaboration.
5. Run designer, collaborator, and developer acceptance; resolve and rerun P0/P1 findings.
6. Complete macOS signing, notarization, updater channels, and operational drills.
7. Configure and verify enterprise identity, governance, backup, and recovery.

Enterprise foundations may be built in parallel, but they do not displace the
primary priority: a designer must be able to create, refine, wire, publish, and
hand off a polished React product from the Electron workspace.
