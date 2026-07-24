const requiredProtectedPaths = [
  '/.github/CODEOWNERS',
  '/.github/workflows/',
  '/packages/core/',
  '/apps/desktop/',
  '/packages/collaboration/migrations/',
  '/docs/',
  '/CODE_OF_CONDUCT.md',
  '/CONTRIBUTING.md',
  '/GOVERNANCE.md',
  '/SECURITY.md'
];
const ownerPattern =
  /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)?$/;

export const requiredStatusChecks = [
  { context: 'Verify', integrationId: 15368 },
  { context: 'PostgreSQL 17 persistence', integrationId: 15368 },
  { context: 'CodeQL', integrationId: 15368 },
  { context: 'Dependency review', integrationId: 15368 }
];

function normalized(values) {
  return [...new Set(values)].sort();
}

function sameValues(left, right) {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function statusCheckKeys(checks, integrationKey) {
  return checks.map((check) => `${check.context}:${check[integrationKey]}`);
}

function sameStatusChecks(left, right, leftIntegrationKey = 'integrationId') {
  return sameValues(
    statusCheckKeys(left, leftIntegrationKey),
    statusCheckKeys(right, 'integrationId')
  );
}

function requiredBoolean(policy, key) {
  if (policy[key] !== true) throw new Error(`Governance policy must set ${key} to true.`);
}

function globExpression(pattern) {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return expression;
}

export function codeownersPatternMatches(pattern, repositoryPath) {
  const rooted = pattern.startsWith('/');
  const directory = pattern.endsWith('/');
  const normalizedPattern = pattern.replace(/^\/+|\/+$/g, '');
  const normalizedPath = repositoryPath.replace(/^\/+/, '');
  const expression = globExpression(normalizedPattern);
  const prefix = rooted || normalizedPattern.includes('/') ? '^' : '(?:^|.*/)';
  const suffix = directory ? '(?:/.*)?$' : '$';

  return new RegExp(`${prefix}${expression}${suffix}`).test(normalizedPath);
}

export function parseCodeowners(source) {
  const entries = [];
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.includes('#'))
      throw new Error(`CODEOWNERS line ${index + 1} has an unsupported inline comment.`);
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0)
      throw new Error(`CODEOWNERS line ${index + 1} must contain a path and at least one owner.`);
    for (const owner of owners) {
      if (!ownerPattern.test(owner))
        throw new Error(`CODEOWNERS line ${index + 1} has an invalid owner: ${owner}.`);
    }
    entries.push({ pattern, owners: normalized(owners) });
  }
  return entries;
}

