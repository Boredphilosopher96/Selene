import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CrashDiagnostics,
  CrashLoopRecovery,
  JsonFileDiagnosticsConsentStore,
  JsonFileDiagnosticsDeliveryStore,
  JsonFileDiagnosticsStore,
  parseDiagnosticsConsent,
  parseCrashDiagnostics,
  type DiagnosticsConsentStore,
  type DiagnosticsDeliveryStore,
  type DiagnosticsStorageCodec,
  type CrashDiagnosticsStore
} from './crash-diagnostics';

class MemoryStore implements CrashDiagnosticsStore {
  public value: unknown = [];
  public async load(): Promise<unknown> {
    return this.value;
  }
  public async save(value: unknown): Promise<void> {
    this.value = structuredClone(value);
  }
  public async delete(): Promise<void> {
    this.value = [];
  }
}

class MemoryConsentStore implements DiagnosticsConsentStore {
  public value: unknown = {};
  public async load(): Promise<unknown> {
    return this.value;
  }
  public async save(value: unknown): Promise<void> {
    this.value = structuredClone(value);
  }
  public async delete(): Promise<void> {
    this.value = {};
  }
}

class MemoryDeliveryStore implements DiagnosticsDeliveryStore {
  public value: unknown = {};
  public async load(): Promise<unknown> {
    return this.value;
  }
  public async save(value: unknown): Promise<void> {
    this.value = structuredClone(value);
  }
  public async delete(): Promise<void> {
    this.value = {};
  }
}

class InterleavingStore extends MemoryStore {
  private releaseFirstSave: () => void = () => undefined;
  private first = true;
  public readonly firstSaveEntered: Promise<void>;

  public constructor() {
    super();
    this.firstSaveEntered = new Promise((resolve) => {
      this.releaseFirstSave = resolve;
    });
  }

  public release(): void {
    this.releaseFirstSave();
  }

  public override async save(value: unknown): Promise<void> {
    if (this.first) {
      this.first = false;
      let resume: () => void = () => undefined;
      const blocked = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const entered = this.releaseFirstSave;
      this.releaseFirstSave = resume;
      entered();
      await blocked;
    }
    await super.save(value);
  }
}

class RejectOnceStore extends MemoryStore {
  private rejectLoad = true;
  private rejectSave = false;

  public failNextSave(): void {
    this.rejectSave = true;
  }

  public override async load(): Promise<unknown> {
    if (this.rejectLoad) {
      this.rejectLoad = false;
      throw new Error('temporary storage failure');
    }
    return super.load();
  }

  public override async save(value: unknown): Promise<void> {
    if (this.rejectSave) {
      this.rejectSave = false;
      throw new Error('temporary save failure');
    }
    await super.save(value);
  }
}

class RejectOnceDeleteStore extends MemoryStore {
  private rejectDelete = false;

  public failNextDelete(): void {
    this.rejectDelete = true;
  }

