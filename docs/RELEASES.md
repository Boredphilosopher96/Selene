# Release preparation

Selene uses Changesets for package versioning and changelog generation. The repository is not
configured to publish packages or create GitHub Releases.

## Package version flow

1. Add a changeset with `bun run changeset` for every user-facing change to a package intended
   for publication.
2. Merge the changeset with the implementation.
3. A maintainer manually dispatches **Release preparation** and elects to prepare the version PR.
4. The workflow runs `bun run version-packages` and opens or updates a pull request containing
   calculated versions and changelog entries.
5. Review and merge that pull request as ordinary code. It is still not a publish operation.

Before enabling a future publish job, maintainers must make package visibility and registry access
explicit, use npm trusted publishing/OIDC where available, and protect the release environment.
No long-lived npm token belongs in this repository or a pull-request workflow.

## Electron artifacts

The same manual workflow builds the desktop shell on Linux, macOS, and Windows and uploads each
unsigned build as a short-lived GitHub Actions artifact. It records GitHub artifact provenance so
consumers can inspect how an artifact was built. It does not create installers, sign binaries,
publish a release, or upload to a package registry.

If code signing is introduced, scope platform credentials to the protected, manually dispatched
workflow only. Do not expose signing secrets to pull requests, forks, preview deployments, or
ordinary CI. Signing and notarization must be tested independently for each target platform.
