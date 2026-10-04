import type { PrototypeGraph } from '@selene/core';

const privateMetadata =
  /(?:\/Users\/|\/home\/|file:\/\/|[A-Za-z]:\\|(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization)\s*[:=]\s*\S|\bBearer\s+[A-Za-z0-9._~+/-]{16,})/i;
const credentialKey =
  /^(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|secret[_ -]?key|authorization)$/i;

export function containsPrivatePublicationMetadata(value: string): boolean {
  return privateMetadata.test(value);
}

/** Reject unsafe graph data without rewriting the graph covered by compiler binding and digests. */
export function validatePublicPrototypeGraph(graph: PrototypeGraph): PrototypeGraph {
  const pending: unknown[] = [graph];
  while (pending.length !== 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (containsPrivatePublicationMetadata(value))
        throw new Error('Public prototype graph contains private metadata or credentials.');
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (
          containsPrivatePublicationMetadata(key) ||
          (credentialKey.test(key) && child !== null && child !== undefined && child !== '')
        )
          throw new Error('Public prototype graph contains private metadata or credentials.');
        pending.push(child);
      }
    }
  }
  return graph;
}
