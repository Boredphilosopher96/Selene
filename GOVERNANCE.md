# Governance

Selene is maintained by its project maintainers. Maintainers set technical direction, review
changes, and manage releases. Decisions that affect contributors or package consumers are
documented in pull requests or issues.

## Maintainers

The current project maintainer is [@Boredphilosopher96](https://github.com/Boredphilosopher96).
The canonical review ownership for the repository and these policy files is declared in
[`.github/CODEOWNERS`](.github/CODEOWNERS).

## Decisions and review

Contributors should discuss compatibility-sensitive public API or schema changes before
implementation. A maintainer reviews pull requests before merge and records material technical
or governance decisions in the pull request or its linked issue. Changes to `CODEOWNERS`, this
document, the security policy, the Code of Conduct, or GitHub workflow configuration require
maintainer review.

`bun run verify:governance` verifies the checked-in CODEOWNERS policy, the canonical
[`governance-ruleset.json`](.github/governance-ruleset.json), and the exact current workflow job
names. CI runs this deterministic offline verification only. It makes no GitHub API call.

`bun run verify:governance:live` is a maintainer-only, read-only audit. It uses `gh api` to
compare the live ruleset for `main` with the canonical manifest; it never creates, updates, or
deletes a GitHub setting. Until the staged activation below is complete, the command is expected
to fail because the live ruleset does not exist.

## Ruleset activation and emergency procedure

1. Land and run the offline verifier first; it validates the desired policy and workflow check
   names without touching GitHub.
2. A repository administrator creates the `Selene main governance` branch ruleset in GitHub from
   the manifest: active enforcement for `main`, pull requests, one approval, CODEOWNERS review,
   resolved conversations, stale-review dismissal on push, strict up-to-date checks, the listed
   checks pinned to the GitHub Actions app ID, and blocked force-push/deletion operations.
3. Run `bun run verify:governance:live` with read access and retain its passing output in the
   activation pull request or issue. Any drift is fixed through the normal reviewed process.

The only bypass is the manifest's `RepositoryRole` administrator entry in `pull_request` mode.
It may be used solely to restore production service or remediate an active security incident. The
maintainer must open an incident record before or immediately after use, record the justification,
and obtain a follow-up review that restores the normal rule path. It must never be widened to an
`always` bypass or used for routine delivery.

## Provenance policy

Selene does not require signed commits yet, because doing so would lock out existing contributor
workflows. Instead, the checked-in policy requires a GitHub-authenticated reviewed pull request,
exact-SHA hosted checks, release attestations, and a CycloneDX SBOM as the documented provenance
chain. The offline verifier rejects a manifest that weakens or omits any of these controls.

## Community and security

Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through
the private process in [SECURITY.md](SECURITY.md), rather than a public issue.
