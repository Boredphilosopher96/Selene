import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  codeownersPatternMatches,
  compareLiveRuleset,
  requiredStatusChecks,
  selectLiveRuleset,
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
      policy.requiredStatusChecks.map((check) => check.context).toSorted()
    );
    expect(workflowContexts).toEqual(
      expect.arrayContaining(requiredStatusChecks.map((check) => check.context))
    );
  });

  it.each([
    ['wrong-branch', 'defaultBranch must be main'],
    ['absent-check', 'exact GitHub Actions workflow checks'],
    ['wrong-check', 'exact GitHub Actions workflow checks'],
    ['wrong-integration', 'exact GitHub Actions workflow checks'],
    ['excluded-default-branch', 'target only the default branch without exclusions'],
    ['ambiguous-branch-condition', 'target only the default branch without exclusions'],
    ['overbroad-bypass', 'emergency bypass must be narrow'],
    ['force-push-enabled', 'block force pushes'],
    ['deletion-enabled', 'block branch deletion'],
    ['stale-reviews-disabled', 'dismissStaleReviewsOnPush to true'],
    ['stale-reviews-missing', 'dismissStaleReviewsOnPush to true'],
    ['non-strict-checks', 'strictRequiredStatusChecks to true'],
    ['missing-provenance', 'document the non-locking provenance controls'],
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
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            required_review_thread_resolution: true,
            dismiss_stale_reviews_on_push: true
          }
        },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: policy.requiredStatusChecks.map((check) => ({
              context: check.context,
              integration_id: check.integrationId
            })),
            strict_required_status_checks_policy: true
          }
        }
      ],
      bypass_actors: [{ actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'pull_request' }]
    };
    expect(compareLiveRuleset(policy, validRuleset)).toEqual([]);
    expect(compareLiveRuleset(policy, { ...validRuleset, enforcement: 'evaluate' })).toContain(
      'enforcement differs'
    );
    expect(
      compareLiveRuleset(policy, {
        ...validRuleset,
        rules: validRuleset.rules.map((rule) =>
          rule.type === 'pull_request'
            ? { ...rule, parameters: { ...rule.parameters, dismiss_stale_reviews_on_push: false } }
            : rule
        )
      })
    ).toContain('stale-review dismissal requirement differs');
    expect(
      compareLiveRuleset(policy, {
        ...validRuleset,
        rules: validRuleset.rules.map((rule) =>
          rule.type === 'required_status_checks'
            ? {
                ...rule,
                parameters: { ...rule.parameters, strict_required_status_checks_policy: false }
              }
            : rule
        )
      })
    ).toContain('strict required status checks requirement differs');
    expect(
      compareLiveRuleset(policy, {
        ...validRuleset,
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: ['~DEFAULT_BRANCH'] } }
      })
    ).toContain('default branch condition differs');
    expect(
      compareLiveRuleset(policy, {
        ...validRuleset,
        rules: validRuleset.rules.map((rule) =>
          rule.type === 'required_status_checks'
            ? {
                ...rule,
                parameters: {
                  ...rule.parameters,
                  required_status_checks: rule.parameters.required_status_checks.map((check) =>
                    check.context === 'Verify' ? { ...check, integration_id: 1 } : check
                  )
                }
              }
            : rule
        )
      })
    ).toContain('required status checks differ');
    expect(() => selectLiveRuleset(policy, [])).toThrow('No live ruleset named');
    expect(() =>
      selectLiveRuleset(policy, [
        { id: 1, name: policy.name },
        { id: 2, name: policy.name }
      ])
    ).toThrow('Multiple live rulesets named');
  });
});
