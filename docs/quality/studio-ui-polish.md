# Studio UI polish checkpoint

The UI work starts from published candidate
`6602ebd2e3a7c4f34ece847a1094c81f70d8e1c8`. Development and actual-display
verification took place on a disposable cloud Linux desktop. No local Mac
application or workspace was used.

## Design and interaction changes

- Slate and indigo studio chrome, code-native icons and consistent control states
- Responsive, individually labelled mode/history/navigation groups instead of a
  clipped single toolbar; save and error feedback remain visible
- Rich first-run artwork and starter previews, readable recent-project cards,
  purposeful empty/loading states and keyboard-native template selection
- One-row Inspect/Handoff/Setup tabs, a compact selection prompt, source-backed
  detail sections and truthful prototype-frame identity
- Complete light/dark/high-contrast action color pairs, explicit high-contrast
  selected-state markers and readable inactive frame labels
- Scrollable startup/error recovery, including finite-height windows
- Host-acknowledged AI accept/reject decisions remain saved when preview refresh
  fails. The status distinguishes that presentation failure from a refused
  decision. Departed-project/token feedback stays fenced.

No external icon library, font request, runtime dependency or authority-bearing
API was introduced. Generated project source remains separate from studio chrome.

## Adversarial findings repaired

Independent review and native tests identified:

1. The inherited both-collapsed drawer selector could leave a residual canvas
   track at the 1024px split/drawer boundary
2. Compact project identity width forced header actions to wrap into the status
   strip at 390px
3. Empty inspector searches could count sections that were no longer rendered
4. A dark primary action could inherit an incompatible foreground; high-contrast
   actions and selected markers needed explicit complete token/state treatment
5. Inactive frame labels were difficult to read against the dark canvas
6. Hiding document overflow around renderer recovery could clip its actions
7. A graph frame could be labelled “Nothing selected” while showing frame details
8. A successfully committed AI proposal decision could be described as failed
   when its subsequent preview rendering failed

The scoped independent reviews found no remaining blocking source or visual
issue in the revised studio UI. The fatal renderer-error scrolling branch was
source-reviewed; it was not independently exercised as a fatal-error GUI journey.

## Verification

The new production Electron test file is
`apps/desktop/e2e/studio-polish.spec.ts`. Its two journeys passed on the actual
cloud display and cover:

- Keyboard starter changes, blank-name refusal, a 120-character project name,
  creation, recent-project disclosure and dismissal
- 1600, 1180, 1025, 1024, 768, 620 and 390px viewport widths
- Header/control/status containment, including the split/drawer boundary
- Rail resizing to the 340px maximum, usable 390×320 and 620×360 canvas windows
- Compact Operations open/Escape, repeated Inspector open/Escape and empty-search
  feedback
- Axe WCAG A/AA checks for first-run and inspector in light, dark and increased
  contrast states

The existing built Electron accessibility gate also passed, including its real
keyboard/focus contracts. The full configured JSONL-agent native journey passed:
proposal acceptance, source text/layout/appearance, resize, keyboard/native move,
Escape cancellation, durable undo/redo/reopen and stale handoff. Inspector tabs
preserve their 100×34px target contract and wrap in narrow rails. Native drag
alignment targets the measured compiler-mapped sibling instead of a zoom-dependent
fixed pixel offset; it still requires the vertical element-origin guide and the
exact committed movement/source revision, with geometry retained as an attachment.
Ten injected AI presentation regressions passed for accept/reject rendering
failure, host refusal, stale projects, departed tokens and save-boundary
cancellation refusal. A refused cancellation is not described as a failed or
cancelled AI request.

On the complete polish patch, aggregate formatting, lint, all workspace typechecks,
all package/app builds and artifact manifests passed. The unit suite passed 1,060
tests with 9 skipped. These gates must run again for the integrated candidate;
earlier evidence does not qualify a later revision. The final publisher must
verify exact-head CI.

### Visual baseline environment

The cloud image uses custom OpenAI Sans system-font aliases and Chromium 154;
CI uses the repository-pinned Playwright Chrome 149 on Ubuntu. The pinned browser
could not be materialized here: its download returned an empty/truncated archive.
A workspace-local neutral font configuration reduced, but did not eliminate,
unchanged foundation pixel differences. Foundation baselines were preserved.

Only the three intentionally changed cockpit snapshots were recaptured locally,
with their existing compiled-artifact readiness, geometry and paint checks still
active. These captures are provisional until hosted CI establishes exact runner
pixels. Any hosted correction must be visually reviewed and confined to the
intentional changed surface. Visual thresholds and checks must not be loosened.

## Scope of this checkpoint

This is a UI and correctness checkpoint. It does not establish configured
enterprise identity/team deployment, signed macOS distribution, all independent
persona acceptance rows, or completion of the product roadmap. Those gates remain
in [the product readiness checkpoint](product-readiness-checkpoint.md).

