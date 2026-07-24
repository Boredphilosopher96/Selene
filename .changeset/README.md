# Changesets

Add a changeset for every user-facing change to a package that may become publishable. The
workspace is currently private, so this repository does not publish packages or maintain release
history yet.

Use `bun run changeset` to describe the package impact. A maintainer can manually dispatch the
release-preparation workflow to open a version and changelog pull request. That workflow never
publishes to npm or creates a GitHub Release; those actions require a separate, explicitly
approved release process described in [docs/RELEASES.md](../docs/RELEASES.md).
