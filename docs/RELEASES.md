# Selene release preparation

Selene uses Changesets for package versioning and changelog generation. The repository is not
configured to publish packages. A maintainer may manually create an unpublished GitHub Release draft
only through the exact tag/SHA release workflow. Its canonical GitHub repository is
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
application metadata; the current initial product prerelease is `0.1.0-alpha.0`. The private desktop workspace version is not a second release version. The
manual **Release preparation** workflow uses exactly pinned `electron-builder` 26.15.3 and the exact
Electron version declared in `apps/desktop/package.json` to build installable artifacts, not raw `out/`
directories:

| Platform | Runner                     | Artifact              | Architecture            |
| -------- | -------------------------- | --------------------- | ----------------------- |
| Linux    | `ubuntu-latest`            | AppImage and `.deb`   | x64                     |
| macOS    | `macos-15` (Apple Silicon) | `.dmg`                | universal (x64 + arm64) |
| Windows  | `windows-latest`           | NSIS `.exe` installer | x64                     |

The macOS universal build is performed on the supported `macos-15` ARM64 runner. electron-builder
downloads and merges both configured Electron CPU slices; the local packaging dry run and CI smoke check
launch the packaged app with `--smoke-test`, which exits before a normal window or preview compiler
is initialized. Cross-platform launch smoke is intentionally skipped only when a package is inspected
on a different host OS.

For each matrix entry electron-builder writes its unpacked application and transient build files under
`artifacts/desktop-build/<platform>-<arch>/`; that directory is used only for the launch smoke test and
is never uploaded or released. The packaging script then validates the exact installer set, stages
only those installer files under `artifacts/release-assets/<platform>-<arch>/`, inventories the exactly
one packaged `resources/app.asar` runtime closure (including Electron) in a CycloneDX SBOM, then writes
checksums for the
installers and SBOM while excluding the checksum file itself. Build-only root dependencies are not used
as SBOM evidence. The workflow uploads and attests only this bounded staged directory. Run the same
local check with the current host platform and architecture (after a non-dry-run package build):

```sh
bun run desktop:package -- --platform <host-platform> --arch <host-arch>
bun run sbom
```

With no options, `bun run sbom` resolves the current host as macOS, Linux, or Windows and its
x64 or arm64 architecture, then reads exactly one `resources/app.asar` below the corresponding
`artifacts/desktop-build/<platform>-<arch>/` directory and writes the matching deterministic
`artifacts/release-assets/<platform>-<arch>/Selene-<version>-<platform>-<arch>.sbom.cdx.json` path.
For a cross-target artifact, pass the target platform, architecture, and both bounded paths explicitly,
for example:

```sh
bun run sbom --platform linux --arch x64 \
  --build-directory artifacts/desktop-build/linux-x64 \
  --output artifacts/release-assets/linux-x64/Selene-<version>-linux-x64.sbom.cdx.json
```

The supported target pairs are Linux x64/arm64, Windows x64/arm64, and macOS x64/arm64/universal.
The macOS universal package uses the `macos-universal` path from the matrix and requires explicit
`--platform macos --arch universal --build-directory ... --output ...`; `universal` is never inferred
from the host. The CLI rejects unknown or duplicate options, missing values, unsupported target pairs,
and ambiguous positional arguments. It fails closed when the directory is missing or contains zero
or multiple packaged archives; traversal limits, symlink exclusion, runtime license denial, and
provenance paths remain unchanged.

Release assets are under `artifacts/release-assets/<platform>-<arch>/` and are ignored by Git. A dry
run keeps only unpacked smoke output under `artifacts/desktop-build/`; it intentionally does not stage
or upload release assets. The dry run is unsigned and may report that no trusted macOS signing identity
is present; that is expected.

## Draft GitHub Release and protected signing

No job publishes to npm or contains registry credentials. A maintainer can request an unpublished
draft GitHub Release only by supplying an existing semantic-version tag matching `package.json#version`
and its full 40-character commit SHA. The exact-SHA preflight checks that contract, then runs the current
CI contract before any artifact matrix starts: format, lint, unit tests, typecheck, workspace build,
Storybook build, emitted-size budgets, Chromium-backed web E2E, startup-budget, accessibility, and package
dry-run gates. It verifies the tag again before `gh release create --draft --target <sha>` uploads the
verified staged assets. It never publishes that draft automatically.

Unsigned artifacts are the default. The optional signing job is available only to a manually
dispatched, tagged release and uses the protected `desktop-release-signing` environment. Its gate
does nothing unless the environment has approved `SELENE_SIGNING_APPROVED=true` and all platform
credentials are present: `CSC_LINK` plus `APPLE_API_KEY_CONTENT`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER` for macOS, or `CSC_LINK` and `CSC_KEY_PASSWORD` for Windows. The macOS job writes
the API-key material to a mode-`0600` temporary `.p8` file and enables electron-builder's built-in
notarization only for that protected macOS run. A signing request fails closed if the protected gate
is not approved; a signed draft contains the successfully attested signed macOS and Windows artifacts
plus the verified unsigned Linux x64 artifact (Linux has no signing hook). Secrets are never
available to pull requests, ordinary CI, unsigned builds, artifacts, or logs. Rotate a suspected
credential immediately and invalidate affected signing identities.

## Rollback

For an unsigned artifact or draft-release mistake, delete the draft or revoke artifact access as
appropriate, and rerun from a reviewed commit. For a signed artifact, first revoke the signing or
notarization credential, then issue a new reviewed release; do not overwrite released assets. For a
GitHub Pages regression, revert the responsible `main` commit and let the Pages workflow deploy the
reviewed rollback. Record the incident, affected commit and artifact digests, revoked credentials,
and replacement release in the release notes.
