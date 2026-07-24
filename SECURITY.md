# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers. Do not file public issues
for exploitable security defects. Include a reproducible description, affected component,
reproduction steps, potential impact, and any known mitigations. Do not include credentials,
tokens, or customer data.

We acknowledge reports within five business days and will coordinate a fix and disclosure plan
with the reporter. This repository has no supported published release lines yet; security fixes
are made on the default branch.

## Supply-chain controls

Pull requests receive dependency review with vulnerability and license policy checks. CodeQL runs
on pull requests, `main`, and a weekly schedule. CI also produces a CycloneDX SBOM from the Bun
dependency inventory and rejects the same prohibited-license set. The manually dispatched Electron
artifact workflow records GitHub build provenance for its uploaded artifacts; it does not publish
software or use signing credentials.

These controls reduce risk but do not replace review. Contributors must not add secrets to pull
request workflows or log sensitive values in CI output.
