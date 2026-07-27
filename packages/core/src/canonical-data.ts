export type CanonicalDataErrorCode = 'INVALID_DATA' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED_DATA';

/** Stable portable error for canonical data rejected before a host applies a digest. */
export class CanonicalDataError extends Error {
  public constructor(public readonly code: CanonicalDataErrorCode) {
    super('Canonical data is invalid.');
    this.name = 'CanonicalDataError';
  }
}

export interface CanonicalDataLimits {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxEncodedBytes?: number;
  readonly maxStringBytes?: number;
  readonly maxKeyBytes?: number;
}

const hardLimits = Object.freeze({
  maxDepth: 32,
  maxEntries: 32_000,
  maxEncodedBytes: 2_000_000,
  maxStringBytes: 256_000,
  maxKeyBytes: 4_096
});

function requestedLimit(
  value: CanonicalDataLimits,
  key: keyof CanonicalDataLimits,
  fallback: number
): number {
  try {
    if (
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length
    )
      throw new CanonicalDataError('INVALID_DATA');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return fallback;
    if (!('value' in descriptor) || !descriptor.enumerable || typeof descriptor.value !== 'number')
      throw new CanonicalDataError('INVALID_DATA');
    return descriptor.value;
  } catch (error) {
    if (error instanceof CanonicalDataError) throw error;
    throw new CanonicalDataError('INVALID_DATA');
  }
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Canonical JSON-like encoding for inert own-data. Object keys sort by UTF-16
 * code-unit order; arrays preserve index order; finite numbers and strings use
 * JSON's canonical escaping. Hosts may SHA-256 this returned text.
 */
export function serializeCanonicalData(
  value: unknown,
  requested: CanonicalDataLimits = {}
): string {
  const limits = {
    maxDepth: Math.min(
      requestedLimit(requested, 'maxDepth', hardLimits.maxDepth),
      hardLimits.maxDepth
    ),
    maxEntries: Math.min(
      requestedLimit(requested, 'maxEntries', hardLimits.maxEntries),
      hardLimits.maxEntries
    ),
    maxEncodedBytes: Math.min(
      requestedLimit(requested, 'maxEncodedBytes', hardLimits.maxEncodedBytes),
      hardLimits.maxEncodedBytes
    ),
    maxStringBytes: Math.min(
      requestedLimit(requested, 'maxStringBytes', hardLimits.maxStringBytes),
      hardLimits.maxStringBytes
    ),
    maxKeyBytes: Math.min(
      requestedLimit(requested, 'maxKeyBytes', hardLimits.maxKeyBytes),
      hardLimits.maxKeyBytes
    )
  };
  if (
    !Number.isSafeInteger(limits.maxDepth) ||
    !Number.isSafeInteger(limits.maxEntries) ||
    !Number.isSafeInteger(limits.maxEncodedBytes) ||
    !Number.isSafeInteger(limits.maxStringBytes) ||
    !Number.isSafeInteger(limits.maxKeyBytes) ||
    limits.maxDepth < 0 ||
    limits.maxEntries < 1 ||
    limits.maxEncodedBytes < 2 ||
    limits.maxStringBytes < 1 ||
    limits.maxKeyBytes < 1
  )
    throw new CanonicalDataError('INVALID_DATA');
  const seen = new Set<object>();
  let entries = 0;
  let encodedBytes = 0;
  const chunks: string[] = [];
  const append = (text: string): void => {
    encodedBytes += bytes(text);
    if (encodedBytes > limits.maxEncodedBytes) throw new CanonicalDataError('LIMIT_EXCEEDED');
    chunks.push(text);
  };
  const visit = (current: unknown, depth: number): void => {
    if (current === null) return append('null');
    if (typeof current === 'string') {
      if (bytes(current) > limits.maxStringBytes) throw new CanonicalDataError('LIMIT_EXCEEDED');
      return append(JSON.stringify(current));
    }
    if (typeof current === 'boolean') return append(JSON.stringify(current));
    if (typeof current === 'number' && Number.isFinite(current))
      return append(JSON.stringify(current));
    if (typeof current !== 'object') throw new CanonicalDataError('UNSUPPORTED_DATA');
    if (depth > limits.maxDepth || seen.has(current)) throw new CanonicalDataError('INVALID_DATA');
    try {
      const array = Array.isArray(current);
      if (Object.getPrototypeOf(current) !== (array ? Array.prototype : Object.prototype))
        throw new CanonicalDataError('INVALID_DATA');
      if (Object.getOwnPropertySymbols(current).length !== 0)
        throw new CanonicalDataError('INVALID_DATA');
      seen.add(current);
      const keys = Object.getOwnPropertyNames(current);
      entries += keys.length;
      if (entries > limits.maxEntries) throw new CanonicalDataError('LIMIT_EXCEEDED');
      if (array) {
        const length = Object.getOwnPropertyDescriptor(current, 'length');
        if (
          length === undefined ||
          !('value' in length) ||
          !Number.isSafeInteger(length.value) ||
          keys.length !== length.value + 1
        )
          throw new CanonicalDataError('INVALID_DATA');
        append('[');
        for (let index = 0; index < length.value; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
            throw new CanonicalDataError('INVALID_DATA');
          if (index > 0) append(',');
          visit(descriptor.value, depth + 1);
        }
        seen.delete(current);
        return append(']');
      }
      append('{');
      for (const [index, key] of keys.sort().entries()) {
        if (bytes(key) > limits.maxKeyBytes) throw new CanonicalDataError('LIMIT_EXCEEDED');
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable)
          throw new CanonicalDataError('INVALID_DATA');
        if (index > 0) append(',');
        append(JSON.stringify(key));
        append(':');
        visit(descriptor.value, depth + 1);
      }
      seen.delete(current);
      return append('}');
    } catch (error) {
      if (error instanceof CanonicalDataError) throw error;
      throw new CanonicalDataError('INVALID_DATA');
    }
  };
  visit(value, 0);
  return chunks.join('');
}
