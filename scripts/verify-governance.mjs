import { readFile } from 'node:fs/promises';

import {
  validateGovernancePolicy,
  verifyCodeowners,
  workflowJobNames
} from './governance-policy.mjs';

const root = new URL('../', import.meta.url);
const readRoot = (path) => readFile(new URL(path, root), 'utf8');

if (import.meta.main) {
  const [codeowners, governance, policySource, ...workflows] = await Promise.all([
    readRoot('.github/CODEOWNERS'),
    readRoot('GOVERNANCE.md'),
    readRoot('.github/governance-ruleset.json'),
    readRoot('.github/workflows/ci.yml'),
    readRoot('.github/workflows/postgres-integration.yml'),
    readRoot('.github/workflows/security.yml')
  ]);
  const ownership = verifyCodeowners({ codeowners, governance });
  const policy = validateGovernancePolicy(JSON.parse(policySource), workflowJobNames(workflows));
  console.log(
    `Verified ${ownership.entries} CODEOWNERS rules and ${policy.requiredStatusChecks.length} required governance checks.`
  );
}
