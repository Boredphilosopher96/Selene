import { describe, expect, it } from 'vitest';
import {
  EnterpriseSecurityError,
  ManagedKeyError,
  InMemoryRevisionStore,
  InMemorySiemOutbox,
  activateSignedPolicy,
  activateBreakGlass,
  allowLocalAccess,
  authorizeManagedKeyUse,
  canDeleteAfterRetention,
  compileEnterprisePolicy,
  createTrustedSessionEvidence,
  encryptWithManagedKey,
  deliverSiemBatch,
  enterpriseSecurityFormat,
  evaluateExternalAccess,
  protectContent
} from './enterprise-security';

const now = '2026-07-24T12:00:00.000Z';
const policyDigest = 'a'.repeat(64);
const entitlementDigest = 'b'.repeat(64);
const policyInput = {
  format: enterpriseSecurityFormat,
  policyId: 'baseline',
  policyVersion: 2,
  tenantId: 'acme',
  audience: 'selene-api',
  capabilities: ['selene:workspace.read'],
  residency: ['us-central'],
  allowedIpCidrs: ['10.0.0.0/8', '2001:db8::/32'],
  sessionMaxAgeSeconds: 3600,
  entitlementGraceSeconds: 60
};
const unsignedPolicy = compileEnterprisePolicy(policyInput);

async function signedPolicy() {
  let state:
    | {
        readonly revision: number;
        readonly revoked: boolean;
        readonly digest: string;
        readonly expiresAt: string;
      }
    | undefined;
  return activateSignedPolicy(
    {
      format: 'selene-signed-policy/v1',
      organizationId: 'acme',
      revision: 1,
      issuedAt: '2026-07-24T11:00:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      policy: policyInput,
      digest: policyDigest,
      signature: 'signature',
      keyId: 'key-1'
    },
    now,
    { verify: async () => ({ verified: true, digest: policyDigest }) },
    {
      read: async () => state,
      compareAndSet: async (_organization, _policy, _expected, next) => {
        state = next;
        return true;
      }
    }
  );
}

function request(revision = 3): unknown {
  return {
    capability: 'selene:workspace.read',
    tenantId: 'acme',
    audience: 'selene-api',
    resource: 'workspace-1',
    residency: 'us-central',
    now,
    session: createTrustedSessionEvidence({
      source: 'host-trusted/v1',
      subjectId: 'ada',
      sessionId: 'session-1',
      ipAddress: '10.1.2.3',
      issuedAt: '2026-07-24T11:30:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      active: true,
      revoked: false,
      accessVersion: 1,
      sessionVersion: 1
    }),
    entitlement: {
      format: 'selene-external-entitlement/v2',
      entitlementVersion: 1,
      tenantId: 'acme',
      providerId: 'okta',
      audience: 'selene-api',
      resource: 'workspace-1',
      policyId: 'baseline',
      policyVersion: 2,
      subjectId: 'ada',
      revision,
      issuedAt: '2026-07-24T11:00:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      capabilities: ['selene:workspace.read'],
      digest: entitlementDigest,
      signature: 'signed-payload',
      keyId: 'kms-reference'
    }
  };
}

const verifier = { verify: async () => true };
const breakGlassScope = {
  tenantId: 'acme',
  audience: 'selene-api',
  policyId: 'baseline',
  policyVersion: 2
};

