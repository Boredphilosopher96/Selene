import { describe, expect, it } from 'vitest';

import { CanonicalDataError, serializeCanonicalData } from './canonical-data';

describe('portable canonical data', () => {
  it('charges nested output bytes exactly once at the boundary', () => {
    const value = { a: { b: 'x' } };
    const encoded = serializeCanonicalData(value);
    expect(
      serializeCanonicalData(value, {
        maxEncodedBytes: new TextEncoder().encode(encoded).byteLength
      })
    ).toBe(encoded);
    expect(() =>
      serializeCanonicalData(value, {
        maxEncodedBytes: new TextEncoder().encode(encoded).byteLength - 1
      })
    ).toThrow(CanonicalDataError);
  });

  it('rejects hostile and non-inert data under immutable hard limits', () => {
    const accessor = Object.defineProperty({}, 'x', { enumerable: true, get: () => 'x' });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeCanonicalData(accessor)).toThrow(CanonicalDataError);
    expect(() =>
      serializeCanonicalData(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('trap');
            }
          }
        )
      )
    ).toThrow(CanonicalDataError);
    expect(() => serializeCanonicalData(Object.create(null))).toThrow(CanonicalDataError);
    expect(() => serializeCanonicalData(cyclic)).toThrow(CanonicalDataError);
    expect(() => serializeCanonicalData(new Array(2))).toThrow(CanonicalDataError);
    expect(() =>
      serializeCanonicalData('x'.repeat(256_001), { maxStringBytes: 999_999_999 })
    ).toThrow(CanonicalDataError);
    expect(() =>
      serializeCanonicalData({ value: 'x' }, {
        get maxEncodedBytes() {
          return 99;
        }
      } as never)
    ).toThrow(CanonicalDataError);
  });
});