  public override async delete(): Promise<void> {
    if (this.rejectDelete) {
      this.rejectDelete = false;
      throw new Error('temporary erase failure');
    }
    await super.delete();
  }
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('crash diagnostics', () => {
  it('captures only a bounded, data-poor envelope from hostile crash objects', async () => {
    const store = new MemoryStore();
    const diagnostics = new CrashDiagnostics(store, new MemoryConsentStore(), {
      maximumEvents: 2,
      now: () => new Date('2026-07-24T12:00:00.000Z')
    });
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('source prompt comment design /private/token raw dump');
        },
        ownKeys() {
          throw new Error('must not enumerate hostile data');
        }
      }
    );

    await diagnostics.capture('preview', 'runtime-error', hostile);
    expect((await diagnostics.export()).events).toEqual([]);
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('preview', 'runtime-error', hostile);
    await diagnostics.capture('agent', 'adapter-failure', hostile);
    await diagnostics.capture('service', 'operation-failure', hostile);
    const bundle = await diagnostics.export();

    expect(bundle).toEqual({
      format: 'selene-crash-diagnostics/v1',
      exportedAt: '2026-07-24T12:00:00.000Z',
      events: [
        { source: 'agent', category: 'adapter-failure', occurredAt: '2026-07-24T12:00:00.000Z' },
        { source: 'service', category: 'operation-failure', occurredAt: '2026-07-24T12:00:00.000Z' }
      ]
    });
    expect(JSON.stringify(bundle)).not.toContain('token');
    expect(JSON.stringify(bundle)).not.toContain('private');
  });

  it('requires explicit persisted consent and non-denying organization policy for replaceable reporting', async () => {
    const diagnostics = new CrashDiagnostics(new MemoryStore(), new MemoryConsentStore());
    await diagnostics.capture('electron', 'unhandled-rejection');
    const reports: unknown[] = [];
    const adapter = {
      async report(bundle: unknown) {
        reports.push(bundle);
      }
    };

    await expect(diagnostics.report(adapter)).resolves.toBe(false);
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'unhandled-rejection');
    await expect(diagnostics.report(adapter)).resolves.toBe(true);
    const blocked = new CrashDiagnostics(new MemoryStore(), new MemoryConsentStore(), {
      organization: 'deny'
    });
    await blocked.setUserConsent('granted');
    await expect(blocked.report(adapter)).resolves.toBe(false);
    expect(reports).toHaveLength(1);
  });

  it('keeps a bounded consent history and deletes queued events immediately on opt-out', async () => {
    const store = new MemoryStore();
    const consent = new MemoryConsentStore();
    const diagnostics = new CrashDiagnostics(store, consent, {
      maximumConsentHistory: 2,
      now: () => new Date('2026-07-24T12:00:00.000Z')
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'renderer-gone');
    expect((await diagnostics.export()).events).toHaveLength(1);
    await diagnostics.setUserConsent('denied');
    expect((await diagnostics.export()).events).toEqual([]);
    expect((await diagnostics.getConsent()).history).toEqual([
      { user: 'granted', recordedAt: '2026-07-24T12:00:00.000Z' },
      { user: 'denied', recordedAt: '2026-07-24T12:00:00.000Z' }
    ]);
    expect(JSON.stringify(consent.value)).not.toContain('token');
  });

  it('fails closed immediately when consent is withdrawn, including against an in-flight port', async () => {
    const events = new MemoryStore();
    const delivery = new MemoryDeliveryStore();
    const diagnostics = new CrashDiagnostics(events, new MemoryConsentStore(), {
      deliveryStore: delivery,
      reportTimeoutMs: 1_000
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const hanging = {
      report(
        _bundle: unknown,
        context: { readonly idempotencyKey: string; readonly signal: AbortSignal }
      ) {
        started();
        context.signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<void>(() => undefined);
      }
    };
    const reporting = diagnostics.report(hanging);
    await entered;
    await expect(diagnostics.setUserConsent('denied')).resolves.toMatchObject({ user: 'denied' });
    await expect(reporting).resolves.toBe(false);
    expect(aborted).toBe(true);
    expect((await diagnostics.export()).events).toEqual([]);
    await expect(diagnostics.report(hanging)).resolves.toBe(false);
    expect(events.value).toEqual([]);
    expect(delivery.value).toEqual({});
  });

  it('does not queue withdrawal behind a non-cooperative reporter deadline', async () => {
    const events = new MemoryStore();
    const delivery = new MemoryDeliveryStore();
    const diagnostics = new CrashDiagnostics(events, new MemoryConsentStore(), {
      deliveryStore: delivery,
      reportTimeoutMs: 60_000
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const report = diagnostics.report({
      report(_bundle, context) {
        entered();
        return new Promise<void>((_resolve) => {
          context.signal.addEventListener('abort', () => undefined, { once: true });
        });
      }
    });
    await started;
    await expect(
      Promise.race([
        diagnostics.setUserConsent('denied'),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error('withdrawal waited')), 50)
        )
      ])
    ).resolves.toMatchObject({ user: 'denied' });
    await expect(report).resolves.toBe(false);
    expect(events.value).toEqual([]);
    expect(delivery.value).toEqual({});
  });

  it('retries a failed withdrawal cleanup before allowing a later opt-in or restart', async () => {
    const events = new RejectOnceDeleteStore();
    const consent = new MemoryConsentStore();
    const diagnostics = new CrashDiagnostics(events, consent);
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    events.failNextDelete();
    await expect(diagnostics.setUserConsent('denied')).rejects.toThrow('temporary erase failure');
    expect((await diagnostics.export()).events).toEqual([]);

    await diagnostics.setUserConsent('granted');
    const restarted = new CrashDiagnostics(events, consent);
    expect((await restarted.export()).events).toEqual([]);
  });

  it('recovers a failed private-filesystem cleanup before a later opt-in and restart', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'selene-diagnostics-cleanup-recovery-'));
    const eventsFile = join(folder, 'private', 'events.json');
    const consentFile = join(folder, 'private', 'consent.json');
    try {
      const events = new JsonFileDiagnosticsStore(eventsFile);
      const consent = new JsonFileDiagnosticsConsentStore(consentFile);
      const diagnostics = new CrashDiagnostics(events, consent);
      await diagnostics.setUserConsent('granted');
      await diagnostics.capture('electron', 'uncaught-exception');
      await rm(eventsFile);
      await mkdir(eventsFile);
      await expect(diagnostics.setUserConsent('denied')).rejects.toThrow();
      await rm(eventsFile, { recursive: true });
      await diagnostics.setUserConsent('granted');

      const restarted = new CrashDiagnostics(
        new JsonFileDiagnosticsStore(eventsFile),
        new JsonFileDiagnosticsConsentStore(consentFile)
      );
      expect((await restarted.export()).events).toEqual([]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('binds an admitted report method once and quarantines its late settlement', async () => {
    const diagnostics = new CrashDiagnostics(new MemoryStore(), new MemoryConsentStore(), {
      reportTimeoutMs: 1_000
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    const completion = deferred<void>();
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let originalCalls = 0;
    let replacementCalls = 0;
    const adapter: { report: (bundle: unknown, delivery: unknown) => Promise<void> } = {
      report() {
        originalCalls += 1;
        entered();
        return completion.promise;
      }
    };
    const reporting = diagnostics.report(adapter);
    await started;
    adapter.report = async () => {
      replacementCalls += 1;
    };
    completion.resolve();
    await expect(reporting).resolves.toBe(true);
    expect(originalCalls).toBe(1);
    expect(replacementCalls).toBe(0);
  });

  it('keeps a timed-out reporter quarantined when it settles after its admission closed', async () => {
    const delivery = new MemoryDeliveryStore();
    const diagnostics = new CrashDiagnostics(new MemoryStore(), new MemoryConsentStore(), {
      deliveryStore: delivery,
      reportTimeoutMs: 1
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    const completion = deferred<void>();
    await expect(
      diagnostics.report({
        report() {
          return completion.promise;
        }
      })
    ).resolves.toBe(false);
    completion.resolve();
    await Promise.resolve();
    expect(delivery.value).toMatchObject({ pending: { attempts: 1 } });
    expect(delivery.value).not.toHaveProperty('delivered');
  });

  it('serializes overlapping captures so a late first write cannot erase a newer event', async () => {
    const store = new InterleavingStore();
    const diagnostics = new CrashDiagnostics(store, new MemoryConsentStore());
    await diagnostics.setUserConsent('granted');

    const first = diagnostics.capture('electron', 'uncaught-exception');
    await store.firstSaveEntered;
    const second = diagnostics.capture('electron', 'unhandled-rejection');
    store.release();
    await Promise.all([first, second]);

    expect((await diagnostics.export()).events.map((event) => event.category)).toEqual([
      'uncaught-exception',
      'unhandled-rejection'
    ]);
    expect((store.value as { readonly category: string }[]).map((event) => event.category)).toEqual(
      ['uncaught-exception', 'unhandled-rejection']
    );
  });

  it('keeps fatal termination evidence until an explicit recovery reset', async () => {
    expect(
      parseCrashDiagnostics([{ source: 'preview', category: 'runtime-error', occurredAt: 'bad' }])
    ).toEqual([]);
    const starts = new MemoryStore();
    let now = 0;
    const recovery = new CrashLoopRecovery(starts, { limit: 3, windowMs: 100, now: () => now });
    await expect(recovery.beginStartup()).resolves.toEqual({ active: false, attempts: 1 });
    now = 10;
    await expect(recovery.beginStartup()).resolves.toEqual({ active: false, attempts: 2 });
    now = 20;
    await expect(recovery.beginStartup()).resolves.toEqual({ active: true, attempts: 3 });
    recovery.markUncleanTermination();
    await expect(recovery.cleanShutdown()).resolves.toBe(false);
    expect(starts.value).toEqual([0, 10, 20]);
    await recovery.reset();
    now = 30;
    await expect(recovery.beginStartup()).resolves.toEqual({ active: false, attempts: 1 });
  });

  it('serializes concurrent crash-loop lifecycle transitions without losing a startup', async () => {
    const starts = new InterleavingStore();
    let now = 0;
    const recovery = new CrashLoopRecovery(starts, { limit: 3, windowMs: 100, now: () => now });
    const first = recovery.beginStartup();
    await starts.firstSaveEntered;
    now = 10;
    const second = recovery.beginStartup();
    starts.release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { active: false, attempts: 1 },
      { active: false, attempts: 2 }
    ]);
    expect(starts.value).toEqual([0, 10]);
  });

  it('snapshots crash-loop options and capabilities without invoking hostile getters', async () => {
    const values: unknown[] = [];
    const store = {
      load: async () => values,
      save: async (next: readonly number[]) => {
        values.splice(0, values.length, ...next);
      },
      delete: async () => {
        values.length = 0;
      }
    };
    let now = 0;
    const options = { limit: 3, windowMs: 100, now: () => now };
    const recovery = new CrashLoopRecovery(store, options);
    options.limit = 99;
    options.windowMs = 1;
    options.now = () => 999;
    store.load = async () => {
      throw new Error('mutated store capability');
    };
    now = 10;
    await expect(recovery.beginStartup()).resolves.toEqual({ active: false, attempts: 1 });
    expect(values).toEqual([10]);

    let getterReads = 0;
    const hostileOptions = {} as { limit?: number; windowMs?: number; now?: () => number };
    Object.defineProperties(hostileOptions, {
      limit: {
        get: () => {
          getterReads += 1;
          throw new Error('limit getter');
        }
      },
      windowMs: {
        get: () => {
          getterReads += 1;
          throw new Error('window getter');
        }
      },
      now: {
        get: () => {
          getterReads += 1;
          throw new Error('clock getter');
        }
      }
    });
    const safe = new CrashLoopRecovery(new MemoryStore(), hostileOptions);
    await expect(safe.beginStartup()).resolves.toEqual({ active: false, attempts: 1 });
    expect(getterReads).toBe(0);
  });

  it('rejects unsafe or backward crash-loop clock values', async () => {
    const store = new MemoryStore();
    let now = 10;
    const recovery = new CrashLoopRecovery(store, { now: () => now });
    await expect(recovery.beginStartup()).resolves.toEqual({ active: false, attempts: 1 });
    now = 9;
    await expect(recovery.beginStartup()).rejects.toThrow('crash-loop clock is invalid');
    const fractional = new CrashLoopRecovery(store, { now: () => 1.5 });
    await expect(fractional.beginStartup()).rejects.toThrow('crash-loop clock is invalid');
  });

  it('contains a late crash-loop store settlement after capability mutation', async () => {
    let release: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const values: unknown[] = [];
    const store = {
      load: async () => values,
      save: async (next: readonly number[]) => {
        await entered;
        values.splice(0, values.length, ...next);
      },
      delete: async () => {
        values.length = 0;
      }
    };
    const recovery = new CrashLoopRecovery(store, { now: () => 0 });
    const startup = recovery.beginStartup();
    store.save = async () => {
      throw new Error('mutated save capability');
    };
    release();
    await expect(startup).resolves.toEqual({ active: false, attempts: 1 });
    await expect(recovery.reset()).resolves.toBeUndefined();
    expect(values).toEqual([]);
  });

  it('bounds hostile on-disk records and keeps the storage path out of exports', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'selene-diagnostics-'));
    const file = join(folder, 'queue.json');
    try {
      await writeFile(file, 'x'.repeat(70 * 1_024));
      const store = new JsonFileDiagnosticsStore(file);
      const diagnostics = new CrashDiagnostics(store);
      await diagnostics.setUserConsent('granted');
      expect((await diagnostics.export()).events).toEqual([]);
      await diagnostics.capture('electron', 'uncaught-exception');
      expect(await readFile(file, 'utf8')).toContain('uncaught-exception');
      expect(JSON.stringify(await diagnostics.export())).not.toContain(folder);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('drops expired persisted events and rejects hostile consent records without invoking data traps', async () => {
    const store = new MemoryStore();
    store.value = [
      {
        source: 'electron',
        category: 'uncaught-exception',
        occurredAt: '2026-06-01T00:00:00.000Z'
      },
      { source: 'electron', category: 'uncaught-exception', occurredAt: '2026-07-24T00:00:00.000Z' }
    ];
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('prompt comments secrets paths');
        },
        ownKeys() {
          throw new Error('do not enumerate');
        }
      }
    );
    expect(parseDiagnosticsConsent(hostile)).toEqual({
      user: 'unknown',
      organization: 'not-managed',
      history: []
    });
    const consent = new MemoryConsentStore();
    consent.value = { user: 'granted', organization: 'not-managed', history: [] };
    const diagnostics = new CrashDiagnostics(store, consent, {
      retentionMs: 24 * 60 * 60 * 1_000,
      now: () => new Date('2026-07-24T12:00:00.000Z')
    });
    expect((await diagnostics.export()).events).toEqual([
      { source: 'electron', category: 'uncaught-exception', occurredAt: '2026-07-24T00:00:00.000Z' }
    ]);
  });

  it('fails closed by deleting a persisted queue unless consent is explicitly granted', async () => {
    const store = new MemoryStore();
    store.value = [
      { source: 'electron', category: 'uncaught-exception', occurredAt: '2026-07-24T12:00:00.000Z' }
    ];
    const diagnostics = new CrashDiagnostics(store, new MemoryConsentStore(), {
      now: () => new Date('2026-07-24T12:00:00.000Z')
    });
    expect((await diagnostics.export()).events).toEqual([]);
    expect(store.value).toEqual([]);
  });

  it('bounds consent persistence and keeps the consent path out of support exports', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'selene-diagnostics-consent-'));
    const file = join(folder, 'consent.json');
    try {
      const store = new JsonFileDiagnosticsConsentStore(file);
      const diagnostics = new CrashDiagnostics(new MemoryStore(), store, {
        now: () => new Date('2026-07-24T12:00:00.000Z')
      });
      await diagnostics.setUserConsent('granted');
      expect(await readFile(file, 'utf8')).not.toContain(folder);
      expect(JSON.stringify(await diagnostics.export())).not.toContain(folder);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('uses main-process policy, durable retry backoff, and delivery deduplication', async () => {
    const events = new MemoryStore();
    const consent = new MemoryConsentStore();
    const delivery = new MemoryDeliveryStore();
    let now = new Date('2026-07-24T12:00:00.000Z');
    const diagnostics = new CrashDiagnostics(events, consent, {
      deliveryStore: delivery,
      retryMs: 10,
      maximumRetryMs: 100,
      now: () => now
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    let calls = 0;
    const flaky = {
      async report() {
        calls += 1;
        if (calls === 1) throw new Error('offline');
      }
    };
    await expect(diagnostics.report(flaky)).resolves.toBe(false);
    await expect(diagnostics.report(flaky)).resolves.toBe(false);
    expect(calls).toBe(1);
    now = new Date('2026-07-24T12:00:00.010Z');
    await expect(diagnostics.report(flaky)).resolves.toBe(true);
    await expect(diagnostics.report(flaky)).resolves.toBe(true);
    expect(calls).toBe(2);

    const blocked = new CrashDiagnostics(new MemoryStore(), new MemoryConsentStore(), {
      policy: { collection: 'deny', reporting: 'deny' }
    });
    await blocked.setUserConsent('granted');
    await blocked.capture('electron', 'uncaught-exception');
    expect((await blocked.export()).events).toEqual([]);
    await expect(blocked.report(flaky)).resolves.toBe(false);
  });

  it('retries the exact frozen fingerprinted payload even if new events arrive', async () => {
    const events = new MemoryStore();
    const delivery = new MemoryDeliveryStore();
    let now = new Date('2026-07-24T12:00:00.000Z');
    const diagnostics = new CrashDiagnostics(events, new MemoryConsentStore(), {
      deliveryStore: delivery,
      retryMs: 1,
      maximumRetryMs: 10,
      now: () => now
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    const attempts: { readonly bundle: unknown; readonly key: string }[] = [];
    const flaky = {
      async report(bundle: unknown, context: { readonly idempotencyKey: string }) {
        attempts.push({ bundle: structuredClone(bundle), key: context.idempotencyKey });
        if (attempts.length === 1) throw new Error('offline');
      }
    };
    await expect(diagnostics.report(flaky)).resolves.toBe(false);
    await diagnostics.capture('electron', 'unhandled-rejection');
    now = new Date('2026-07-24T12:00:00.001Z');
    await expect(diagnostics.report(flaky)).resolves.toBe(true);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(
      (delivery.value as { readonly delivered?: { readonly fingerprint: string } }).delivered
        ?.fingerprint
    ).toBe(attempts[0]?.key);
  });

  it('creates private delivery storage without exporting its path or persistence metadata', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'selene-diagnostics-delivery-'));
    const file = join(folder, 'private', 'delivery.json');
    try {
      const store = new JsonFileDiagnosticsDeliveryStore(file);
      await store.save({
        pending: {
          fingerprint: 'a'.repeat(64),
          bundle: {
            format: 'selene-crash-diagnostics/v1',
            exportedAt: '2026-07-24T12:00:00.000Z',
            events: []
          },
          attempts: 1,
          nextAttemptAt: 123
        }
      });
      expect(await readFile(file, 'utf8')).not.toContain(folder);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('retries failed initialization and keeps in-memory queue state transactional when persistence fails', async () => {
    const store = new RejectOnceStore();
    const diagnostics = new CrashDiagnostics(store, new MemoryConsentStore());
    await expect(diagnostics.export()).rejects.toThrow('temporary storage failure');
    await diagnostics.setUserConsent('granted');
    store.failNextSave();
    await expect(diagnostics.capture('electron', 'uncaught-exception')).rejects.toThrow(
      'temporary save failure'
    );
    expect((await diagnostics.export()).events).toEqual([]);
  });

  it('contains a hanging reporting port, aborts it, and retains one idempotent pending delivery', async () => {
    const delivery = new MemoryDeliveryStore();
    const diagnostics = new CrashDiagnostics(new MemoryStore(), new MemoryConsentStore(), {
      deliveryStore: delivery,
      retryMs: 1,
      maximumRetryMs: 10,
      reportTimeoutMs: 1
    });
    await diagnostics.setUserConsent('granted');
    await diagnostics.capture('electron', 'uncaught-exception');
    let aborted = false;
    const hanging = {
      report(
        _bundle: unknown,
        context: { readonly idempotencyKey: string; readonly signal: AbortSignal }
      ) {
        context.signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<void>(() => undefined);
      }
    };
    await expect(diagnostics.report(hanging)).resolves.toBe(false);
    expect(aborted).toBe(true);
    expect(
      (delivery.value as { readonly pending?: { readonly fingerprint: string } }).pending
        ?.fingerprint
    ).toMatch(/^[a-f0-9]{64}$/);
    expect((await diagnostics.export()).events).toHaveLength(1);
  });

  it('uses codec-sealed, no-follow files and replaces a hostile symlink without reading its target', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'selene-diagnostics-nofollow-'));
    const file = join(folder, 'private', 'queue.json');
    const target = join(folder, 'target.txt');
    const codec: DiagnosticsStorageCodec = {
      seal: (plaintext) => `sealed:${Buffer.from(plaintext).toString('base64')}`,
      open: (ciphertext) =>
        Buffer.from(ciphertext.slice('sealed:'.length), 'base64').toString('utf8')
    };
    try {
      await writeFile(target, 'hostile-target');
      await mkdir(join(folder, 'private'));
      await symlink(target, file);
      const store = new JsonFileDiagnosticsStore(file, undefined, codec);
      codec.seal = () => {
        throw new Error('late codec mutation must not affect private storage');
      };
      expect(await store.load()).toEqual([]);
      await store.save([
        {
          source: 'electron',
          category: 'uncaught-exception',
          occurredAt: '2026-07-24T12:00:00.000Z'
        }
      ]);
      expect((await lstat(file)).isSymbolicLink()).toBe(false);
      expect((await lstat(join(folder, 'private'))).mode & 0o777).toBe(0o700);
      expect((await lstat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(target, 'utf8')).toBe('hostile-target');
      expect(await readFile(file, 'utf8')).not.toContain('uncaught-exception');
      expect(await store.load()).toEqual([
        {
          source: 'electron',
          category: 'uncaught-exception',
          occurredAt: '2026-07-24T12:00:00.000Z'
        }
      ]);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('bounds persisted-array traversal before inspecting hostile older entries', () => {
    const events = Array.from({ length: 10_000 }, () => ({
      source: 'electron',
      category: 'uncaught-exception',
      occurredAt: '2026-07-24T12:00:00.000Z'
    }));
    Object.defineProperty(events, 0, {
      get() {
        throw new Error('older hostile entry was traversed');
      }
    });
    expect(parseCrashDiagnostics(events, 2)).toEqual([
      {
        source: 'electron',
        category: 'uncaught-exception',
        occurredAt: '2026-07-24T12:00:00.000Z'
      },
      { source: 'electron', category: 'uncaught-exception', occurredAt: '2026-07-24T12:00:00.000Z' }
    ]);
    const history = Array.from({ length: 10_000 }, () => ({
      user: 'granted',
      recordedAt: '2026-07-24T12:00:00.000Z'
    }));
    Object.defineProperty(history, 0, {
      get() {
        throw new Error('older hostile consent entry was traversed');
      }
    });
    expect(
      parseDiagnosticsConsent({ user: 'granted', organization: 'not-managed', history }).history
    ).toHaveLength(16);
  });
});
