import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  createDesktopDesignInputLoader,
  createDesktopDesignInputRuntime
} from './design-input-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

class FakeHost {
  public now = 0;
  public cancelled = 0;
  private next = 0;
  private readonly tasks = new Map<number, { readonly at: number; readonly task: () => void }>();
  public readonly clock = { now: () => this.now };
  public readonly scheduler = {
    schedule: (delayMs: number, task: () => void) => {
      const id = ++this.next;
      this.tasks.set(id, { at: this.now + delayMs, task });
      return {
        cancel: () => {
          this.cancelled += this.tasks.delete(id) ? 1 : 0;
        }
      };
    }
  };
  public advance(milliseconds: number): void {
    this.now += milliseconds;
    while (true) {
      const due = [...this.tasks.entries()].find(([, task]) => task.at <= this.now);
      if (due === undefined) return;
      this.tasks.delete(due[0]);
      due[1].task();
    }
  }
}

const request = {
  package: { name: '@selene/example-design-library', version: '1.0.0' },
  designLanguage: { location: 'design-language:example' },
  requiredPeerDependencies: { react: '^19.0.0' }
};

function packageArtifact() {
  return {
    packageJson: {
      name: '@selene/example-design-library',
      version: '1.0.0',
      peerDependencies: { react: '^19.0.0' },
      exports: { '.': './dist/index.js', './tokens': './dist/tokens.json' },
      selene: {
        designSystem: {
          schemaVersion: '1',
          tokenFiles: ['./dist/tokens.json'],
          components: [{ name: 'Button', exportName: 'Button', entrypoint: '.' }],
          designLanguagePath: './DESIGN.md'
        }
      }
    },
    files: [
      { path: './dist/index.js', content: 'export const Button = {};' },
      { path: './dist/tokens.json', content: '{"color":"blue"}' },
      { path: './DESIGN.md', content: '# Design\n\n## Principles\n\nUse semantic tokens.' }
    ],
    provenance: { provider: 'desktop-test', location: 'npm:@selene/example-design-library@1.0.0' }
  };
}

function languageArtifact() {
  return {
    markdown: '# Design\n\n## Principles\n\nUse semantic tokens.',
    provenance: {
      provider: 'desktop-test',
      location: 'npm:@selene/example-design-library@1.0.0/DESIGN.md'
    }
  };
}

