# Dependency updates

Renovate is the sole bot for npm/Bun dependency version updates. Its `bun` manager updates the
root `package.json` files and the committed `bun.lock` together. The repository deliberately uses
exact version pins; Renovate's `rangeStrategy: pin` preserves that policy rather than introducing
semver ranges. Enabled lockfile maintenance also refreshes transitive resolutions in `bun.lock`.

Bun does not run dependency lifecycle scripts by default. `electron` is the only trusted
dependency because its official install script downloads the pinned Electron runtime required for
desktop smoke tests and release builds. Do not add dependencies to `trustedDependencies` without
reviewing the package's install behavior and documenting why it is necessary.

Enable the Renovate GitHub App for this repository. It must use the checked-out default branch as
its trusted base and open ordinary pull requests. Do not replace this with a `pull_request_target`
workflow or grant a write-capable token to a workflow that checks out a contributor's PR ref.
Renovate's grouped changes are reviewed by normal read-only pull-request CI, which runs
`bun install --frozen-lockfile` and does not give PR code repository-write credentials.

## Grouping policy

- Vite, `@vitejs/plugin-react`, and `electron-vite` are grouped as the Vite toolchain.
- Every `storybook` and `@storybook/*` package is grouped together so their exact release lines
  cannot drift.
- Electron and `@types/node` are grouped as the Electron runtime.
- Vitest is its own compatible update group.

## Dependabot transition

`.github/dependabot.yml` retains only GitHub Actions updates. After Renovate is enabled, close any
open Dependabot npm version-update PRs as superseded; do not merge both bots' lockfile changes.
Dependabot security alerts remain enabled in GitHub and should be triaged against the Renovate
pull request or a manually scoped security fix. Close an alert only after its fixed version is
present in both the manifest and `bun.lock`, and the frozen-lock CI suite succeeds.
