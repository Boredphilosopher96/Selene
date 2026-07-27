import { describe, expect, it } from 'bun:test';
import { DesignEditContractError, parseDesignEditProposal } from './design-edit.js';
import {
  createCompilerRenderedInstanceDigest,
  migrateDesignRevisionV1
} from './design-revision.js';

const digest = 'a'.repeat(64);
const compilerDigest = 'c'.repeat(64);
const revision = migrateDesignRevisionV1({
  format: 'selene-design-revision/v1',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  revisionId: 'revision-1',
  sequence: 1,
  createdAt: '2026-07-25T22:01:00.000Z',
  tuple: {
    sourceDigest: digest,
    graphDigest: digest,
    bindingDigest: digest,
    commandLogDigest: digest,
    designSystemLockDigest: digest,
    deployment: {
      format: 'selene-deployment-identity/v1',
      state: 'unpublished',
      draftId: 'draft-1',
      manifestDigest: digest
    },
    preview: {
      format: 'selene-compiled-preview-identity/v1',
      buildId: 'preview-1',
      previewDigest: digest
    },
    compiler: { format: 'selene-compiler-identity/v1', compilerId: 'compiler-1', compilerDigest }
  },
  privacy: {
    format: 'selene-design-privacy/v1',
    classification: 'restricted',
    contentDigest: digest,
    lifecycle: 'active',
    fields: [],
    retention: { deleteAfter: '2026-07-26T22:01:00.000Z' },
    deletion: { action: 'tombstone', tombstoneDigest: digest },
    exportPolicyDigest: digest,
    auditCorrelationId: 'audit-1',
    exclusions: ['raw-prompt']
  }
}).migratedRevision;
const source = {
  format: 'selene-compiler-source-identity/v1',
  moduleId: 'orders-page',
  exportName: 'OrdersPage',
  astNodeId: 'orders.root',
  sourceDigest: digest,
  bindingDigest: digest
} as const;
const instance = {
  format: 'selene-compiler-rendered-instance-identity/v1',
  instanceId: 'orders-root',
  ancestry: ['orders.root'],
  repeat: { kind: 'singleton' as const }
};
const target = {
  format: 'selene-design-edit-target/v1',
  operation: {
    format: 'selene-design-revision-operation-target/v2',
    tenantId: revision.tenantId,
    projectId: revision.projectId,
    revisionId: revision.revisionId,
    tupleBinding: revision.tupleBinding,
    revisionCommitment: revision.revisionCommitment,
    node: {
      format: 'selene-compiler-node-identity/v2',
      projectId: revision.projectId,
      nodeId: 'orders.root',
      compilerDigest,
      source,
      instance: {
        ...instance,
        instanceDigest: createCompilerRenderedInstanceDigest(revision, source, instance)
      }
    }
  },
  sourceAnchorId: 'orders.root'
};
const validProposal = (value: unknown) => ({
  format: 'selene-design-edit-proposal/v1',
  schemaVersion: 1,
  proposalId: 'proposal-1',
  commandId: 'command-1',
  actorId: 'actor-1',
  origin: 'manual-canvas',
  operation: {
    format: 'selene-design-revision-operation-reference/v2',
    kind: 'edit',
    tenantId: revision.tenantId,
    projectId: revision.projectId,
    actorId: 'actor-1',
    commandId: 'command-1',
    revisionId: revision.revisionId,
    tupleBinding: revision.tupleBinding,
    revisionCommitment: revision.revisionCommitment
  },
  base: revision,
  commands: [{ kind: 'set-prop', target, prop: 'title', value }],
  preconditions: [
    { kind: 'source-revision', sourceDigest: digest },
    { kind: 'binding-revision', bindingDigest: digest },
    { kind: 'design-system-lock', designSystemLockDigest: digest }
  ],
  requestedAt: '2026-07-26T00:00:00.000Z'
});

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

  it('does not treat an own enumerable __proto__ data key as a prototype mutation', () => {
    const hostile = Object.defineProperty({}, '__proto__', {
      enumerable: true,
      value: { polluted: true }
    });
    expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);
    expect(() => parseDesignEditProposal(hostile)).toThrow(DesignEditContractError);
    expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);
  });

  it('parses and deeply freezes a valid prop value with an inert own __proto__ key', () => {
    const value = Object.defineProperty({}, '__proto__', { enumerable: true, value: 'safe' });
    const parsed = parseDesignEditProposal(validProposal(value));
    const command = parsed.commands[0];
    if (command?.kind !== 'set-prop' || typeof command.value !== 'object' || command.value === null)
      throw new Error('fixture did not parse as a prop value');
    expect(Object.getPrototypeOf(command.value)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(command.value, '__proto__')).toBe(true);
    expect(command.value.__proto__).toBe('safe');
    expect(Object.isFrozen(command.value)).toBe(true);
  });

  it('parses a valid proposal into immutable command and precondition arrays', () => {
    const parsed = parseDesignEditProposal(validProposal('Orders'));
    expect(parsed.commands).toHaveLength(1);
    expect(Object.isFrozen(parsed.commands)).toBe(true);
    expect(Object.isFrozen(parsed.preconditions)).toBe(true);
  });
});