## Presentation ownership follow-up

Final cloud desktop interaction found a blank artboard after leaving Present.
The presentation and React Flow surfaces mount different iframe documents, but
preview authority intentionally accepts a selection bootstrap key only once per
build/frame scope. Reusing the old URL on dismissal therefore failed closed.

Exit and Escape now settle the authoring owner and await a fresh, exact
nonce-fenced build and paint receipt under one mode-transition lock. The host's
one-shot selection-key validation remains unchanged. Failed Present compilation
uses the same authoring restoration. Refused compensating mode changes retain a
truthful presentation surface with an Exit retry; failed rendering after edit
commits reports the saved mode and offers Render without claiming rollback.

The native studio regression covers route navigation/back, repeated Exit/Escape,
fresh URL with unchanged source/graph revisions, keyboard focus after readiness,
post-edit preview failure and Render recovery, failed Present auto-restoration,
refused edit compensation, refusal of both mode writes, and compact 390×320px
error feedback with axe and containment checks. The status chip is sanitized,
bounded and noninteractive so it cannot steal authored prototype clicks.

The completed native long journey also exposed a test synchronization race: its
old textarea value satisfied the revise check before the refresh completed, and
its scenario helper reloaded the renderer during that transient hidden frame.
The test now waits for the real completed revise/paint status and requires the
saved instruction plus unchanged renderer time origin after re-selection. The
original expected request and exact Accept selector remain enforced. Bounded
lifecycle diagnostics improve future failure receipts. Presentation completion
and compensation additionally reject a departed or wrong project owner before
publishing feedback or calling an edit-mode compensation.

The final visible AI-open check caught a shared collapsed-rail selector rotating
the opposite open rail's toggle. A narrowly scoped open-conversation override
keeps its header horizontal and 32px high. Native checks now assert computed
writing mode, 32–40px geometry before and after resizing, accessibility, and an
AI-open screenshot before the inspector collapses that rail.

## Hosted runner follow-up

Hosted Verify run 37183122134 at published source
`513c0a3ea0cd8deecd4b0a09fdfc5e2d962112e7` (tree
`07ef019fecadc13be6e04ae747776fc98616cc8d`), artifact 11295638597,
produced 29 passing visual tests and four reviewed studio-only baseline
changes. Only the three provisional Linux cockpit captures and
`component-explorer-wide` are replaced with exact pinned Playwright Chrome 149
Ubuntu actual bytes. The explorer's 770×823 to 766×818 crop is consistent with
the deliberate 10px center-stage padding and 27px status strip. Typography remains
scoped to `designer-workspace.sl-theme`. Other foundation/Darwin snapshots,
thresholds, masks and visual assertions are unchanged. New exact-head hosted
verification remains required.

The hosted macOS tab receipt measured 102.65625–102.671875px physical widths and
34px heights, with no overlap; integer `scrollWidth` rounded to 103. The test now
keeps the exact, unrounded 100×34px target bounds while comparing integer
scroll/client dimensions for overflow. Five regressions preserve rejection of
1px real overflow, smaller physical targets and invalid measurements. No layout
change or pixel tolerance is needed for that metric correction.

The separate hosted header-containment failure had no retained original trace,
so its exact cause is unverified. Native viewport measurements now wait for font
readiness and two paint frames, then retain raw header/button/viewport geometry
and a failure screenshot before applying the unchanged containment predicate.
The next hosted run must establish whether this synchronization is sufficient.

The following exact-head hosted run at `4d9d59a9a74695c2849ba8d6cfc6b8d859cfeff5`
retained the missing header evidence. At 768px its two-row controls occupied 68px
inside the studio's fixed 50px header, centering the first row above the window
and spilling the second into status feedback. The fix restores intrinsic
`height: auto` with the existing 50px minimum. An in-document wider-font native
fixture reproduces the old constraint's clipping without changing system fonts,
then checks full containment and positive canvas space with the corrected layout.
The Inspector drawer and scrim also anchor to the actual workspace row instead
of assuming a fixed 76px chrome offset; the expanded-header fixture checks their
exact top/bottom alignment and accessibility. One-row headers retain their
minimum geometry; affected overlay captures require exact hosted verification.

The following hosted macOS run at `2e509ab0531c4a5bd2f1f9af9917723878972e71`
passed the responsive header and overlay checks but caught transient launchpad
contrast failure during a theme change. Shared button styles interpolated both
foreground and background for 140ms between individually accessible palettes.
A natural painted-frame cloud reproduction captured the same primary pair,
`#767287` on `#9686f0`, at 86ms. Studio-scoped buttons now switch those colors
atomically while retaining border, shadow and transform motion. The native test
samples both theme directions concurrently with immediate, unchanged axe audits;
it retains every sampled color pair and rejects foreground/surface interpolation.
No settled colors, typography, geometry or visual thresholds change. Exact-head
hosted qualification remains required.
