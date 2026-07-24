import { readFile } from 'node:fs/promises';

import {
  compareLiveRuleset,
  validateGovernancePolicy,
  workflowJobNames
} from './governance-policy.mjs';

function ghJson(args) {
  const result = Bun.spawnSync({ cmd: ['gh', 'api', ...args], stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr).trim());
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

if (import.meta.main) {
  const root = new URL('../', import.meta.url);
  const readRoot = (path) => readFile(new URL(path, root), 'utf8');
  const [policySource, ...workflows] = await Promise.all([
    readRoot('.github/governance-ruleset.json'),
    readRoot('.github/workflows/ci.yml'),
    readRoot('.github/workflows/postgres-integration.yml'),
    readRoot('.github/workflows/security.yml')
  ]);
  const policy = JSON.parse(policySource);
  validateGovernancePolicy(policy, workflowJobNames(workflows));
  const rulesets = ghJson([`repos/${policy.repository}/rulesets`, '--paginate']);
  const matching = rulesets.find((ruleset) => ruleset.name === policy.name);
  if (!matching)
    throw new Error(`No live ruleset named ${policy.name} exists for ${policy.defaultBranch}.`);
  const live = ghJson([`repos/${policy.repository}/rulesets/${matching.id}`]);
  const issues = compareLiveRuleset(policy, live);
  if (issues.length > 0) throw new Error(`Live governance ruleset drift: ${issues.join('; ')}.`);
  console.log(`Live governance ruleset ${policy.name} matches the checked-in manifest.`);
}
