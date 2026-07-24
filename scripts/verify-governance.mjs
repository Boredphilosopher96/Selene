import { readFile } from 'node:fs/promises';

const requiredProtectedPaths = [
  '/.github/',
  '/CODE_OF_CONDUCT.md',
  '/GOVERNANCE.md',
  '/SECURITY.md'
];
const ownerPattern =
  /^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)?$/;

function normalizedOwners(owners) {
  return [...new Set(owners)].sort();
}

function ownersMatch(left, right) {
  return JSON.stringify(normalizedOwners(left)) === JSON.stringify(normalizedOwners(right));
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
    entries.push({ pattern, owners: normalizedOwners(owners) });
  }

  return entries;
}

export function maintainersFromGovernance(source) {
  const heading = /^## Maintainers\s*$/m.exec(source);
  if (!heading || heading.index === undefined)
    throw new Error('GOVERNANCE.md must include a "## Maintainers" section.');

  const afterHeading = source.slice(heading.index + heading[0].length);
  const [section] = afterHeading.split(/^##\s/m, 1);

  const maintainers = normalizedOwners(section.match(/@[A-Za-z0-9][A-Za-z0-9-]*/g) ?? []);
  if (maintainers.length === 0)
    throw new Error('GOVERNANCE.md must name at least one GitHub maintainer handle.');
  return maintainers;
}

export function verifyGovernance({ codeowners, governance }) {
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
  if (!ownersMatch(globalEntry.owners, maintainers))
    throw new Error('The repository-wide CODEOWNERS rule must name every governance maintainer.');

  for (const path of requiredProtectedPaths) {
    if (!entries.some((candidate) => candidate.pattern === path))
      throw new Error(`CODEOWNERS must explicitly protect ${path}.`);
    const entry = entries
      .filter((candidate) => codeownersPatternMatches(candidate.pattern, path))
      .at(-1);
    if (!entry) throw new Error(`CODEOWNERS must define an effective owner rule for ${path}.`);
    if (!ownersMatch(entry.owners, maintainers))
      throw new Error(
        `Effective CODEOWNERS rule for ${path} must name every governance maintainer.`
      );
  }

  for (const phrase of ['pull request', 'Code of Conduct', 'SECURITY.md']) {
    if (!governance.toLowerCase().includes(phrase.toLowerCase()))
      throw new Error(`GOVERNANCE.md must describe its ${phrase} policy.`);
  }

  return { entries: entries.length, maintainers };
}

if (import.meta.main) {
  const [codeowners, governance] = await Promise.all([
    readFile(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8'),
    readFile(new URL('../GOVERNANCE.md', import.meta.url), 'utf8')
  ]);
  const verified = verifyGovernance({ codeowners, governance });
  console.log(
    `Verified ${verified.entries} CODEOWNERS rules for governance maintainers: ${verified.maintainers.join(', ')}.`
  );
}
