const ownerLoginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const repositoryNamePattern = /^[A-Za-z0-9_.-]{1,100}$/;

/** Internal canonicalization shared by the trusted host, IPC validator, and renderer feedback. */
export function canonicalGitHubOwnerLogin(value: unknown): string {
  if (typeof value !== 'string' || !ownerLoginPattern.test(value))
    throw new Error('repository owner must be a canonical GitHub login');
  return value.toLocaleLowerCase('en-US');
}

/** This desktop-internal module is not a preload capability or package export. */
export function canonicalGitHubRepository(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 142 ||
    value.indexOf('/') !== value.lastIndexOf('/')
  )
    throw new Error('repository must use canonical owner/name form');
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1)
    throw new Error('repository must use canonical owner/name form');
  const owner = canonicalGitHubOwnerLogin(value.slice(0, separator));
  const lowerName = value.slice(separator + 1).toLocaleLowerCase('en-US');
  if (
    !repositoryNamePattern.test(lowerName) ||
    lowerName.includes('..') ||
    lowerName.endsWith('.') ||
    lowerName.endsWith('.git')
  )
    throw new Error('repository must use canonical owner/name form');
  return owner + '/' + lowerName;
}

/** Validates an immutable GitHub pull-request URL without granting navigation authority. */
export function canonicalGitHubPullRequestUrl(value: unknown, repository: unknown): string {
  const expectedRepository = canonicalGitHubRepository(repository);
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048)
    throw new Error('pull request URL is invalid');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('pull request URL is invalid');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'github.com' ||
    parsed.port !== '' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname.includes('%')
  )
    throw new Error('pull request URL is invalid');
  const segments = parsed.pathname.split('/');
  if (
    segments.length !== 5 ||
    segments[0] !== '' ||
    segments.some((segment) => segment === '.' || segment === '..') ||
    canonicalGitHubRepository((segments[1] ?? '') + '/' + (segments[2] ?? '')) !==
      expectedRepository ||
    segments[3] !== 'pull' ||
    !/^[1-9][0-9]*$/.test(segments[4] ?? '')
  )
    throw new Error('pull request URL is invalid');
  return value;
}
