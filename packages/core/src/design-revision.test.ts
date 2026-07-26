import { describe, expect, it } from 'vitest';

import {
  commitDesignRevision,
  commitDesignRevisionOutcome,
  compileDesignRevisionPolicy,
  createDesignRevisionCommitment,
  createDesignRevisionExportAuthorityBinding,
  createDesignRevisionPrivacyBinding,
  createDesignRevisionOperationTarget,
  createDesignRevisionOperationReference,
  createDesignRevisionTupleBinding,
  designRevisionRequiredPrivacyExclusions,
  DesignRevisionContractError,
  evaluateDesignRevisionExportEligibility,
  negotiateDesignRevisionHostCapabilities,
  parseDesignRevision,
  parseDesignRevisionOperationReference,
  parseDesignRevisionOperationTarget,
  parseDesignRevisionState,
  transitionDesignPrivacyLifecycle
} from './index';

const digest = 'a'.repeat(64);
const compilerDigest = 'c'.repeat(64);
const serialized = (value: unknown): string => {
  const result = JSON.stringify(value);
  if (typeof result !== 'string') throw new Error('fixture must be serializable');
  return result;
};
const tupleBinding = JSON.stringify([
  'selene-design-revision-tuple-binding/v1',
  digest,
  digest,
  digest,
  digest,
  digest,
  'unpublished',
  'draft-1',
  digest,
  'preview-1',
  digest,
  'compiler-1',
  compilerDigest
]);
const policy = {
  format: 'selene-design-revision-policy/v1',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  policyId: 'design-policy',
  revision: 1,
  digest,
  capabilities: ['design:revision.commit'],
  trustAnchor: {
    format: 'selene-design-revision-trust-anchor/v1',
    issuer: 'issuer-a',
    audience: 'selene-desktop',
    grantId: 'grant-1',
    schemaRevision: 1,
    commandsDigest: 'd'.repeat(64)
  }
};
const revision = {
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
    compiler: {
      format: 'selene-compiler-identity/v1',
      compilerId: 'compiler-1',
      compilerDigest
    }
  },
  privacy: {
    format: 'selene-design-privacy/v1',
    classification: 'restricted',
    contentDigest: digest,
    promptDigest: 'b'.repeat(64),
    lifecycle: 'active',
    fields: [{ category: 'prompt', mode: 'redact', digest }],
    retention: { deleteAfter: '2026-07-26T22:01:00.000Z' },
    deletion: { action: 'tombstone', tombstoneDigest: digest },
    exportPolicyDigest: digest,
    auditCorrelationId: 'audit-1',
    exclusions: ['raw-prompt']
  }
};
const canonicalRevision = parseDesignRevision(revision);
const revisionCommitment = canonicalRevision.revisionCommitment;
const authority = {
  format: 'selene-design-revision-authority/v2',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  actorId: 'designer-a',
  commandId: 'command-1',
  policyId: 'design-policy',
  policyRevision: 1,
  policyDigest: digest,
  revisionId: 'revision-1',
  tupleBinding,
  revisionCommitment,
  capabilities: ['design:revision.commit'],
  grantId: 'grant-1',
  grantEpoch: 1,
  issuer: 'issuer-a',
  audience: 'selene-desktop',
  schemaRevision: 1,
  commandsDigest: 'd'.repeat(64),
  issuedAt: '2026-07-25T22:00:00.000Z',
  expiresAt: '2026-07-25T23:00:00.000Z'
};
const authorityFor = (revisionValue: unknown, commandId: string) => {
  const parsed = parseDesignRevision(revisionValue);
  return {
    ...authority,
    commandId,
    revisionId: parsed.revisionId,
    tupleBinding: parsed.tupleBinding,
    revisionCommitment: parsed.revisionCommitment
  };
};
const operationCapabilities = {
  preview: 'design:revision.preview',
  selection: 'design:revision.selection',
  inspect: 'design:revision.inspect',
  edit: 'design:revision.edit',
  proposal: 'design:revision.proposal',
  undo: 'design:revision.undo',
  baseline: 'design:revision.baseline',
  publish: 'design:revision.publish',
  handoff: 'design:revision.handoff'
} as const;
const state = {
  format: 'selene-design-revision-state/v1',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  policy,
  grantStatus: {
    format: 'selene-design-revision-grant-status/v1',
    grantId: 'grant-1',
    epoch: 1,
    state: 'active'
  },
  processedCommandIds: []
};
const node = {
  format: 'selene-compiler-node-identity/v2',
  projectId: 'project-a',
  nodeId: 'orders.root',
  compilerDigest,
  source: {
    format: 'selene-compiler-source-identity/v1',
    moduleId: 'orders-page',
    exportName: 'OrdersPage',
    astNodeId: 'orders.root',
    sourceDigest: digest,
    bindingDigest: digest
  },
  instance: {
    format: 'selene-compiler-rendered-instance-identity/v1',
    instanceId: 'orders-row-42',
    ancestry: ['orders.root', 'orders.list', 'orders.row'],
    repeat: { kind: 'collection-key', keyDigest: digest },
    slotId: 'orders.content',
    instanceDigest: compilerDigest
  }
};
const exportAuthority = {
  format: 'selene-design-revision-export-authority/v2',
  authorityId: 'export-grant-1',
  epoch: 1,
  issuer: 'issuer-a',
  audience: 'selene-desktop',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  revisionId: 'revision-1',
  tupleBinding,
  revisionCommitment,
  privacyBinding: createDesignRevisionPrivacyBinding(serialized(revision.privacy)),
  lifecycle: 'active',
  retentionDeleteAfter: '2026-07-26T22:01:00.000Z',
  policyDigest: digest,
  exportPolicyDigest: digest,
  issuedAt: '2026-07-25T22:00:00.000Z',
  expiresAt: '2026-07-25T23:00:00.000Z',
  capabilities: ['design:revision.export']
};
const exportHostState = {
  ...exportAuthority,
  format: 'selene-design-revision-export-host-state/v2',
  authorityBinding: createDesignRevisionExportAuthorityBinding(exportAuthority),
  grantStatus: {
    format: 'selene-design-revision-export-grant-status/v1',
    authorityId: 'export-grant-1',
    epoch: 1,
    state: 'active'
  }
};
const trustedExportPort = {
  verifyAndConsume: () => ({ kind: 'accepted' as const, commitment: exportHostState })
};

