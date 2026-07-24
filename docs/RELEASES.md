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

`package.json#version` is the one product-version source for every desktop artifact and the packaged
application metadata. The private desktop workspace version is not a second release version. The
manual **Release preparation** workflow uses exactly pinned `electron-builder` 26.15.3 with Electron
43.2.0 to build installable artifacts, not raw `out/` directories:

| Platform | Runner                     | Artifact              | Architecture            |
| -------- | -------------------------- | --------------------- | ----------------------- |
| Linux    | `ubuntu-latest`            | AppImage and `.deb`   | x64                     |
| macOS    | `macos-15` (Apple Silicon) | `.dmg`                | universal (x64 + arm64) |
| Windows  | `windows-latest`           | NSIS `.exe` installer | x64                     |

The macOS universal build is performed on the supported `macos-15` ARM64 runner. electron-builder
downloads and merges both Electron 43 CPU slices; the local packaging dry run and CI smoke check
launch the packaged app with `--smoke-test`, which exits before a normal window or preview compiler
is initialized. Cross-platform launch smoke is intentionally skipped only when a package is inspected
on a different host OS.

For each matrix entry the workflow uploads the installer(s), unpacked package used for smoke testing,
CycloneDX SBOM, and `SHA256SUMS.txt`; GitHub attests provenance over those produced files. Run the
same local check with:

```sh
bun run desktop:package:dry-run
```

Artifacts are under `artifacts/desktop/<platform>-<arch>/` and are ignored by Git. The dry run is
unsigned and may report that no trusted macOS signing identity is present; that is expected.

## Draft GitHub Release and protected signing

No job publishes to npm or contains registry credentials. A maintainer can request an unpublished
draft GitHub Release only by supplying an existing semantic-version tag and its full 40-character
commit SHA. The workflow checks that the tag resolves to exactly that commit before building and again
before `gh release create --draft --target <sha>` uploads the verified unsigned artifacts. It never
publishes that draft automatically.

Unsigned artifacts are the default. The optional signing job is available only to a manually
dispatched, tagged release and uses the protected `desktop-release-signing` environment. Its gate
does nothing unless the environment has approved `SELENE_SIGNING_APPROVED=true` and all platform
credentials are present: `CSC_LINK` plus App Store Connect API credentials for macOS, or `CSC_LINK`
and `CSC_KEY_PASSWORD` for Windows. The macOS hook notarizes only after that gate. Secrets are never
available to pull requests, ordinary CI, unsigned builds, artifacts, or logs. Rotate a suspected
credential immediately and invalidate affected signing identities.

## Rollback

For an unsigned artifact or draft-release mistake, delete the draft or revoke artifact access as
appropriate, and rerun from a reviewed commit. For a signed artifact, first revoke the signing or
notarization credential, then issue a new reviewed release; do not overwrite released assets. For a
GitHub Pages regression, revert the responsible `main` commit and let the Pages workflow deploy the
reviewed rollback. Record the incident, affected commit and artifact digests, revoked credentials,
and replacement release in the release notes.
