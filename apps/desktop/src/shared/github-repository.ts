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
  if (typeof value !== 'string' || value.length === 0 || value.length > 142 || value.indexOf('/') !== value.lastIndexOf('/'))
    throw new Error('repository must use canonical owner/name form');
  const separator = value.indexOf('/');
  if (separator <= 0 || separator === value.length - 1)
    throw new Error('repository must use canonical owner/name form');
  const owner = canonicalGitHubOwnerLogin(value.slice(0, separator));
  const lowerName = value.slice(separator + 1).toLocaleLowerCase('en-US');
  if (!repositoryNamePattern.test(lowerName) || lowerName.includes('..') || lowerName.endsWith('.') || lowerName.endsWith('.git'))
    throw new Error('repository must use canonical owner/name form');
  return owner + '/' + lowerName;
}