describe('public immutable design revision contract', () => {
  it('derives the complete project tuple binding and keeps node identity as a paired operation target', () => {
    const parsed = parseDesignRevision(revision);
    expect(parsed.tupleBinding).toContain('selene-design-revision-tuple-binding/v1');
    expect(parsed.revisionCommitment).toContain('selene-design-revision-commitment/v1');
    expect(createDesignRevisionCommitment(serialized(revision))).toBe(parsed.revisionCommitment);
    expect(parsed).not.toHaveProperty('contentDigest');
    expect(parsed.format).toBe('selene-design-revision/v2');
    expect(parsed.privacy.format).toBe('selene-design-privacy/v2');
    expect(parsed.privacy.exclusions).toEqual(
      [...designRevisionRequiredPrivacyExclusions, 'raw-prompt'].sort()
    );
    expect(parseDesignRevisionState(state).format).toBe('selene-design-revision-state/v2');
    expect(compileDesignRevisionPolicy(policy).format).toBe('selene-design-revision-policy/v2');
    expect(parsed.privacy.telemetry).toEqual({
      format: 'selene-design-telemetry-policy/v1',
      mode: 'disabled',
      consent: 'not-granted',
      export: 'denied',
      fields: []
    });
    expect(parsed.tuple).not.toHaveProperty('node');
    expect(parsed.tuple.deployment).toMatchObject({ state: 'unpublished', draftId: 'draft-1' });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseDesignRevision(parsed)).toEqual(parsed);

    const target = createDesignRevisionOperationTarget(parsed, node);
    expect(target).toMatchObject({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      revisionCommitment: parsed.revisionCommitment
    });
    expect(parseDesignRevisionOperationTarget(target, parsed)).toEqual(target);
    expect(() => parseDesignRevision({ ...parsed, tupleBinding: 'wrong' })).toThrow(
      DesignRevisionContractError
    );
    expect(() => parseDesignRevision({ ...parsed, projectId: 'project-b' })).toThrow(
      DesignRevisionContractError
    );
    expect(() =>
      createDesignRevisionOperationTarget(revision, { ...node, projectId: 'project-b' })
    ).toThrow(DesignRevisionContractError);
    expect(() =>
      createDesignRevisionOperationTarget(revision, {
        ...node,
        source: { ...node.source, sourceDigest: compilerDigest }
      })
    ).toThrow(DesignRevisionContractError);
    const repeatedTarget = createDesignRevisionOperationTarget(revision, {
      ...node,
      instance: {
        ...node.instance,
        instanceId: 'orders-row-43',
        repeat: { kind: 'occurrence', occurrence: 2 },
        instanceDigest: digest
      }
    });
    expect(repeatedTarget.node.source).toEqual(target.node.source);
    expect(repeatedTarget.node.instance).not.toEqual(target.node.instance);
    expect(() =>
      createDesignRevisionOperationTarget(revision, {
        ...node,
        instance: {
          ...node.instance,
          ancestry: Array.from({ length: 33 }, (_, index) => `node-${index}`)
        }
      })
    ).toThrow(DesignRevisionContractError);

    const trustedOperationState = commitDesignRevision(
      {
        ...state,
        format: 'selene-design-revision-state/v2',
        policy: {
          ...policy,
          format: 'selene-design-revision-policy/v2',
          capabilities: ['design:revision.commit', ...Object.values(operationCapabilities)]
        }
      },
      { format: 'selene-design-revision-command/v1', authority, revision },
      '2026-07-25T22:02:00.000Z'
    );
    for (const kind of [
      'preview',
      'selection',
      'inspect',
      'edit',
      'proposal',
      'undo',
      'baseline',
      'publish',
      'handoff'
    ] as const) {
      const operationAuthority = {
        ...authority,
        commandId: `operation-${kind}`,
        capabilities: [operationCapabilities[kind]]
      };
      const reference = createDesignRevisionOperationReference(
        parsed,
        operationAuthority,
        kind,
        trustedOperationState,
        '2026-07-25T22:03:00.000Z'
      );
      expect(
        parseDesignRevisionOperationReference(
          reference,
          parsed,
          operationAuthority,
          trustedOperationState,
          '2026-07-25T22:03:00.000Z'
        )
      ).toEqual(reference);
      expect(() =>
        parseDesignRevisionOperationReference(
          reference,
          parsed,
          operationAuthority,
          { ...trustedOperationState, projectId: 'project-b' },
          '2026-07-25T22:03:00.000Z'
        )
      ).toThrow(DesignRevisionContractError);
      expect(() =>
        parseDesignRevisionOperationReference(
          reference,
          parsed,
          operationAuthority,
          trustedOperationState,
          '2026-07-25T23:01:00.000Z'
        )
      ).toThrow(DesignRevisionContractError);
      expect(reference.revisionCommitment).toBe(parsed.revisionCommitment);
    }
    const editAuthority = {
      ...authority,
      commandId: 'operation-edit-negative',
      capabilities: ['design:revision.edit']
    };
    const stateWithoutEdit = {
      ...trustedOperationState,
      policy: {
        ...trustedOperationState.policy,
        capabilities: trustedOperationState.policy.capabilities.filter(
          (capability) => capability !== 'design:revision.edit'
        )
      }
    };
    for (const rejectedAuthority of [
      { ...editAuthority, expiresAt: '2026-07-25T22:02:30.000Z' },
      { ...editAuthority, revokedAt: '2026-07-25T22:02:30.000Z' },
      { ...editAuthority, grantEpoch: 2 },
      { ...editAuthority, issuer: 'wrong-issuer' },
      { ...editAuthority, commandsDigest: compilerDigest }
    ]) {
      expect(() =>
        createDesignRevisionOperationReference(
          parsed,
          rejectedAuthority,
          'edit',
          trustedOperationState,
          '2026-07-25T22:03:00.000Z'
        )
      ).toThrow(DesignRevisionContractError);
    }
    expect(() =>
      createDesignRevisionOperationReference(
        parsed,
        editAuthority,
        'edit',
        stateWithoutEdit,
        '2026-07-25T22:03:00.000Z'
      )
    ).toThrow(DesignRevisionContractError);
    expect(() =>
      createDesignRevisionOperationReference(
        parsed,
        editAuthority,
        'edit',
        {
          ...trustedOperationState,
          grantStatus: {
            ...trustedOperationState.grantStatus,
            state: 'revoked',
            revokedAt: '2026-07-25T22:02:30.000Z'
          }
        },
        '2026-07-25T22:03:00.000Z'
      )
    ).toThrow(DesignRevisionContractError);
    expect(() =>
      createDesignRevisionOperationReference(
        parsed,
        authority,
        'preview',
        trustedOperationState,
        '2026-07-25T22:03:00.000Z'
      )
    ).toThrow(DesignRevisionContractError);
    expect(() =>
      createDesignRevisionOperationReference(
        parsed,
        {
          ...authority,
          projectId: 'project-b',
          capabilities: ['design:revision.edit']
        },
        'edit',
        trustedOperationState,
        '2026-07-25T22:03:00.000Z'
      )
    ).toThrow(DesignRevisionContractError);
    expect(() =>
      parseDesignRevision({
        ...revision,
        format: 'selene-design-revision/v2',
        privacy: {
          ...revision.privacy,
          format: 'selene-design-privacy/v2',
          exclusions: designRevisionRequiredPrivacyExclusions.filter(
            (value) => value !== 'source-text'
          ),
          telemetry: {
            format: 'selene-design-telemetry-policy/v1',
            mode: 'disabled',
            consent: 'not-granted',
            export: 'denied',
            fields: []
          }
        }
      })
    ).toThrow(DesignRevisionContractError);
    expect(
      parseDesignRevision({
        ...revision,
        privacy: {
          ...revision.privacy,
          telemetry: {
            format: 'selene-design-telemetry-policy/v1',
            mode: 'local-redacted',
            consent: 'explicit',
            export: 'denied',
            fields: ['performance', 'geometry']
          }
        }
      }).privacy.telemetry
    ).toMatchObject({
      mode: 'local-redacted',
      consent: 'explicit',
      export: 'denied',
      fields: ['geometry', 'performance']
    });
  });

  it('keeps exported binding helpers descriptor-safe and bounded for hostile consumer input', () => {
    expect(createDesignRevisionPrivacyBinding(serialized(revision.privacy))).toContain(
      'selene-design-revision-privacy-binding/v2'
    );
    expect(createDesignRevisionTupleBinding(serialized(revision.tuple))).toBe(tupleBinding);
    let getterReads = 0;
    const getterPrivacy = Object.defineProperty({ ...revision.privacy }, 'format', {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error('must not execute');
      }
    });
    expect(() => createDesignRevisionPrivacyBinding(getterPrivacy as unknown as string)).toThrow(
      DesignRevisionContractError
    );
    expect(getterReads).toBe(0);

    const metaTrapCalls = {
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0
    };
    const metaTrapProxy = new Proxy(
      {},
      {
        get() {
          metaTrapCalls.get += 1;
          throw new Error('must not execute');
        },
        getOwnPropertyDescriptor() {
          metaTrapCalls.getOwnPropertyDescriptor += 1;
          throw new Error('must not execute');
        },
        getPrototypeOf() {
          metaTrapCalls.getPrototypeOf += 1;
          throw new Error('must not execute');
        },
        ownKeys() {
          metaTrapCalls.ownKeys += 1;
          throw new Error('must not execute');
        }
      }
    );
    expect(() => createDesignRevisionPrivacyBinding(metaTrapProxy as unknown as string)).toThrow(
      DesignRevisionContractError
    );
    expect(() => createDesignRevisionTupleBinding(metaTrapProxy as unknown as string)).toThrow(
      DesignRevisionContractError
    );
    expect(metaTrapCalls).toEqual({
      get: 0,
      getOwnPropertyDescriptor: 0,
      getPrototypeOf: 0,
      ownKeys: 0
    });

    const inheritedPrivacy = Object.assign(Object.create({ inherited: true }), revision.privacy);
    expect(() => createDesignRevisionPrivacyBinding(inheritedPrivacy as unknown as string)).toThrow(
      DesignRevisionContractError
    );
    const cyclicTuple = { ...revision.tuple } as Record<string, unknown>;
    cyclicTuple.preview = cyclicTuple;
    expect(() => createDesignRevisionTupleBinding(cyclicTuple as unknown as string)).toThrow(
      DesignRevisionContractError
    );
    expect(() =>
      createDesignRevisionPrivacyBinding({
        ...revision.privacy,
        fields: Array.from({ length: 10_001 }, () => 0)
      } as unknown as string)
    ).toThrow(DesignRevisionContractError);
    expect(() =>
      createDesignRevisionPrivacyBinding(
        serialized({
          ...revision.privacy,
          fields: Array.from({ length: 10_001 }, () => 0)
        })
      )
    ).toThrow(DesignRevisionContractError);
    expect(() => createDesignRevisionCommitment('x'.repeat(1_000_001))).toThrow(
      DesignRevisionContractError
    );
    expect(() => createDesignRevisionCommitment('é'.repeat(600_000))).toThrow(
      DesignRevisionContractError
    );
  });

  it('rejects hostile keys and aggregate snapshot pressure before copying consumer data', () => {
    expect(() => compileDesignRevisionPolicy({ ...policy, provider: 'hosted' })).toThrow(
      DesignRevisionContractError
    );
    const hostile = Array.from({ length: 10_001 }, () => 'x');
    expect(() => compileDesignRevisionPolicy({ ...policy, capabilities: hostile })).toThrow(
      DesignRevisionContractError
    );
    const sparse: string[] = [];
    sparse.length = 100_000_000;
    expect(() => compileDesignRevisionPolicy({ ...policy, capabilities: sparse })).toThrow(
      DesignRevisionContractError
    );
    const nestedCommandIds = Array.from({ length: 10_000 }, () => ['x'.repeat(128)]);
    expect(
      commitDesignRevisionOutcome(
        { ...state, processedCommandIds: nestedCommandIds },
        { format: 'selene-design-revision-command/v1', authority, revision },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('invalid');
    const packedCommandIds = Array.from({ length: 10_000 }, () => ({ id: 'x'.repeat(128) }));
    expect(
      commitDesignRevisionOutcome(
        { ...state, processedCommandIds: packedCommandIds },
        { format: 'selene-design-revision-command/v1', authority, revision },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('invalid');

    let accessorReads = 0;
    const accessorRevision = Object.defineProperty({ ...revision }, 'format', {
      enumerable: true,
      get() {
        accessorReads += 1;
        throw new Error('host accessor must not escape');
      }
    });
    expect(() => parseDesignRevision(accessorRevision)).toThrow(DesignRevisionContractError);
    expect(accessorReads).toBe(0);
    expect(() => parseDesignRevision({ ...revision, revisionId: 'x'.repeat(1_000_001) })).toThrow(
      DesignRevisionContractError
    );
    const excessiveProperties = Object.fromEntries(
      Array.from({ length: 10_001 }, (_, index) => [`property-${index}`, index])
    );
    expect(() => parseDesignRevision(excessiveProperties)).toThrow(DesignRevisionContractError);

    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('host proxy trap must not escape');
        }
      }
    );
    expect(() => parseDesignRevision(throwingProxy)).toThrow(DesignRevisionContractError);
    expect(commitDesignRevisionOutcome(state, throwingProxy, '2026-07-25T22:02:00.000Z').kind).toBe(
      'invalid'
    );
  });

  it('keeps host grant negotiation exact and supports a distinct deployed identity', () => {
    const offered = {
      format: 'selene-design-revision-host-capabilities/v2',
      issuer: 'issuer-a',
      audience: 'selene-desktop',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      grantId: 'grant-1',
      grantEpoch: 1,
      schemaRevision: 1,
      commandsDigest: 'd'.repeat(64),
      revisionId: 'revision-1',
      tupleBinding,
      revisionCommitment,
      policyRevision: 1,
      issuedAt: '2026-07-25T22:00:00.000Z',
      expiresAt: '2026-07-25T23:00:00.000Z',
      capabilities: ['design:revision.commit']
    };
    const expectation = {
      format: 'selene-design-revision-host-negotiation-expectation/v2',
      tenantId: 'tenant-a',
      projectId: 'project-a',
      trustAnchor: policy.trustAnchor,
      grantStatus: state.grantStatus,
      policyRevision: 1,
      revisionId: 'revision-1',
      tupleBinding,
      revisionCommitment,
      capabilities: ['design:revision.commit']
    };
    expect(
      negotiateDesignRevisionHostCapabilities(offered, expectation, '2026-07-25T22:02:00.000Z').kind
    ).toBe('accepted');
    expect(
      negotiateDesignRevisionHostCapabilities(
        { ...offered, audience: 'other-app' },
        expectation,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      negotiateDesignRevisionHostCapabilities(
        { ...offered, tenantId: 'tenant-b' },
        expectation,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      negotiateDesignRevisionHostCapabilities(
        { ...offered, projectId: 'project-b' },
        expectation,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      negotiateDesignRevisionHostCapabilities(
        offered,
        {
          ...expectation,
          grantStatus: {
            ...state.grantStatus,
            state: 'revoked',
            revokedAt: '2026-07-25T22:01:00.000Z'
          }
        },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      parseDesignRevision({
        ...revision,
        tuple: {
          ...revision.tuple,
          deployment: {
            format: 'selene-deployment-identity/v1',
            state: 'deployed',
            deploymentId: 'deploy-1',
            manifestDigest: digest
          }
        }
      }).tuple.deployment.state
    ).toBe('deployed');
  });

  it('returns typed stale, replay, unauthorized, conflict, recovery, and unsupported outcomes', () => {
    const command = { format: 'selene-design-revision-command/v1', authority, revision };
    const next = commitDesignRevision(state, command, '2026-07-25T22:02:00.000Z');
    expect(next.head?.revision).toEqual(canonicalRevision);
    expect(next.head?.revisionCommitment).toBe(canonicalRevision.revisionCommitment);
    expect(parseDesignRevision(next.head?.revision).revisionCommitment).toBe(
      next.head?.revisionCommitment
    );
    expect(
      commitDesignRevisionOutcome(
        { ...next, format: 'selene-design-revision-state/v1' },
        command,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unsupported');
    expect(
      commitDesignRevisionOutcome(
        { ...state, processedCommandIds: ['legacy-command'] },
        command,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unsupported');
    const { revisionCommitment: omittedCommitment, ...legacyAuthorityFields } = authority;
    void omittedCommitment;
    expect(
      commitDesignRevisionOutcome(
        state,
        {
          ...command,
          authority: {
            ...legacyAuthorityFields,
            format: 'selene-design-revision-authority/v1'
          }
        },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unsupported');
    expect(commitDesignRevisionOutcome(next, command, '2026-07-25T22:02:00.000Z').kind).toBe(
      'replay'
    );
    if (next.head === undefined) throw new Error('accepted revision must persist a head');
    const { revision: omittedRevision, ...incompleteHead } = next.head;
    void omittedRevision;
    expect(
      commitDesignRevisionOutcome(
        { ...next, head: incompleteHead },
        command,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('invalid');
    expect(
      commitDesignRevisionOutcome(
        state,
        { ...command, authority: { ...authority, tenantId: 'tenant-b' } },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      commitDesignRevisionOutcome(
        state,
        { ...command, authority: { ...authority, projectId: 'project-b' } },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      commitDesignRevisionOutcome(
        {
          ...state,
          grantStatus: {
            ...state.grantStatus,
            state: 'revoked',
            revokedAt: '2026-07-25T22:01:00.000Z'
          }
        },
        command,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      commitDesignRevisionOutcome(
        state,
        { ...command, authority: { ...authority, issuer: 'untrusted-issuer' } },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      commitDesignRevisionOutcome(
        state,
        { ...command, authority: { ...authority, policyDigest: compilerDigest } },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('stale');
    expect(
      commitDesignRevisionOutcome(
        state,
        {
          ...command,
          authority: {
            ...authority,
            capabilities: ['design:revision.commit', 'design:revision.publish']
          }
        },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('stale');
    const wrongParentRevision = {
      ...revision,
      revisionId: 'revision-2',
      sequence: 2,
      parentRevisionId: 'other'
    };
    expect(
      commitDesignRevisionOutcome(
        next,
        {
          ...command,
          authority: authorityFor(wrongParentRevision, 'command-2'),
          revision: wrongParentRevision
        },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('conflict');
    expect(
      commitDesignRevisionOutcome(
        state,
        { ...command, format: 'unsupported/v1' },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unsupported');
    expect(
      commitDesignRevisionOutcome(
        {
          ...state,
          processedCommandIds: Array.from({ length: 10_000 }, (_, index) =>
            `prior-${index}`.padEnd(128, 'x')
          )
        },
        command,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('recovery');
    expect(commitDesignRevisionOutcome({}, {}, '2026-07-25T22:02:00.000Z').kind).toBe('invalid');
  });

  it('records auditable redaction and tombstone transitions on the privacy record itself', () => {
    const redacted = transitionDesignPrivacyLifecycle(revision.privacy, {
      format: 'selene-design-privacy-transition/v1',
      from: 'active',
      to: 'redacted',
      occurredAt: '2026-07-25T22:03:00.000Z',
      auditCorrelationId: 'audit-1'
    });
    expect(redacted.kind).toBe('preflight');
    expect(
      transitionDesignPrivacyLifecycle(revision.privacy, {
        format: 'selene-design-privacy-transition/v1',
        from: 'active',
        to: 'tombstoned',
        occurredAt: '2026-07-25T22:04:00.000Z',
        auditCorrelationId: 'audit-1',
        tombstoneDigest: digest
      }).kind
    ).toBe('preflight');
    expect(
      transitionDesignPrivacyLifecycle(revision.privacy, {
        format: 'selene-design-privacy-transition/v1',
        from: 'active',
        to: 'redacted',
        occurredAt: '2026-07-25T22:05:00.000Z',
        auditCorrelationId: 'another-audit'
      }).kind
    ).toBe('conflict');
  });

  it('binds lifecycle and retention to commit and export eligibility', () => {
    const command = { format: 'selene-design-revision-command/v1', authority, revision };
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        trustedExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('eligible');
    class ClassVerificationPort {
      verifyAndConsume() {
        return { kind: 'accepted' as const, commitment: exportHostState };
      }
    }
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        new ClassVerificationPort(),
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('eligible');
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        () => ({ kind: 'accepted' as const, commitment: exportHostState }),
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('eligible');
    let verifierAccessorReads = 0;
    const accessorPort = Object.defineProperty({}, 'verifyAndConsume', {
      enumerable: true,
      get() {
        verifierAccessorReads += 1;
        throw new Error('host verifier accessor must not escape');
      }
    });
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        accessorPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(verifierAccessorReads).toBe(0);
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error('host verifier proxy trap must not escape');
            }
          }
        ),
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        {
          verifyAndConsume() {
            throw new Error('host verifier failure must not escape');
          }
        },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        {
          ...exportAuthority,
          exportPolicyDigest: compilerDigest
        },
        trustedExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    const expired = {
      ...revision,
      privacy: {
        ...revision.privacy,
        lifecycle: 'expired',
        lifecycleAudit: {
          format: 'selene-design-privacy-transition/v1',
          from: 'active',
          to: 'expired',
          occurredAt: '2026-07-25T22:03:00.000Z',
          auditCorrelationId: 'audit-1'
        }
      }
    };
    expect(
      commitDesignRevisionOutcome(
        state,
        { ...command, revision: expired },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    const expiredAuthority = {
      ...exportAuthority,
      revisionCommitment: parseDesignRevision(expired).revisionCommitment,
      privacyBinding: createDesignRevisionPrivacyBinding(serialized(expired.privacy)),
      lifecycle: 'expired' as const
    };
    const expiredHostState = {
      ...exportHostState,
      ...expiredAuthority,
      format: 'selene-design-revision-export-host-state/v2' as const,
      authorityBinding: createDesignRevisionExportAuthorityBinding(expiredAuthority)
    };
    let verificationCalls = 0;
    let consumedAuthorityBinding: string | undefined;
    const atomicExportPort = {
      verifyAndConsume: (request: { readonly authorityBinding: string }) => {
        verificationCalls += 1;
        if (request.authorityBinding === expiredHostState.authorityBinding)
          return {
            kind: 'ineligible' as const,
            code: 'lifecycle' as const,
            commitment: expiredHostState
          };
        if (request.authorityBinding !== exportHostState.authorityBinding)
          return { kind: 'unauthorized' as const };
        if (consumedAuthorityBinding === request.authorityBinding)
          return { kind: 'replay' as const };
        consumedAuthorityBinding = request.authorityBinding;
        return { kind: 'accepted' as const, commitment: exportHostState };
      }
    };
    expect(
      evaluateDesignRevisionExportEligibility(
        expired,
        expiredAuthority,
        atomicExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('ineligible');
    expect(
      evaluateDesignRevisionExportEligibility(
        expired,
        expiredAuthority,
        atomicExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('ineligible');
    expect(verificationCalls).toBe(2);
    expect(consumedAuthorityBinding).toBeUndefined();
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        {
          verifyAndConsume: () => ({
            kind: 'accepted' as const,
            commitment: {
              ...exportHostState,
              grantStatus: {
                ...exportHostState.grantStatus,
                state: 'revoked',
                revokedAt: '2026-07-25T22:01:00.000Z'
              }
            }
          })
        },
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        { ...exportAuthority, policyDigest: undefined },
        atomicExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(verificationCalls).toBe(2);
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        { ...exportAuthority, policyDigest: compilerDigest },
        atomicExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('unauthorized');
    expect(verificationCalls).toBe(3);
    expect(consumedAuthorityBinding).toBeUndefined();
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        atomicExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('eligible');
    expect(verificationCalls).toBe(4);
    expect(consumedAuthorityBinding).toBe(exportHostState.authorityBinding);
    expect(
      evaluateDesignRevisionExportEligibility(
        revision,
        exportAuthority,
        atomicExportPort,
        '2026-07-25T22:02:00.000Z'
      ).kind
    ).toBe('replay');
    expect(verificationCalls).toBe(5);
  });

  it('binds a lifecycle change to the trusted prior head and rejects revived or altered privacy', () => {
    const first = commitDesignRevision(
      state,
      { format: 'selene-design-revision-command/v1', authority, revision },
      '2026-07-25T22:02:00.000Z'
    );
    const priorPrivacyBinding = createDesignRevisionPrivacyBinding(serialized(revision.privacy));
    const redacted = {
      ...revision,
      revisionId: 'revision-2',
      parentRevisionId: 'revision-1',
      sequence: 2,
      createdAt: '2026-07-25T22:04:00.000Z',
      privacy: {
        ...revision.privacy,
        lifecycle: 'redacted',
        lifecycleAudit: {
          format: 'selene-design-privacy-transition/v1',
          from: 'active',
          to: 'redacted',
          occurredAt: '2026-07-25T22:03:00.000Z',
          auditCorrelationId: 'audit-1',
          priorRevisionId: 'revision-1',
          priorTupleBinding: tupleBinding,
          priorPrivacyBinding
        }
      }
    };
    const redactionAuthority = authorityFor(redacted, 'command-2');
    const redactedState = commitDesignRevision(
      first,
      {
        format: 'selene-design-revision-command/v1',
        authority: redactionAuthority,
        revision: redacted
      },
      '2026-07-25T22:05:00.000Z'
    );
    expect(redactedState.head?.privacy.lifecycle).toBe('redacted');
    const alteredPrivacy = {
      ...redacted,
      privacy: { ...redacted.privacy, exportPolicyDigest: compilerDigest }
    };
    expect(
      commitDesignRevisionOutcome(
        first,
        {
          format: 'selene-design-revision-command/v1',
          authority: authorityFor(alteredPrivacy, 'command-2'),
          revision: alteredPrivacy
        },
        '2026-07-25T22:05:00.000Z'
      ).kind
    ).toBe('conflict');
    const revived = {
      ...redacted,
      revisionId: 'revision-3',
      parentRevisionId: 'revision-2',
      sequence: 3,
      createdAt: '2026-07-25T22:06:00.000Z',
      privacy: { ...revision.privacy }
    };
    expect(
      commitDesignRevisionOutcome(
        redactedState,
        {
          format: 'selene-design-revision-command/v1',
          authority: authorityFor(revived, 'command-3'),
          revision: revived
        },
        '2026-07-25T22:06:00.000Z'
      ).kind
    ).toBe('unauthorized');
  });

  it('commits an authorized terminal transition once, then blocks later revisions', () => {
    const first = commitDesignRevision(
      state,
      { format: 'selene-design-revision-command/v1', authority, revision },
      '2026-07-25T22:02:00.000Z'
    );
    const terminal = {
      ...revision,
      revisionId: 'revision-terminal',
      parentRevisionId: 'revision-1',
      sequence: 2,
      createdAt: '2026-07-25T22:04:00.000Z',
      privacy: {
        ...revision.privacy,
        lifecycle: 'tombstoned',
        lifecycleAudit: {
          format: 'selene-design-privacy-transition/v1',
          from: 'active',
          to: 'tombstoned',
          occurredAt: '2026-07-25T22:03:00.000Z',
          auditCorrelationId: 'audit-1',
          tombstoneDigest: digest,
          priorRevisionId: 'revision-1',
          priorTupleBinding: tupleBinding,
          priorPrivacyBinding: createDesignRevisionPrivacyBinding(serialized(revision.privacy))
        }
      }
    };
    const terminalAuthority = authorityFor(terminal, 'command-terminal');
    const terminalState = commitDesignRevision(
      first,
      {
        format: 'selene-design-revision-command/v1',
        authority: terminalAuthority,
        revision: terminal
      },
      '2026-07-25T22:05:00.000Z'
    );
    expect(terminalState.head?.privacy.lifecycle).toBe('tombstoned');
    expect(
      commitDesignRevisionOutcome(
        terminalState,
        {
          format: 'selene-design-revision-command/v1',
          authority: terminalAuthority,
          revision: terminal
        },
        '2026-07-25T22:05:00.000Z'
      ).kind
    ).toBe('unauthorized');
  });
});
