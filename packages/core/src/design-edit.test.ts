import { describe, expect, it } from 'bun:test';
import { DesignEditContractError, parseDesignEditProposal } from './design-edit.js';

describe('design edit public contract hostile input fences', () => {
  it('rejects unsupported formats and does not accept inherited or accessor envelopes', () => {
    expect(() => parseDesignEditProposal({ format: 'selene-design-edit-proposal/v0' })).toThrow(
      DesignEditContractError
    );
    expect(() =>
      parseDesignEditProposal(Object.create({ format: 'selene-design-edit-proposal/v1' }))
    ).toThrow(DesignEditContractError);
    expect(() =>
      parseDesignEditProposal(
        Object.defineProperty({}, 'format', {
          enumerable: true,
          get() {
            throw new Error('must not execute getters');
          }
        })
      )
    ).toThrow(DesignEditContractError);
  });

  it('rejects proxy traps, sparse arrays, and cycles', () => {
    expect(() =>
      parseDesignEditProposal(
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error('trap');
            }
          }
        )
      )
    ).toThrow(DesignEditContractError);
    const sparse: unknown[] = [];
    sparse[1] = 'unexpected';
    expect(() => parseDesignEditProposal(sparse)).toThrow(DesignEditContractError);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => parseDesignEditProposal(cyclic)).toThrow(DesignEditContractError);
  });
});
