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

  it('normalizes forged public contract errors from hostile getters and proxies', () => {
    const forged = new DesignEditContractError('unsupported', 'attacker selected this message');
    expect(() =>
      parseDesignEditProposal(
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw forged;
            }
          }
        )
      )
    ).toThrow(DesignEditContractError);
    try {
      parseDesignEditProposal(
        Object.defineProperty({}, 'format', {
          enumerable: true,
          get() {
            throw forged;
          }
        })
      );
    } catch (error) {
      expect(error).toBeInstanceOf(DesignEditContractError);
      expect(error).not.toBe(forged);
    }
  });

  it('rejects cross-variant command fields before any host adapter is invoked', () => {
    expect(() =>
      parseDesignEditProposal({
        format: 'selene-design-edit-proposal/v1',
        schemaVersion: 1,
        proposalId: 'proposal-1',
        commandId: 'command-1',
        actorId: 'actor-1',
        origin: 'manual-canvas',
        operation: {},
        base: {},
        commands: [{ kind: 'set-content', target: {}, content: 'x', prop: 'not-allowed' }],
        preconditions: [],
        requestedAt: '2026-07-26T00:00:00.000Z'
      })
    ).toThrow(DesignEditContractError);
  });
});
