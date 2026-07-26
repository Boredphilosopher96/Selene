# Selene usability and functionality verification playbook

This playbook is the repeatable, evidence-led product gate for Selene. It applies to the
[persona validation program](https://github.com/Boredphilosopher96/Selene/issues/44),
the [designer workspace](https://github.com/Boredphilosopher96/Selene/issues/41), and
the [direct-manipulation React editor](https://github.com/Boredphilosopher96/Selene/issues/38).

A candidate is not accepted because its source appears reasonable or its automated checks are
green. A reviewer must complete a real, role-appropriate journey in the exact product artifact,
record what happened, and independently repeat the journey after remediation.

## Rules

1. Judge what a user can see, understand, invoke, recover from, and hand to the next role.
2. Do not inspect source, the DOM, implementation PRs, or test code before the first journey.
3. Record the exact commit and desktop build, deployment, or immutable handoff revision.
4. Reviewers file findings but do not fix their own findings. The original reviewer re-tests.
5. Anything that looks editable, draggable, selectable, navigable, inspectable, or publishable
   must work, clearly explain why it cannot, or not appear as an affordance.
6. Keep reviewer-environment failures separate from verified product failures.
7. Do not place secrets, private customer content, credentials, or local filesystem paths in
   public evidence.

Post-journey source or CI inspection may clarify a filed finding. Label it supplemental; it is
never primary usability evidence.

## Northstar Orders fixture

Every first-pass run uses the same seeded enterprise product so results remain comparable.

| Fixture   | Required observable content                                                             |
| --------- | --------------------------------------------------------------------------------------- |
| Product   | Northstar Orders, an enterprise order-management experience                             |
| Screens   | Orders list, order details, address exception, overlay/modal, loading, empty, and error |
| Data      | Believable hard-coded order number, customer, status, date, value, and exception data   |
| Flow      | Orders action to Details or overlay, Back/close, and alternate scenarios                |
| Component | A published reusable component with package/version/provenance and meaningful cases     |
| Review    | A seeded address-state thread, named baseline, and one post-baseline change             |
| Handoff   | Immutable revision, React TypeScript artifact, provenance, cases, directions, and delta |

The build owner supplies the fixture and a user-facing launch note. If a fixture is missing,
record a setup failure and stop only the affected task. Do not invent data or silently substitute
another project.

## Exact run record

The run owner completes this before review:

```text
Run ID: UX-YYYYMMDD-<build-shortsha>-<persona>-<attempt>
Product area: Electron authoring | hosted review | developer handoff
Target revision: <full 40-character SHA>
Desktop build: Selene <version> (<signed artifact/checksum or build ID>)
Hosted URL and immutable deployment revision:
Handoff URL and immutable revision:
Fixture: Northstar Orders <fixture revision>
Reviewer: <persona alias; not implementation author>
Date/time/time zone:
Device and macOS version:
Window/viewport, scale, browser or Electron version:
Seeded role/capabilities:
Network:
Accessibility setup:
```

Starting points must be re-resolved for every run:

- Hosted review starts at `https://boredphilosopher96.github.io/Selene/` after mapping that
  deployment to its exact commit.
- Electron review starts from a macOS artifact that embeds or is mapped to the exact commit.
- Developer review starts from an immutable handoff link that exposes its revision. A mutable
  project URL alone fails the starting requirement.

PR numbers, branch names, and `latest` are useful context but are not immutable identities.

## Evidence packet

Create one packet per persona and attempt.

```yaml
run_id: UX-YYYYMMDD-<sha>-<persona>-01
persona: authoring-designer | design-product-collaborator | developer
build:
  commit: <40-character SHA>
  desktop_build: <version/build/checksum or null>
  deployment_url: <immutable URL or null>
  handoff_revision: <immutable revision or null>
environment:
  os: macOS <version>
  device: <hardware class>
  viewport: <width>x<height>@<scale>
  client: Electron <version> | Browser <name/version>
  network: normal
  accessibility: <keyboard, screen reader, zoom, reduced motion>
fixture: Northstar Orders <revision>
starting_state: <open project, signed-in state, and role>
tasks:
  - id: AD-01
    started_at: <ISO-8601>
    completed_at: <ISO-8601 or null>
    outcome: pass | partial | blocked | failed
    steps_taken: <count>
    observation: <plain-language notes>
    evidence: [<artifact URLs or IDs>]
    findings: [<GitHub issue URLs>]
environment_events: [<separately labelled tooling events>]
reviewer_attestation: I completed the first journey without source inspection.
```

For each task, record discoverability, visual polish, keyboard/accessibility, performance,
recovery, and any confusing or misleading product feedback.

### Screenshots and video

```text
UX-<date>-<shortsha>-<persona>-<task>-<step>-<state>-<viewport>.png
UX-<date>-<shortsha>-<persona>-<task>-<state>.mp4
```

Examples:

```text
UX-20260725-231eac6-author-AD-05-03-wire-created-1440x900.png
UX-20260725-6e81437-collaborator-CR-05-02-thread-open-1280x800.png
UX-20260725-788f4d1-developer-DH-06-handoff-delta.mp4
```

- Capture the whole product window, including focus or selection state.
- Add video for drag/drop, navigation, focus loss, loading, undo/redo, or other temporal defects.
- Store raw evidence in the controlled run artifact store. Attach safe, relevant captures to the
  issue or provide a durable access-controlled link.
- Keep a small manifest that maps each file to its commit, task, and timestamp.
- If capture tooling returns a blank or misleading frame, preserve it as an environment event;
  describe the verified accessible UI evidence and do not pretend the image proves the product.

## Persona A: authoring designer in macOS Electron

The reviewer is an enterprise product designer who has not read Selene's source.

Start from a new local Northstar Orders project with an available, non-secret demo provider.
If no provider is supplied, record a fixture gap and complete all non-agent tasks.

| ID    | Task                                                                                                                                         | Pass evidence                                                                                            |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| AD-01 | Identify project, artifact-editing mode, and flow mode without docs.                                                                         | Correctly explains that artifact edits change React design while flow edits change simulated navigation. |
| AD-02 | Ask the supplied agent to make the address exception prominent and add a details state. Review and accept or reject.                         | Target, proposal, outcome, and recovery are visible; no secret exposure.                                 |
| AD-03 | Select the exception in preview and ask the agent to change that exact target. Inspect its useful hierarchy, properties, tokens, and layout. | Selection maps to the artifact and unsupported data is stated truthfully.                                |
| AD-04 | Make one supported manual content, prop, token, spacing, layout, reorder, resize, or component-insert edit. Undo and redo.                   | Change is visible, React-canonical, reversible, and recorded with causal history.                        |
| AD-05 | Drag Orders and Details nodes, wire an action, select/edit/reconnect/delete an edge, undo, and use one keyboard alternative.                 | Positions and edges persist; direct manipulation and keyboard feedback are truthful.                     |
| AD-06 | Run Orders to Details/overlay and Back/close. Exercise loading, empty, and error.                                                            | Runtime follows the committed graph and every selected state renders correctly.                          |
| AD-07 | Add a developer direction, set a baseline/readiness state, and publish/share.                                                                | Exact revision, audience, status, validation receipt, and link are unambiguous.                          |

Observe mode discoverability, primary-canvas dominance, wide/compact layout, prompt-to-preview
latency, focus return, accidental destructive actions, errors, and recovery. A designer should not
need source knowledge to understand what happened.

## Persona B: hosted design/product collaborator

The reviewer is a design or product teammate reviewing a published revision, not its author.
Start from the shared review link with a seeded collaborator role.

| ID    | Task                                                                                         | Pass evidence                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| CR-01 | Determine project, revision, baseline, readiness, and permissions.                           | All are human-readable and revision is immutable.                                                                    |
| CR-02 | Run Orders through Details/overlay and loading, empty, and error.                            | Prototype navigation and state are visible and distinct from Storybook.                                              |
| CR-03 | Inspect the exception component.                                                             | Approved style/token, component/design-system provenance, accessibility, and scenario data are useful and read-only. |
| CR-04 | Find a reusable published component and its meaningful props/variants/cases.                 | Catalog/Storybook and assembled prototype have a clear relationship.                                                 |
| CR-05 | Place a free-form pin on the artifact, start a thread, reply, and resolve/reopen if allowed. | Pin targets the intended visual region; identity, replies, and resolution are clear.                                 |
| CR-06 | Compare with the review baseline and identify a meaningful post-baseline change.             | Delta names affected screen/component/scenario and links to evidence.                                                |
| CR-07 | Add a product direction and approve or request changes as permitted.                         | Audience, ownership, shared status, and next step are clear.                                                         |

Check comment precision, thread semantics, comments versus private AI direction, baseline
truthfulness, permissions, compact layout, and whether the portal remains a focused review space
rather than a squeezed authoring workstation.

## Persona C: developer receiving handoff

The reviewer is an engineer with no prior Selene or project context. Start with only the immutable
handoff link and developer capability. Do not clone or open source until the product directs it.

| ID    | Task                                                                                                                            | Pass evidence                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| DH-01 | Identify exact project/revision, readiness, owner, and feature.                                                                 | Summary is self-contained and revision is immutable.                         |
| DH-02 | Learn scenarios, navigation, hard-coded-data boundary, directions, comments, and expected behavior.                             | Developer can accurately explain the product behavior and open decisions.    |
| DH-03 | Reach the exact React TypeScript, dependency lock/provenance, design-system package/version, ownership, and validation receipt. | Artifacts are reproducible and contain no secret or local-path leakage.      |
| DH-04 | Reach related Storybook/catalog cases and distinguish them from the assembled prototype.                                        | Props, variants, cases, and screen usage are traceable.                      |
| DH-05 | Pull/download the immutable revision into a disposable workspace using the product's instructions.                              | Time to first meaningful use and any prerequisite/error are recorded.        |
| DH-06 | Review a post-handoff design change and obtain the safe target revision/delta.                                                  | Affected files/components/scenarios/comments and update path are actionable. |
| DH-07 | Leave a developer question and verify where the designer receives it.                                                           | Collaboration ownership and response path are explicit.                      |

Observe time to first use, missing context, source versus rendered HTML, reproducibility,
simulated/backend boundaries, component traceability, change adoption, and link durability.

## Cross-persona scenarios

1. **Baseline to revision:** author publishes and marks review-ready; collaborator pins a threaded
   address-state comment; author makes a manual or agent-assisted change; collaborator sees the
   exact delta and accepts or requests another revision.
2. **Handoff update:** developer reaches first use from a handoff link; author changes the
   address-state component; developer identifies the exact affected component, screen, scenario,
   source/design-system implication, status, and safe new revision.
3. **Reuse with provenance:** collaborator finds a published component; author reuses it in
   Northstar Orders; developer traces final usage to package/version and cases.
4. **Distinct comment types:** a team review thread remains persistent and shared, while an
   author's “change this selection” direction remains in the agent workflow. Neither silently
   turns into the other.
5. **Permission and recovery:** a read-only collaborator cannot mutate design; stale revision,
   conflict, disconnected agent, or publish failure provides a safe recovery path.

## Accessibility, resilience, and performance observations

- Reach primary controls, modes, canvas alternatives, selection, comments, dialogs, publish,
  handoff, and undo/redo by keyboard. Verify visible focus, Escape/cancel, and focus return.
- When configured, check named controls, state announcements, node/edge context, thread context,
  and actionable errors with a screen reader. One pass does not establish conformance.
- Inspect hosted review at 200% zoom and Electron at compact macOS window sizes. Check reduced
  motion and contrast without hiding the artifact or primary actions.
- Test pointer selection, pinning, dragging, panning, wiring, scroll conflicts, and cancelled drops.
- Record stopwatch observations for first usable preview, mode switch, graph run, comment submit,
  comparison, handoff load, and publish/agent response. Do not call a build slow without the exact
  environment and operation.
- Exercise only safe supported failures. Never test destructive operations on non-disposable
  projects or execute arbitrary plugin/template content.

## Severity

| Severity    | Meaning                                                                                                          | Examples                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0          | Primary journey cannot complete; loss, security, deception, or visibly broken product; no acceptable workaround. | Inert canvas, hidden artifact, no publish/handoff revision, comments cannot anchor. |
| P1          | Core journey needs a confusing, unsafe, inaccessible, or unreliable workaround; major context is missing.        | Keyboard cannot wire flow, no provenance/cases, misleading stale state.             |
| P2          | Task completes but wastes material time or trust; bounded workaround exists.                                     | Weak hierarchy, unclear label, poor compact spacing, recoverable lag.               |
| P3          | Minor polish inconsistency without material task impact.                                                         | Alignment, copy, hover, or icon detail.                                             |
| Environment | Test infrastructure or access prevents evaluation; not a verified product defect.                                | No browser backend, expired artifact, missing seeded account.                       |

Severity reflects user impact on the product claim, not implementation complexity.

## GitHub finding template

Title: `[UX][persona][P0|P1|P2|P3] observable failure`

Apply `ux`, `persona-review`, and the severity label, and link issue #44.

```md
## Persona and task

- Persona:
- Task ID:
- Intended outcome:
- Blocked? Workaround?

## Exact environment

- Revision:
- Desktop build/deployment/handoff URL:
- OS, client, viewport/window, scale:
- Fixture and role:
- Network/accessibility setup:

## Reproduction

1.
2.
3.

## Expected

## Actual

## User impact and severity

- Proposed severity and rationale:
- Product area:
- Accessibility, keyboard, performance, or recovery impact:

## Evidence

- Run ID:
- Screenshot/video:
- Timestamp or duration:
- Supplemental post-journey source/CI inspection: none

## Re-verification acceptance

State the exact observable result the original reviewer must achieve.
```

For an environment event, record the run, requested and actual environment, exact error,
whether the product was reached, workaround, customer impact evidence, and run-owner action.
Do not file it as a product bug without product evidence.

## Mayor triage and remediation

Within one working day:

1. Confirm persona, task, SHA, environment, reproduction, expected/actual, impact, and evidence.
2. Reproduce only enough to distinguish product defect from environment failure.
3. Apply severity and labels; link #44 and the relevant product issue; create or attach a Bead.
4. Assign an implementation owner who did not author the finding.
5. Comment publicly with owner, priority, scope, tracking, status, and exact re-test condition.
6. Stop affected promotion for P0. Schedule P1 before broad customer use.

Use this status form:

```md
Triage: confirmed | needs environment reproduction | needs evidence
Severity: P__ — <user impact>
Owner: @<assignee>
Tracking: <Bead>; implementation PR: <URL or pending>
Scope: <what will and will not change>
Status: investigating | implementing | awaiting CI | ready for persona re-test
Re-verification: original <persona> repeats <tasks> on <immutable revision> and must observe <result>.
```

The fix owner links the PR to the finding and repeats its observable acceptance condition. CI,
screenshots, and code review are supporting evidence only. The Mayor announces re-test only with
the full fixed SHA, artifact/deployment/handoff URL, fixture reset, and known limitations.

The original reviewer repeats the failed task first, without source inspection:

- Pass comment: `Re-verified on <SHA>: <task> passed; evidence <link>.`
- Failure: keep/reopen the issue. File a second issue only for a separate defect.

Close only after the original acceptance condition passes. Run an adjacent-persona sanity check:
authoring fixes get hosted review, hosted/handoff fixes get a developer read-through, and flow
fixes get a run-preview confirmation.

## Readiness gate

A scope is ready only when:

- exact desktop, deployment, and handoff revisions are known;
- current packets cover all applicable personas and the Northstar Orders primary flow;
- no P0 or P1 affects that scope;
- review comments, post-baseline changes, immutable revision, and handoff are observed;
- Electron wide/compact, hosted review, and handoff have been visually inspected;
- every fix has original-persona re-verification; and
- environment exclusions are explicit and do not masquerade as product acceptance.

## Responsibilities

| Role                 | Responsibility                                                                       |
| -------------------- | ------------------------------------------------------------------------------------ |
| Run owner            | Supplies exact build, fixture, safe roles, evidence storage, and reset instructions. |
| Persona reviewer     | Runs source-blind tasks, captures evidence, files findings, and re-verifies.         |
| Fix owner            | Implements the scoped issue and supplies an immutable candidate.                     |
| Mayor                | Maintains #44, triages, assigns, links Beads/PRs, and protects re-test gates.        |
| Product/design owner | Resolves product choices exposed by valid findings.                                  |

## Fixture assumptions to validate

- The Pages URL is mapped to its exact deployment commit for every hosted run.
- Northstar Orders provides seeded roles, a safe demo agent, reusable component, review baseline,
  and immutable handoff fixture before review.
- A controlled store exists for raw screenshots and video.
- macOS is the current acceptance platform. Windows evidence is exploratory for this milestone.
- Every in-flight PR head is re-resolved before a run; this document never treats an old SHA as
  the current candidate.
