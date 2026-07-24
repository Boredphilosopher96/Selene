import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  codeownersPatternMatches,
  compareLiveRuleset,
  requiredStatusChecks,
  validateGovernancePolicy,
  verifyCodeowners,
  workflowJobNames
} from './governance-policy.mjs';

const root = new URL('../', import.meta.url);
const readRoot = (path) => readFile(new URL(path, root), 'utf8');
const readFixture = async (name) =>
  JSON.parse(await readRoot(`scripts/fixtures/governance/${name}.json`));
const workflowSources = await Promise.all([
  readRoot('.github/workflows/ci.yml'),
  readRoot('.github/workflows/postgres-integration.yml'),
  readRoot('.github/workflows/security.yml')
]);
const workflowContexts = workflowJobNames(workflowSources);

describe('governance verifier', () => {
  it('accepts the checked-in policy using exact current workflow job names', async () => {
    const policy = await readFixture('valid-policy');
    expect(validateGovernancePolicy(policy, workflowContexts).requiredStatusChecks).toEqual(
      policy.requiredStatusChecks.toSorted()
    );
    expect(workflowContexts).toEqual(expect.arrayContaining(requiredStatusChecks));
  });

  it.each([
    ['wrong-branch', 'defaultBranch must be main'],
    ['absent-check', 'missing required workflow check'],
    ['wrong-check', 'unknown workflow check'],
    ['overbroad-bypass', 'emergency bypass must be narrow'],
    ['force-push-enabled', 'block force pushes'],
    ['deletion-enabled', 'block branch deletion'],
    ['disabled-enforcement', 'enforcement must be active']
  ])('rejects the %s fixture', async (fixture, message) => {
    const valid = await readFixture('valid-policy');
    const invalid = { ...valid, ...(await readFixture(fixture)) };
    expect(() => validateGovernancePolicy(invalid, workflowContexts)).toThrow(message);
  });

  it('requires explicit change-local CODEOWNERS paths and honors later overrides', async () => {
    const [codeowners, governance] = await Promise.all([
      readRoot('.github/CODEOWNERS'),
      readRoot('GOVERNANCE.md')
    ]);
    expect(verifyCodeowners({ codeowners, governance }).entries).toBeGreaterThan(10);
    expect(codeownersPatternMatches('/packages/core/', '/packages/core/src/index.ts')).toBe(true);
    expect(() =>
      verifyCodeowners({
        codeowners: codeowners.replace('/packages/core/ @Boredphilosopher96\n', ''),
        governance
      })
    ).toThrow('must explicitly protect /packages/core/');
  });

  it('reports live ruleset drift without making a GitHub mutation', async () => {
    const policy = await readFixture('valid-policy');
    const validRuleset = {
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            required_review_thread_resolution: true
          }
        },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: policy.requiredStatusChecks.map((context) => ({ context }))
          }
        }
      ],
      bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'pull_request' }]
    };
    expect(compareLiveRuleset(policy, validRuleset)).toEqual([]);
    expect(compareLiveRuleset(policy, { ...validRuleset, enforcement: 'evaluate' })).toContain(
      'enforcement differs'
    );
  });
});