describe('enterprise security v2', () => {
  it('leaves local OSS access unrestricted with no account or license check', () => {
    expect(allowLocalAccess()).toEqual({ allowed: true });
    expect(Object.isFrozen(allowLocalAccess())).toBe(true);
  });

  it('never treats an unsigned compiled policy as external authorization', async () => {
    await expect(
      evaluateExternalAccess(unsignedPolicy, request(), verifier, new InMemoryRevisionStore())
    ).resolves.toEqual({ allowed: false, reason: 'invalid' });
  });

  it('validates and freezes policy once, rejecting hostile CIDRs and mutable input', () => {
    const mutable = {
      format: enterpriseSecurityFormat,
      policyId: 'safe',
      policyVersion: 1,
      tenantId: 'acme',
      audience: 'selene-api',
      capabilities: ['selene:workspace.read'],
      residency: ['us-central'],
      allowedIpCidrs: ['10.0.0.0/8'],
      sessionMaxAgeSeconds: 60
    };
    const compiled = compileEnterprisePolicy(mutable);
    mutable.capabilities[0] = 'evil:everything';
    expect(compiled.capabilities).toEqual(['selene:workspace.read']);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(() => compileEnterprisePolicy(null)).toThrow(EnterpriseSecurityError);
    expect(() => compileEnterprisePolicy({ ...mutable, allowedIpCidrs: ['999.0.0.0/8'] })).toThrow(
      /IP address/
    );
    expect(() => compileEnterprisePolicy({ ...mutable, allowedIpCidrs: ['10.0.0.1/8'] })).toThrow(
      /canonical/
    );
    expect(() =>
      compileEnterprisePolicy({ ...mutable, allowedIpCidrs: ['10.0.0.0/8', '10.0.0.0/8'] })
    ).toThrow(/duplicates/);
  });

  it('samples public policy data once and rejects getters, sparse arrays, and unknown fields', () => {
    let getterCalls = 0;
    const accessorPolicy = Object.defineProperty({ ...policyInput }, 'tenantId', {
      get() {
        getterCalls += 1;
        return 'acme';
      }
    });
    expect(() => compileEnterprisePolicy(accessorPolicy)).toThrow(/accessor/);
    expect(getterCalls).toBe(0);
    const sparseCapabilities = ['selene:workspace.read'] as string[];
    sparseCapabilities.length = 2;
    expect(() =>
      compileEnterprisePolicy({ ...policyInput, capabilities: sparseCapabilities })
    ).toThrow(/dense data array/);
    expect(() => compileEnterprisePolicy({ ...policyInput, unexpected: true })).toThrow(
      /too many fields/
    );
    class PolicyShape {
      public readonly format = enterpriseSecurityFormat;
    }
    expect(() => compileEnterprisePolicy(new PolicyShape())).toThrow(/must be an object/);
    const subclass = new Array('selene:workspace.read');
    const ArraySubclass = class extends Array {};
    Object.setPrototypeOf(subclass, ArraySubclass.prototype);
    expect(() => compileEnterprisePolicy({ ...policyInput, capabilities: subclass })).toThrow(
      /must be an array|exact Array/
    );
    const hidden = ['selene:workspace.read'];
    Object.defineProperty(hidden, '0', { value: hidden[0], enumerable: false });
    expect(() => compileEnterprisePolicy({ ...policyInput, capabilities: hidden })).toThrow(
      /dense data array/
    );
    const symbol = ['selene:workspace.read'];
    Object.defineProperty(symbol, Symbol('hidden'), { value: true, enumerable: true });
    expect(() => compileEnterprisePolicy({ ...policyInput, capabilities: symbol })).toThrow(
      /dense data array/
    );
    const hiddenRecord = { ...policyInput };
    Object.defineProperty(hiddenRecord, 'tenantId', { value: 'acme', enumerable: false });
    expect(() => compileEnterprisePolicy(hiddenRecord)).toThrow(/too many fields|accessor/);
    const trapped = new Proxy(
      { ...policyInput },
      {
        ownKeys: () => {
          throw new Error('trap');
        }
      }
    );
    expect(() => compileEnterprisePolicy(trapped)).toThrow(/must be an object/);
  });

  it('fails closed for malformed, future, verifier-error, and cross-tenant external input', async () => {
    const policy = await signedPolicy();
    const store = new InMemoryRevisionStore();
    const future = request() as Record<string, unknown>;
    future.session = createTrustedSessionEvidence({
      source: 'host-trusted/v1',
      subjectId: 'ada',
      sessionId: 'session-1',
      ipAddress: '10.1.2.3',
      issuedAt: '2026-07-24T12:00:01.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      active: true,
      revoked: false,
      accessVersion: 1,
      sessionVersion: 1
    });
    const wrongTenant = request() as { entitlement: Record<string, unknown> };
    wrongTenant.entitlement.tenantId = 'other';
    await expect(evaluateExternalAccess(policy, null, verifier, store)).resolves.toEqual({
      allowed: false,
      reason: 'invalid'
    });
    await expect(evaluateExternalAccess(policy, future, verifier, store)).resolves.toEqual({
      allowed: false,
      reason: 'denied'
    });
    await expect(
      evaluateExternalAccess(
        policy,
        request(),
        {
          verify: async () => {
            throw new Error('provider unavailable');
          }
        },
        store
      )
    ).resolves.toEqual({ allowed: false, reason: 'provider-unavailable' });
    await expect(evaluateExternalAccess(policy, wrongTenant, verifier, store)).resolves.toEqual({
      allowed: false,
      reason: 'invalid'
    });
  });

  it('uses tenant/provider/audience/resource revision namespaces and never evicts downgrade guards', async () => {
    const policy = await signedPolicy();
    const store = new InMemoryRevisionStore(1);
    await expect(evaluateExternalAccess(policy, request(3), verifier, store)).resolves.toEqual({
      allowed: true
    });
    await expect(evaluateExternalAccess(policy, request(2), verifier, store)).resolves.toEqual({
      allowed: false,
      reason: 'revoked'
    });
    await store.revoke(
      {
        tenantId: 'acme',
        providerId: 'okta',
        audience: 'selene-api',
        subjectId: 'ada',
        resource: 'workspace-1'
      },
      3
    );
    await expect(evaluateExternalAccess(policy, request(3), verifier, store)).resolves.toEqual({
      allowed: false,
      reason: 'revoked'
    });
    const otherResource = request(4) as Record<string, unknown>;
    otherResource.resource = 'workspace-2';
    (otherResource.entitlement as Record<string, unknown>).resource = 'workspace-2';
    await expect(evaluateExternalAccess(policy, otherResource, verifier, store)).resolves.toEqual({
      allowed: false,
      reason: 'store-unavailable'
    });
  });

  it('accepts outage grace only for a prior verified, unrevoked revision and validates store output', async () => {
    const policy = await signedPolicy();
    const store = new InMemoryRevisionStore();
    await expect(evaluateExternalAccess(policy, request(3), verifier, store)).resolves.toEqual({
      allowed: true
    });
    await expect(
      evaluateExternalAccess(policy, request(3), { verify: async () => 'unavailable' }, store)
    ).resolves.toEqual({ allowed: true });
    await store.revoke(
      {
        tenantId: 'acme',
        providerId: 'okta',
        audience: 'selene-api',
        subjectId: 'ada',
        resource: 'workspace-1'
      },
      3
    );
    await expect(
      evaluateExternalAccess(policy, request(3), { verify: async () => 'unavailable' }, store)
    ).resolves.toEqual({ allowed: false, reason: 'provider-unavailable' });
    const hostileStore = {
      read: async () => ({
        revision: 'three',
        revoked: false,
        digest: entitlementDigest,
        expiresAt: '2026-07-24T13:00:00.000Z'
      }),
      compareAndSet: async () => true,
      revoke: async () => ({
        revision: 1,
        revoked: false,
        digest: entitlementDigest,
        expiresAt: now
      })
    };
    await expect(
      evaluateExternalAccess(policy, request(), verifier, hostileStore)
    ).resolves.toEqual({
      allowed: false,
      reason: 'store-unavailable'
    });
  });

  it('validates signed-policy storage results before activating the signed policy', async () => {
    const envelope = {
      format: 'selene-signed-policy/v1' as const,
      organizationId: 'acme',
      revision: 1,
      issuedAt: '2026-07-24T11:00:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      policy: {
        format: enterpriseSecurityFormat,
        policyId: 'signed',
        policyVersion: 1,
        tenantId: 'acme',
        audience: 'selene-api',
        capabilities: ['selene:workspace.read'],
        residency: ['us-central'],
        allowedIpCidrs: ['10.0.0.0/8'],
        sessionMaxAgeSeconds: 60
      },
      digest: policyDigest,
      signature: 'signature',
      keyId: 'key-1'
    };
    await expect(
      activateSignedPolicy(
        envelope,
        now,
        { verify: async () => ({ verified: true, digest: policyDigest }) },
        {
          read: async () => ({ revision: 1, revoked: 'false' }) as never,
          compareAndSet: async () => true
        }
      )
    ).rejects.toThrow(/revoked must be a boolean/);
  });

  it('snapshots signed policy input before verification and retains non-secret provenance', async () => {
    const envelope = {
      format: 'selene-signed-policy/v1' as const,
      organizationId: 'acme',
      revision: 3,
      issuedAt: '2026-07-24T11:00:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      policy: {
        format: enterpriseSecurityFormat,
        policyId: 'signed',
        policyVersion: 3,
        tenantId: 'acme',
        audience: 'selene-api',
        capabilities: ['selene:workspace.read'],
        residency: ['us-central'],
        allowedIpCidrs: ['10.0.0.0/8'],
        sessionMaxAgeSeconds: 60
      },
      digest: policyDigest,
      signature: 'signature',
      keyId: 'key-3'
    };
    const activated = await activateSignedPolicy(
      envelope,
      now,
      {
        verify: async (verified) => {
          (envelope.policy.capabilities as string[])[0] = 'evil:everything';
          expect(verified.policy).toMatchObject({
            capabilities: ['selene:workspace.read']
          });
          return { verified: true, digest: policyDigest };
        }
      },
      {
        read: async () => undefined,
        compareAndSet: async () => true
      }
    );
    expect(activated.capabilities).toEqual(['selene:workspace.read']);
    expect(activated.signedPolicy).toEqual({
      format: 'selene-signed-policy/v1',
      organizationId: 'acme',
      revision: 3,
      issuedAt: '2026-07-24T11:00:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      digest: policyDigest,
      keyId: 'key-3'
    });
    expect(Object.isFrozen(activated.signedPolicy)).toBe(true);
  });

  it('requires the verifier digest to match and never reactivates a revoked digest binding', async () => {
    const envelope = {
      format: 'selene-signed-policy/v1' as const,
      organizationId: 'acme',
      revision: 4,
      issuedAt: '2026-07-24T11:00:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      policy: {
        format: enterpriseSecurityFormat,
        policyId: 'signed',
        policyVersion: 4,
        tenantId: 'acme',
        audience: 'selene-api',
        capabilities: ['selene:workspace.read'],
        residency: ['us-central'],
        allowedIpCidrs: ['10.0.0.0/8'],
        sessionMaxAgeSeconds: 60
      },
      digest: policyDigest,
      signature: 'signature',
      keyId: 'key-4'
    };
    await expect(
      activateSignedPolicy(
        envelope,
        now,
        { verify: async () => ({ verified: true, digest: 'b'.repeat(64) }) },
        { read: async () => undefined, compareAndSet: async () => true }
      )
    ).rejects.toThrow(/digest/);
    await expect(
      activateSignedPolicy(
        envelope,
        now,
        { verify: async () => ({ verified: true, digest: policyDigest }) },
        {
          read: async () => ({
            revision: 4,
            revoked: true,
            digest: policyDigest,
            expiresAt: '2026-07-24T13:00:00.000Z'
          }),
          compareAndSet: async () => true
        }
      )
    ).rejects.toThrow(/revoked/);
  });

  it('keeps DLP scanning bounded and rejects malformed scanner output without compiling regexes', async () => {
    await expect(
      protectContent(
        {
          format: enterpriseSecurityFormat,
          maxContentBytes: 32,
          maxFindings: 2,
          watermarkTemplate: 'owner:{subject}'
        },
        { scan: async () => ({ redactedContent: 'a [redacted]', detectionIds: ['secret'] }) },
        'acme',
        'ada',
        'a secret'
      )
    ).resolves.toEqual({ text: 'a [redacted]', watermark: 'owner:ada', detections: ['secret'] });
    await expect(
      protectContent(
        { format: enterpriseSecurityFormat, maxContentBytes: 3, maxFindings: 1 },
        { scan: async () => ({ redactedContent: '', detectionIds: [] }) },
        'acme',
        'ada',
        'four'
      )
    ).rejects.toThrow(/bound/);
    await expect(
      protectContent(
        { format: enterpriseSecurityFormat, maxContentBytes: 32, maxFindings: 1 },
        {
          scan: async () => ({ redactedContent: 'x', detectionIds: ['x', 'y'] })
        },
        'acme',
        'ada',
        'x'
      )
    ).rejects.toThrow(/finding bound/);
  });

  it('snapshots DLP policy before awaiting the scanner and charges nested byte payloads', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutable = {
      format: enterpriseSecurityFormat,
      maxContentBytes: 64,
      maxFindings: 1,
      watermarkTemplate: 'owner:{subject}'
    };
    const scan = protectContent(
      mutable,
      {
        scan: async () => {
          await pending;
          return { redactedContent: 'safe', detectionIds: [] };
        }
      },
      'acme',
      'ada',
      'safe'
    );
    mutable.maxContentBytes = 1;
    mutable.maxFindings = 0;
    mutable.watermarkTemplate = 'mutated';
    release();
    await expect(scan).resolves.toEqual({ text: 'safe', watermark: 'owner:ada', detections: [] });
    const oversized = new Uint8Array(600_000);
    expect(() =>
      compileEnterprisePolicy({
        ...policyInput,
        capabilities: [oversized, oversized]
      } as never)
    ).toThrow(/aggregate byte bound/);
    const getterPolicy = Object.defineProperty({ ...mutable }, 'maxFindings', {
      get: () => {
        throw new Error('policy getter');
      }
    });
    await expect(
      protectContent(
        getterPolicy as never,
        { scan: async () => ({ redactedContent: 'x', detectionIds: [] }) },
        'acme',
        'ada',
        'x'
      )
    ).rejects.toThrow(/DLP policy/);
    const trappedPolicy = new Proxy(
      { ...mutable },
      {
        ownKeys: () => {
          throw new Error('policy ownKeys');
        }
      }
    );
    await expect(
      protectContent(
        trappedPolicy,
        { scan: async () => ({ redactedContent: 'x', detectionIds: [] }) },
        'acme',
        'ada',
        'x'
      )
    ).rejects.toThrow(/DLP policy/);
  });

  it('uses only opaque, bounded managed-key references and never key material', async () => {
    const port = {
      authorizeUse: async (value: { keyRef: string; tenantId: string }) =>
        value.keyRef === 'kms-ref' && value.tenantId === 'acme',
      encrypt: async () => ({ keyRef: 'kms-ref', ciphertext: new Uint8Array() }),
      decrypt: async () => new Uint8Array()
    };
    await expect(
      authorizeManagedKeyUse(port, {
        keyRef: 'kms-ref',
        tenantId: 'acme',
        purpose: 'entitlement'
      })
    ).resolves.toBe(true);
    await expect(
      authorizeManagedKeyUse(port, { keyRef: '', tenantId: 'acme', purpose: 'entitlement' })
    ).rejects.toThrow(/reference/);
    await expect(
      encryptWithManagedKey(
        {
          ...port,
          encrypt: async () => ({
            keyRef: 'kms-ref-v2',
            rotatedFrom: 'kms-ref',
            ciphertext: new Uint8Array([1])
          })
        },
        'kms-ref',
        new Uint8Array([1])
      )
    ).resolves.toMatchObject({ keyRef: 'kms-ref-v2' });
    await expect(
      authorizeManagedKeyUse(
        {
          ...port,
          authorizeUse: async () => {
            throw new Error('offline');
          }
        },
        { keyRef: 'kms-ref', tenantId: 'acme', purpose: 'entitlement' }
      )
    ).rejects.toMatchObject({ code: 'unavailable' });
    class ForgedManagedKeyError extends ManagedKeyError {}
    await expect(
      authorizeManagedKeyUse(
        {
          ...port,
          authorizeUse: async () => {
            throw new ForgedManagedKeyError('rejected', 'caller-controlled message');
          }
        },
        { keyRef: 'kms-ref', tenantId: 'acme', purpose: 'entitlement' }
      )
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      authorizeManagedKeyUse(
        {
          ...port,
          authorizeUse: async () => {
            throw new EnterpriseSecurityError('forged public error');
          }
        },
        { keyRef: 'kms-ref', tenantId: 'acme', purpose: 'entitlement' }
      )
    ).rejects.toMatchObject({ code: 'unavailable' });
    class Bytes extends Uint8Array {}
    await expect(encryptWithManagedKey(port, 'kms-ref', new Bytes([1]))).rejects.toMatchObject({
      code: 'unavailable'
    });
    await expect(
      encryptWithManagedKey(port, 'kms-ref', new Proxy(new Uint8Array([1]), {}))
    ).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('honors legal hold and rejects noncanonical retention metadata', () => {
    expect(
      canDeleteAfterRetention(
        {
          format: 'selene-retention-record/v1',
          recordId: 'r1',
          tenantId: 'acme',
          createdAt: '2026-07-01T00:00:00.000Z',
          legalHoldId: 'hold-1'
        },
        7,
        365,
        now
      )
    ).toBe(false);
    expect(() =>
      canDeleteAfterRetention(
        {
          format: 'selene-retention-record/v1',
          recordId: 'r1',
          tenantId: 'acme',
          createdAt: '2026-07-01T00:00:00Z'
        },
        7,
        365,
        now
      )
    ).toThrow(/canonical/);
  });

  it('requires versioned, auditable dual control and blocks replay', async () => {
    const consumed = new Set<string>();
    const auditEvents: string[] = [];
    const activation = {
      consumeAndAudit: async (active: { requestId: string; auditEventId: string }) => {
        if (consumed.has(active.requestId)) return false;
        consumed.add(active.requestId);
        auditEvents.push(active.auditEventId);
        return true;
      }
    };
    const approvalVerifier = { verify: async () => true };
    const pending = {
      format: 'selene-break-glass/v1',
      requestId: 'request-1',
      auditEventId: 'audit-1',
      tenantId: 'acme',
      audience: 'selene-api',
      policyId: 'baseline',
      policyVersion: 2,
      requesterId: 'ada',
      caseId: 'inc-1',
      reason: 'Restore owner access during the active incident.',
      issuedAt: '2026-07-24T11:50:00.000Z',
      expiresAt: '2026-07-24T13:00:00.000Z',
      state: 'pending' as const,
      approvals: [
        {
          format: 'selene-break-glass-approval/v1' as const,
          requestId: 'request-1',
          approverId: 'ben',
          issuedAt: '2026-07-24T11:55:00.000Z',
          signature: 'approval-ben',
          keyId: 'key-ben'
        },
        {
          format: 'selene-break-glass-approval/v1' as const,
          requestId: 'request-1',
          approverId: 'cyd',
          issuedAt: '2026-07-24T11:56:00.000Z',
          signature: 'approval-cyd',
          keyId: 'key-cyd'
        }
      ]
    };
    await expect(
      activateBreakGlass(pending, now, activation, breakGlassScope, approvalVerifier)
    ).resolves.toMatchObject({
      state: 'active',
      approvers: ['ben', 'cyd']
    });
    expect(auditEvents).toEqual(['audit-1']);
    await expect(
      activateBreakGlass(pending, now, activation, breakGlassScope, approvalVerifier)
    ).rejects.toThrow(/replayed/);
    await expect(
      activateBreakGlass(
        {
          ...pending,
          requestId: 'request-2',
          approvals: pending.approvals.map((approval, index) => ({
            ...approval,
            requestId: 'request-2',
            approverId: index === 0 ? 'ada' : 'ben'
          }))
        },
        now,
        activation,
        breakGlassScope,
        approvalVerifier
      )
    ).rejects.toThrow(/non-requester/);
    let activationCalls = 0;
    await expect(
      activateBreakGlass(
        { ...pending, requestId: 'request-invalid', tenantId: '' },
        now,
        { consumeAndAudit: async () => ((activationCalls += 1), true) },
        breakGlassScope,
        approvalVerifier
      )
    ).rejects.toThrow(/tenantId/);
    expect(activationCalls).toBe(0);
    await expect(
      activateBreakGlass(
        { ...pending, requestId: 'request-wrong-scope' },
        now,
        { consumeAndAudit: async () => ((activationCalls += 1), true) },
        { ...breakGlassScope, audience: 'other-api' },
        approvalVerifier
      )
    ).rejects.toThrow(/scope/);
    expect(activationCalls).toBe(0);
    await expect(
      activateBreakGlass(
        pending,
        now,
        { consumeAndAudit: async () => ((activationCalls += 1), true) },
        breakGlassScope,
        { verify: async () => false }
      )
    ).rejects.toThrow(/approval was rejected/);
    expect(activationCalls).toBe(0);
  });

  it('atomically claims SIEM events: no duplicate concurrent flush or enqueue-during-flush loss', async () => {
    const outbox = new InMemorySiemOutbox(4);
    const event = (id: string) => ({
      format: 'selene-security-event/v1' as const,
      id,
      tenantId: 'acme',
      occurredAt: now,
      type: 'access.denied',
      payload: {
        format: 'selene-redacted-security-payload/v1' as const,
        summary: 'access denied',
        attributes: [{ key: 'capability', value: 'selene:workspace.read' }]
      }
    });
    await outbox.enqueue(event('one'));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = deliverSiemBatch(outbox, now, async () => {
      await blocked;
    });
    await Promise.resolve();
    await outbox.enqueue(event('two'));
    release();
    await first;
    expect(outbox.size()).toBe(1);
    const deliveries: string[] = [];
    await Promise.all([
      deliverSiemBatch(outbox, now, async (item) => {
        deliveries.push(item.id);
      }),
      deliverSiemBatch(outbox, now, async (item) => {
        deliveries.push(item.id);
      })
    ]);
    expect(deliveries).toEqual(['two']);
    expect(outbox.size()).toBe(0);
    await outbox.enqueue(event('three'));
    await expect(
      deliverSiemBatch(
        outbox,
        now,
        async () => {
          throw new Error('SIEM offline');
        },
        1
      )
    ).resolves.toEqual({ delivered: 0, deadLettered: 1 });
    expect(outbox.deadLetterSize()).toBe(1);
    expect(outbox.deadLetterFor('three')).toMatchObject({
      reasonCode: 'delivery-failed-after-retry-budget',
      event: { id: 'three' }
    });
    await expect(outbox.enqueue(event('three'))).rejects.toThrow(/duplicate/);
    const overflow = new InMemorySiemOutbox(1);
    await overflow.enqueue(event('capacity-one'));
    await expect(overflow.enqueue(event('capacity-two'))).rejects.toThrow(/capacity/);
  });

  it('recovers expired SIEM leases and rejects unredacted or stale-claim completion', async () => {
    const outbox = new InMemorySiemOutbox(2, 1);
    const event = {
      format: 'selene-security-event/v1' as const,
      id: 'lease-one',
      tenantId: 'acme',
      occurredAt: now,
      type: 'access.denied',
      payload: {
        format: 'selene-redacted-security-payload/v1' as const,
        summary: 'denied',
        attributes: []
      }
    };
    await outbox.enqueue(event);
    const [first] = await outbox.claim(1, now);
    expect(first).toBeDefined();
    expect(await outbox.claim(1, now)).toEqual([]);
    const [recovered] = await outbox.claim(1, '2026-07-24T12:00:01.000Z');
    expect(recovered?.claimId).not.toBe(first?.claimId);
    await expect(outbox.ack(first!.claimId, '2026-07-24T12:00:01.000Z')).rejects.toThrow(
      /unknown or settled/
    );
    await expect(outbox.ack(recovered!.claimId, '2026-07-24T12:00:02.000Z')).rejects.toThrow(
      /expired/
    );
    const [replacement] = await outbox.claim(1, '2026-07-24T12:00:02.000Z');
    await outbox.ack(replacement!.claimId, '2026-07-24T12:00:02.000Z');
    await expect(
      outbox.enqueue({ ...event, id: 'unredacted', payload: 'secret' as never })
    ).rejects.toThrow(/payload/);
  });
});
