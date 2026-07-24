# Selene release preparation

Selene uses Changesets for package versioning and changelog generation. The repository is not
configured to publish packages or create GitHub Releases. Its canonical GitHub repository is
[Boredphilosopher96/Selene](https://github.com/Boredphilosopher96/Selene).

## Package version flow

1. Add a changeset with `bun run changeset` for every user-facing change to a package intended
   for publication.
2. Merge the changeset with the implementation.
3. A maintainer manually dispatches **Release preparation** and elects to prepare the version PR.
4. The workflow runs `bun run version-packages` and opens or updates a pull request containing
   calculated versions and changelog entries.
5. Review and merge that pull request as ordinary code. It is still not a publish operation.

The manually dispatched workflow also runs `bun run release:dry-run`. It confirms that the root,
apps, and workspace packages remain `private`, then uses `bun pm pack --dry-run --ignore-scripts`
to validate their package contents without creating a tarball, contacting npm, or changing a
version. Package visibility, version changes, and publishing remain separately tracked work.

Before enabling a future publish job, maintainers must make package visibility and registry access
explicit, use npm trusted publishing/OIDC where available, and protect the release environment.
No long-lived npm token belongs in this repository, workflow logs, pull-request workflows, forks,
or preview deployments.

## Electron artifacts

The same manual workflow builds the desktop shell and uploads an unsigned artifact for the
Linux x64, macOS x64, and Windows x64 matrix. Each artifact name starts with `Selene-desktop` and
includes its platform, architecture, and source commit. GitHub records build provenance for the
actual files in each `apps/desktop/out` output directory so consumers can inspect how the artifact
was built. The workflow does not create installers, sign binaries, publish a release, or upload to
a package registry.

If code signing is introduced, scope platform credentials to a protected, manually dispatched
release environment only. Use platform-native signing and notarization credentials, OIDC/trusted
publishing where applicable, immutable action SHAs, and separate tests for every target platform.
Do not expose signing secrets to pull requests, forks, preview deployments, ordinary CI, artifacts,
or logs. Rotate a suspected credential immediately and invalidate affected signing identities.

## Rollback

For an unsigned artifact or release-preparation mistake, disable the manual release run, revoke
artifact access as appropriate, and rerun from a reviewed commit. For a future published release,
first revoke the trusted-publisher or signing credential, then deprecate or unpublish only within
the registry's permitted window; do not overwrite a released version. Restore service with a new,
reviewed patch release. For a GitHub Pages regression, revert the responsible `main` commit and
let the Pages workflow deploy the reviewed rollback. Record the incident, affected commit and
artifact digests, revoked credentials, and replacement release in the release notes.
