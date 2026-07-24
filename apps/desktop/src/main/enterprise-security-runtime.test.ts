import { describe, expect, it } from 'vitest';

import { protectContent, enterpriseSecurityFormat } from '@selene/core';
import {
  createHostEffectAdmissionPool,
  createHostEffectSupervisorOptions,
  HostEffectSupervisor
} from '@selene/host-runtime';

import { createDesktopEnterpriseSecurityAdapter } from './enterprise-security-runtime';

function runtime() {
  let now = 0;
  const tasks = new Set<() => void>();
  const clock = Object.freeze({ now: () => now });
  const scheduler = Object.freeze({
    schedule(_delayMs: number, task: () => void) {
      tasks.add(task);
      return Object.freeze({ cancel: () => tasks.delete(task) });
    }
  });
  const supervisor = new HostEffectSupervisor(
    createHostEffectSupervisorOptions({
      admissionPool: createHostEffectAdmissionPool({
        clock,
        maxConcurrentEffects: 4,
        maxConcurrentEffectsPerOwner: 1
      }),
      scheduler
    })
  );
  return {
    adapter: createDesktopEnterpriseSecurityAdapter(supervisor, clock),
    advance(milliseconds: number) {
      now += milliseconds;
      for (const task of [...tasks]) task();
    }
  };
}

const policy = Object.freeze({
  format: enterpriseSecurityFormat,
  maxContentBytes: 256,
  maxFindings: 2
});

describe('desktop enterprise security runtime', () => {
  it('captures provider methods and routes DLP effects through the bounded host supervisor', async () => {
    const host = runtime();
    const provider = {
      async scan(
        request: { readonly content: string },
        context?: { readonly signal: AbortSignal; readonly timeoutMs: number }
      ) {
        expect(context?.timeoutMs).toBe(5_000);
        expect(context?.signal.aborted).toBe(false);
        return {
          redactedContent: request.content.replace('secret', '[redacted]'),
          detectionIds: ['id-1']
        };
      }
    };
    const scanner = host.adapter.bind(provider, ['scan']);
    const result = await protectContent(policy, scanner, 'acme', 'ada', 'a secret');
    expect(result).toEqual({ text: 'a [redacted]', detections: ['id-1'] });
  });

  it('fences a timed-out provider until actual settlement, then recovers its stable owner', async () => {
    const host = runtime();
    let release!: () => void;
    let markStarted!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let calls = 0;
    const provider = {
      async scan() {
        calls += 1;
        if (calls === 1) {
          markStarted();
          await blocked;
        }
        return { redactedContent: 'safe', detectionIds: [] };
      }
    };
    const scanner = host.adapter.bind(provider, ['scan']);
    const timedOut = protectContent(policy, scanner, 'acme', 'ada', 'secret');
    await started;
    host.advance(5_000);
    await expect(timedOut).rejects.toThrow(/failed closed/);
    await expect(protectContent(policy, scanner, 'acme', 'ada', 'secret')).rejects.toThrow(
      /failed closed/
    );
    release();
    await host.adapter.waitForSettlement(provider);
    await expect(protectContent(policy, scanner, 'acme', 'ada', 'secret')).resolves.toEqual({
      text: 'safe',
      detections: []
    });
  });

  it('rejects accessor-backed providers without executing their getter', () => {
    const host = runtime();
    const provider = Object.defineProperty({}, 'scan', {
      get() {
        throw new Error('getter executed');
      }
    });
    expect(() => host.adapter.bind(provider, ['scan'])).toThrow(/enterprise host effect failed/);
  });

  it('captures the provider method once and rejects hostile owned input before invocation', async () => {
    const host = runtime();
    let calls = 0;
    const provider = {
      run: async () => ({ safe: true })
    };
    const port = host.adapter.bind(provider, ['run']) as unknown as {
      run(value: unknown): Promise<unknown>;
    };
    provider.run = async () => {
      calls += 1;
      return { safe: false };
    };
    await expect(port.run({ input: 'safe' })).resolves.toEqual({ safe: true });
    expect(calls).toBe(0);
    await expect(port.run(new Uint8Array(1_048_577))).rejects.toThrow(/host effect failed/);
    class Bytes extends Uint8Array {}
    await expect(port.run(new Bytes([1]))).rejects.toThrow(/host effect failed/);
    await expect(port.run(new Proxy(new Uint8Array([1]), {}))).rejects.toThrow(
      /host effect failed/
    );
    const nonEnumerable = ['safe'];
    Object.defineProperty(nonEnumerable, '0', { enumerable: false, value: 'safe' });
    await expect(port.run(nonEnumerable)).rejects.toThrow(/host effect failed/);
    expect(calls).toBe(0);
  });

  it('routes every enterprise effect method through its stable supervised port owner', async () => {
    const host = runtime();
    const contexts: { readonly signal: AbortSignal; readonly timeoutMs: number }[] = [];
    const effect =
      (label: string) =>
      (...arguments_: readonly unknown[]) => {
        contexts.push(
          arguments_.at(-1) as { readonly signal: AbortSignal; readonly timeoutMs: number }
        );
        return { label };
      };
    const effects = [
      ['signed policy verifier', { verify: effect('signed policy verifier') }, ['verify']],
      [
        'policy revision store',
        { read: effect('read'), compareAndSet: effect('compareAndSet') },
        ['read', 'compareAndSet']
      ],
      ['entitlement verifier', { verify: effect('entitlement verifier') }, ['verify']],
      [
        'managed KMS',
        {
          authorizeUse: effect('authorizeUse'),
          encrypt: effect('encrypt'),
          decrypt: effect('decrypt')
        },
        ['authorizeUse', 'encrypt', 'decrypt']
      ],
      ['DLP scanner', { scan: effect('scan') }, ['scan']],
      ['break-glass verifier', { verify: effect('break-glass verifier') }, ['verify']],
      ['break-glass audit', { consumeAndAudit: effect('consumeAndAudit') }, ['consumeAndAudit']],
      [
        'SIEM outbox',
        {
          enqueue: effect('enqueue'),
          claim: effect('claim'),
          ack: effect('ack'),
          nack: effect('nack'),
          deadLetter: effect('deadLetter')
        },
        ['enqueue', 'claim', 'ack', 'nack', 'deadLetter']
      ]
    ] as const;

    for (const [label, provider, methods] of effects) {
      const port = host.adapter.bind(provider, methods) as unknown as Record<
        string,
        (input: unknown) => Promise<unknown>
      >;
      for (const method of methods) {
        // The shared per-owner cap requires each method to settle before the next admission.
        // oxlint-disable-next-line no-await-in-loop
        await expect(port[method]!({ label })).resolves.toEqual(expect.any(Object));
      }
    }
    const methodCount = effects.reduce((count, [, , methods]) => count + methods.length, 0);
    expect(contexts).toHaveLength(methodCount);
    expect(contexts).toEqual(
      Array.from({ length: methodCount }, () =>
        expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 5_000 })
      )
    );
  });
});
