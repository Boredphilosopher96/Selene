# Native Electron verification

Graphical Electron tests activate application windows. On local macOS, the shared test host
refuses these launches by default. Run them in CI, where `CI=true` permits the existing
foreground behavior. Do not set `CI` locally to bypass this guard.

Linux cloud desktop runs remain permitted. Use the cloud desktop's existing display for an
actual GUI journey and retain its screenshots and interaction receipts.

The guard covers desktop `test:e2e`, `test:e2e:flow`, direct desktop Playwright runs, and the
Electron test included in `test:a11y`, `test:a11y:electron`, and `test:a11y:stress`.
`test:a11y:web` remains available. Playwright `--list` loads the tests without launching
Electron. Packaged desktop smoke uses the dependency-free `--smoke-test` entrypoint and exits
before window creation, so it remains available too.

The explicit local foreground opt-in is `SELENE_ALLOW_FOREGROUND_ELECTRON_TESTS=true`.
Use it only after a human explicitly authorizes local foreground verification. Coding agents
must not set it themselves. This opt-in permits visible windows and focus changes; it does not
provide a hidden or non-activating test mode.