describe('desktop design-input runtime', () => {
  it('captures options, clock, scheduler, cancel, and timeout without exposing an absolute deadline', async () => {
    const host = new FakeHost();
    const clock = host.clock as { now: () => number };
    let handle: { cancel(): void } | undefined;
    const scheduler = {
      schedule: (delay: number, task: () => void) => {
        handle = host.scheduler.schedule(delay, task);
        return handle;
      }
    };
    const options = { clock, scheduler };
    const runtime = createDesktopDesignInputRuntime(options);
    options.clock = { now: () => Number.MAX_SAFE_INTEGER };
    options.scheduler = { schedule: () => ({ cancel: () => undefined }) };
    clock.now = () => Number.MAX_SAFE_INTEGER;
    scheduler.schedule = () => ({ cancel: () => undefined });
    let context: Record<string, unknown> | undefined;
    const timeout = { timeoutMs: 25 };
    const execution = runtime.run(
      {
        resolvePackage: (received: Record<string, unknown>) => {
          context = received;
          return 'resolved';
        }
      },
      'resolvePackage',
      [],
      timeout
    );
    timeout.timeoutMs = 1;
    handle!.cancel = () => undefined;
    const result = await execution;
    expect(result).toEqual({ status: 'ok', value: 'resolved' });
    expect(context).toMatchObject({ ownerGeneration: 1 });
    expect(context).not.toHaveProperty('deadlineMs');
    expect(context).not.toHaveProperty('remainingMs');
    expect(host.cancelled).toBe(1);

    let accessorReads = 0;
    const accessorTimeout = Object.create(Object.prototype, {
      timeoutMs: {
        get: () => {
          accessorReads += 1;
          return 1;
        }
      }
    });
    await expect(
      runtime.run({ resolvePackage: () => 'never' }, 'resolvePackage', [], accessorTimeout)
    ).resolves.toEqual({ status: 'effect-failed' });
    expect(accessorReads).toBe(0);

    host.now = -1;
    await expect(
      runtime.run({ resolvePackage: () => 'never' }, 'resolvePackage', [], { timeoutMs: 1 })
    ).resolves.toEqual({ status: 'effect-failed' });
    const overflow = createDesktopDesignInputRuntime({
      clock: { now: () => Number.MAX_SAFE_INTEGER },
      scheduler: host.scheduler
    });
    await expect(
      overflow.run({ resolvePackage: () => 'never' }, 'resolvePackage', [], { timeoutMs: 1 })
    ).resolves.toEqual({ status: 'effect-failed' });
  });

  it('rejects hostile proxies and deep owner chains before running adapter methods', async () => {
    const host = new FakeHost();
    const runtime = createDesktopDesignInputRuntime({
      clock: host.clock,
      scheduler: host.scheduler
    });
    const unstable = new Proxy(
      { resolvePackage: () => 'unsafe' },
      {
        ownKeys() {
          throw new Error('hostile proxy');
        }
      }
    );
    await expect(runtime.run(unstable, 'resolvePackage', [], { timeoutMs: 1 })).resolves.toEqual({
      status: 'effect-failed'
    });
    let deep: object = { resolvePackage: () => 'unsafe' };
    for (let index = 0; index < 5; index += 1) deep = Object.create(deep);
    await expect(runtime.run(deep, 'resolvePackage', [], { timeoutMs: 1 })).resolves.toEqual({
      status: 'effect-failed'
    });
  });

  it('fences active late work, then recovers the stable loader owner after settlement without isolating others', async () => {
    const host = new FakeHost();
    const runtime = createDesktopDesignInputRuntime({
      clock: host.clock,
      scheduler: host.scheduler
    });
    const latePackage = deferred<ReturnType<typeof packageArtifact>>();
    const contexts: Record<string, unknown>[] = [];
    let packageCalls = 0;
    const loader = createDesktopDesignInputLoader(
      {
        resolvePackage: async (context) => {
          contexts.push(context as unknown as Record<string, unknown>);
          packageCalls += 1;
          return packageCalls === 1 ? latePackage.promise : packageArtifact();
        },
        readDesignLanguage: async (context) => {
          contexts.push(context as unknown as Record<string, unknown>);
          return languageArtifact();
        },
        sha256: async (context, value) => {
          contexts.push(context as unknown as Record<string, unknown>);
          return createHash('sha256').update(value).digest('hex');
        }
      },
      runtime
    );
    const first = loader.load(request, { portTimeoutMs: 5 });
    await Promise.resolve();
    host.advance(5);
    await expect(first).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'port-timeout' })]
    });
    await expect(loader.load(request, { portTimeoutMs: 5 })).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: 'port-failed' })]
    });
    expect(packageCalls).toBe(1);

    const unrelated = createDesktopDesignInputLoader(
      {
        resolvePackage: async () => packageArtifact(),
        readDesignLanguage: async () => languageArtifact(),
        sha256: async (_context, value) => createHash('sha256').update(value).digest('hex')
      },
      runtime
    );
    await expect(unrelated.load(request, { portTimeoutMs: 5 })).resolves.toMatchObject({
      library: { name: '@selene/example-design-library' }
    });

    latePackage.resolve(packageArtifact());
    await Promise.resolve();
    await Promise.resolve();
    await expect(loader.load(request, { portTimeoutMs: 5 })).resolves.toMatchObject({
      library: { name: '@selene/example-design-library' },
      language: {
        sections: expect.arrayContaining([expect.objectContaining({ heading: 'Design' })])
      }
    });
    expect(packageCalls).toBe(2);
    expect(contexts.every((context) => !Object.hasOwn(context, 'deadlineMs'))).toBe(true);
  });
});
