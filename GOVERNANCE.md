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

`bun run verify:governance` verifies that the checked-in CODEOWNERS policy agrees with this
document. It is a local, deterministic validation only: it does not call GitHub or create,
change, or inspect live GitHub repository settings.

## Community and security

Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through
the private process in [SECURITY.md](SECURITY.md), rather than a public issue.
