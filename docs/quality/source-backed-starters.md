# Source-backed desktop starters

The launchpad creates three intentionally different React + TypeScript starting designs:

- **Dashboard:** an operations overview with sample metrics, active-work rows, and an
  Orders screen reached by the authored View orders / Back to overview actions
- **Review:** a welcome concept beside its review brief, plus a Decision notes screen
  reached by Open decision / Back to brief
- **Blank:** one focused canvas, an editable heading, and an authored flex container
  ready for governed component insertion; it has no fabricated order workflow

Visible copy is literal JSX in `src/App.tsx`. Selection and text editing still require the
existing current-build compiler receipt, authenticated rendered selection, literal-only
capability, and durable manual-edit transaction. A starter declaration supplies topology
and scenario content only; it grants no selection, action, or edit authority.

Each starter exposes its current authored design as one scenario. The samples do not claim
to implement enterprise loading, error, empty, permission, or live-data states.

The local deterministic demo agent preserves a recognized starter's TSX, CSS, node metadata,
and screen/action declaration. It stages only a bounded request note in preview data and
labels the result as a demo. The request remains a JSON string and React text, including
when it contains markup-like content. A changed or corrupted starter declaration fails
closed instead of replacing the design with the legacy generic fixture. Real design
generation requires a configured agent.

That preservation rule follows the durable starter context even when a configured revision
removes the declaration and note node entirely. Legacy whole-fixture proposals require the
exact built-in fixture App source; custom or modified TSX is refused without a staged proposal
or source mutation.

## Verification

`starter-workspace.test.ts` verifies every starter's source schema, distinct screen topology,
compiled node/action evidence, current scenario, literal edit capability, durable save,
reopen, undo, demo proposal preservation, malformed declaration rejection, and small-text
contrast. The existing designer-service suite continues to exercise the compiler and
transaction safeguards.

`starter-workspace.spec.ts` uses the built Electron app on a permitted native display. It
creates each starter through the production launchpad, scans the actual preview with axe,
selects the heading at a measured native-input-bridge coordinate, edits with Save text,
restarts the app, verifies durable source, uses Undo manual change, verifies forward/back
presentation actions where present, restarts again, and verifies durable undo. It retains
coordinate receipts and screenshots. Run it after the desktop build:

```sh
bunx playwright test -c apps/desktop/playwright.config.ts starter-workspace.spec.ts
```

Linux cloud desktop verification needs the real desktop display and an available Secret
Service for encrypted local collaboration identity. This test does not add production
switches or weaken Electron sandboxing, preview CSP, compiler evidence, or contrast gates.