export function maintainersFromGovernance(source) {
  const heading = /^## Maintainers\s*$/m.exec(source);
  if (!heading || heading.index === undefined)
    throw new Error('GOVERNANCE.md must include a "## Maintainers" section.');
  const [section] = source.slice(heading.index + heading[0].length).split(/^##\s/m, 1);
  const maintainers = normalized(section.match(/@[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []);
  if (maintainers.length === 0)
    throw new Error('GOVERNANCE.md must name at least one GitHub maintainer handle.');
  return maintainers;
}

export function workflowJobNames(workflowSources) {
  return normalized(
    workflowSources.flatMap((source) =>
      [...source.matchAll(/^\s{4}name:\s*(.+?)\s*$/gm)].map((match) => match[1])
    )
  );
}

export function validateGovernancePolicy(policy, workflowContexts) {
  if (policy.version !== 1) throw new Error('Governance policy version must be 1.');
  if (policy.defaultBranch !== 'main')
    throw new Error('Governance policy defaultBranch must be main.');
  if (
    !policy.refName ||
    !sameValues(policy.refName.include ?? [], ['~DEFAULT_BRANCH']) ||
    !sameValues(policy.refName.exclude ?? [], [])
  ) {
    throw new Error('Governance policy must target only the default branch without exclusions.');
  }
  if (policy.enforcement !== 'active')
    throw new Error('Governance policy enforcement must be active.');
  requiredBoolean(policy, 'pullRequestRequired');
  requiredBoolean(policy, 'requireCodeOwnerReviews');
  requiredBoolean(policy, 'requireConversationResolution');
  requiredBoolean(policy, 'dismissStaleReviewsOnPush');
  requiredBoolean(policy, 'strictRequiredStatusChecks');
  if (!Number.isInteger(policy.requiredApprovingReviews) || policy.requiredApprovingReviews < 1)
    throw new Error('Governance policy must require at least one approving review.');
  if (policy.allowForcePushes !== false)
    throw new Error('Governance policy must block force pushes.');
  if (policy.allowDeletions !== false)
    throw new Error('Governance policy must block branch deletion.');
  const provenance = policy.provenancePolicy;
  if (
    !provenance ||
    provenance.mode !== 'documented' ||
    provenance.githubAuthenticatedReviewedPullRequests !== true ||
    provenance.exactShaHostedChecks !== true ||
    provenance.releaseAttestations !== true ||
    provenance.sbom !== true ||
    provenance.requiredSignatures !== false
  ) {
    throw new Error('Governance policy must document the non-locking provenance controls.');
  }
  if (!Array.isArray(policy.requiredStatusChecks) || policy.requiredStatusChecks.length === 0)
    throw new Error('Governance policy must require status checks.');
  if (!sameStatusChecks(policy.requiredStatusChecks, requiredStatusChecks))
    throw new Error('Governance policy must require the exact GitHub Actions workflow checks.');
  for (const check of policy.requiredStatusChecks) {
    if (!Number.isInteger(check.integrationId) || check.integrationId !== 15368)
      throw new Error(
        `Governance policy check ${check.context} must use GitHub Actions app ID 15368.`
      );
  }
  for (const check of policy.requiredStatusChecks) {
    if (!workflowContexts.includes(check.context))
      throw new Error(`Governance policy requires unknown workflow check: ${check.context}.`);
  }

  const bypass = policy.emergencyBypass;
  if (
    !bypass ||
    bypass.actorType !== 'RepositoryRole' ||
    bypass.actorId !== 5 ||
    bypass.bypassMode !== 'pull_request' ||
    bypass.scope !== 'emergency-only' ||
    bypass.requiresIncidentRecord !== true ||
    typeof bypass.reason !== 'string' ||
    bypass.reason.length < 40
  ) {
    throw new Error('Governance policy emergency bypass must be narrow and incident-bound.');
  }

  return {
    requiredStatusChecks: normalized(policy.requiredStatusChecks.map((check) => check.context))
  };
}

export function verifyCodeowners({ codeowners, governance }) {
  const entries = parseCodeowners(codeowners);
  const maintainers = maintainersFromGovernance(governance);
  const allowedOwners = new Set(maintainers);
  for (const entry of entries) {
    for (const owner of entry.owners) {
      if (!allowedOwners.has(owner))
        throw new Error(`CODEOWNERS owner ${owner} is not listed under GOVERNANCE.md maintainers.`);
    }
  }

  const globalEntry = entries.find((entry) => entry.pattern === '*');
  if (!globalEntry) throw new Error('CODEOWNERS must define a repository-wide "*" owner rule.');
  if (!sameValues(globalEntry.owners, maintainers))
    throw new Error('The repository-wide CODEOWNERS rule must name every governance maintainer.');

  for (const path of requiredProtectedPaths) {
    if (!entries.some((candidate) => candidate.pattern === path))
      throw new Error(`CODEOWNERS must explicitly protect ${path}.`);
    const effective = entries
      .filter((candidate) => codeownersPatternMatches(candidate.pattern, path))
      .at(-1);
    if (!effective || !sameValues(effective.owners, maintainers))
      throw new Error(
        `Effective CODEOWNERS rule for ${path} must name every governance maintainer.`
      );
  }
  return { entries: entries.length, maintainers };
}

function ruleByType(ruleset, type) {
  return ruleset.rules?.find((rule) => rule.type === type);
}

export function compareLiveRuleset(policy, ruleset) {
  const issues = [];
  if (ruleset.target !== 'branch') issues.push('target must be branch');
  if (ruleset.enforcement !== policy.enforcement) issues.push('enforcement differs');
  if (
    !sameValues(ruleset.conditions?.ref_name?.include ?? [], policy.refName.include) ||
    !sameValues(ruleset.conditions?.ref_name?.exclude ?? [], policy.refName.exclude)
  )
    issues.push('default branch condition differs');
  if (!ruleByType(ruleset, 'deletion')) issues.push('branch deletion is allowed');
  if (!ruleByType(ruleset, 'non_fast_forward')) issues.push('force pushes are allowed');

  const pullRequest = ruleByType(ruleset, 'pull_request')?.parameters;
  if (!pullRequest) issues.push('pull requests are not required');
  else {
    if (pullRequest.required_approving_review_count !== policy.requiredApprovingReviews)
      issues.push('required approving review count differs');
    if (pullRequest.require_code_owner_review !== policy.requireCodeOwnerReviews)
      issues.push('CODEOWNERS review requirement differs');
    if (pullRequest.required_review_thread_resolution !== policy.requireConversationResolution)
      issues.push('conversation resolution requirement differs');
    if (pullRequest.dismiss_stale_reviews_on_push !== policy.dismissStaleReviewsOnPush)
      issues.push('stale-review dismissal requirement differs');
  }

  const statusChecks = ruleByType(ruleset, 'required_status_checks')?.parameters;
  const contexts = statusChecks?.required_status_checks;
  if (
    !Array.isArray(contexts) ||
    !sameStatusChecks(contexts, policy.requiredStatusChecks, 'integration_id')
  )
    issues.push('required status checks differ');
  if (statusChecks?.strict_required_status_checks_policy !== policy.strictRequiredStatusChecks)
    issues.push('strict required status checks requirement differs');

  const bypass = ruleset.bypass_actors ?? [];
  const expectedBypass = policy.emergencyBypass;
  if (
    bypass.length !== 1 ||
    bypass[0]?.actor_type !== expectedBypass.actorType ||
    bypass[0]?.actor_id !== expectedBypass.actorId ||
    bypass[0]?.bypass_mode !== expectedBypass.bypassMode
  ) {
    issues.push('emergency bypass differs');
  }
  return issues;
}

export function selectLiveRuleset(policy, rulesets) {
  const matching = rulesets.filter((ruleset) => ruleset.name === policy.name);
  if (matching.length === 0)
    throw new Error(`No live ruleset named ${policy.name} exists for ${policy.defaultBranch}.`);
  if (matching.length > 1)
    throw new Error(
      `Multiple live rulesets named ${policy.name} exist for ${policy.defaultBranch}.`
    );
  return matching[0];
}
