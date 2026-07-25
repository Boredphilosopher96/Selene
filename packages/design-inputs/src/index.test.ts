import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DESIGN_INPUT_LIMITS,
  createDesignInputLoader,
  type DesignInputCallContext,
  DesignInputValidationError,
  type DesignInputRuntime,
  type DesignInputPort,
  type ResolvedDesignLanguage,
  type ResolvedDesignPackage
} from './index';

const markdown = '# Example Design Language\n\n## Principles\n\nUse semantic tokens.';

function packageArtifact(overrides: Record<string, unknown> = {}): ResolvedDesignPackage & {
  readonly files: readonly { readonly path: string; readonly content: string }[];
} {
  const packageJson = {
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
    },
    ...overrides
  };
  return {
    packageJson,
    files: [
      { path: './dist/index.js', content: 'export const Button = {};' },
      { path: './dist/tokens.json', content: '{"color":"blue"}' },
      { path: './DESIGN.md', content: markdown }
    ],
    provenance: { provider: 'test-registry', location: 'npm:@selene/example-design-library@1.0.0' }
  };
}

function languageArtifact(value = markdown): ResolvedDesignLanguage {
  return {
    markdown: value,
    provenance: {
      provider: 'test-registry',
      location: 'npm:@selene/example-design-library@1.0.0/DESIGN.md'
    }
  };
}

const request = {
  package: { name: '@selene/example-design-library', version: '1.0.0' },
  designLanguage: { location: 'design-language:example' },
  requiredPeerDependencies: { react: '^19.0.0' }
};

const integrity = {
  async sha256(_context: DesignInputCallContext, value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
};

const testRuntime: DesignInputRuntime = {
  async run(owner, method, arguments_, options) {
    let cancelled = false;
    const context: DesignInputCallContext = Object.freeze({
      ownerGeneration: 1,
      remainingMs: options.timeoutMs,
      cancellation: Object.freeze({
        isCancellationRequested: () => cancelled,
        reason: () => (cancelled ? 'deadline-exceeded' : undefined),
        subscribe: () => () => undefined
      })
    });
    const effect = (owner as Record<string, unknown>)[method];
    if (typeof effect !== 'function') return Object.freeze({ status: 'effect-failed' as const });
    const timeout = options.timeoutMs;
    const operation = Promise.resolve(Reflect.apply(effect, owner, [context, ...arguments_]));
    try {
      return await Promise.race([
        operation.then((value) => Object.freeze({ status: 'ok' as const, value })),
        new Promise<Readonly<{ status: 'deadline-exceeded' }>>((resolve) => {
          setTimeout(
            () => {
              cancelled = true;
              resolve(Object.freeze({ status: 'deadline-exceeded' as const }));
            },
            Math.max(0, timeout)
          );
        })
      ]);
    } catch {
      return Object.freeze({ status: 'effect-failed' as const });
    }
  }
};

function ingestDesignInputs(
  input: typeof request,
  packageValue: ResolvedDesignPackage,
  languageValue: ResolvedDesignLanguage,
  integrityPort: { sha256: DesignInputPort['sha256'] },
  overrides?: Partial<typeof DEFAULT_DESIGN_INPUT_LIMITS>
) {
  return createDesignInputLoader({
    port: {
      resolvePackage: async () => packageValue,
      readDesignLanguage: async () => languageValue,
      sha256: integrityPort.sha256
    },
    runtime: testRuntime
  }).ingest(input, packageValue, languageValue, overrides);
}

function loadDesignContext(
  port: DesignInputPort,
  input: typeof request,
  overrides?: Partial<typeof DEFAULT_DESIGN_INPUT_LIMITS>
) {
  return createDesignInputLoader({ port, runtime: testRuntime }).load(input, overrides);
}

async function expectIssue(
  packageValue: ResolvedDesignPackage,
  languageValue: ResolvedDesignLanguage,
  code: string
): Promise<void> {
  await expect(
    ingestDesignInputs(request, packageValue, languageValue, integrity)
  ).rejects.toMatchObject({
    issues: [expect.objectContaining({ code })]
  });
}

describe('design input ingestion', () => {
  it('inspects a package without requesting an independent design-language artifact', async () => {
    let languageReads = 0;
    const loader = createDesignInputLoader({
      port: {
        resolvePackage: async () => packageArtifact(),
        readDesignLanguage: async () => {
          languageReads += 1;
          throw new Error('Package inspection must not read an independent language artifact.');
        },
        sha256: integrity.sha256
      },
      runtime: testRuntime
    });

    await expect(
      loader.inspectPackage({
        package: request.package,
        requiredPeerDependencies: request.requiredPeerDependencies
      })
    ).resolves.toMatchObject({ provenance: { provider: 'test-registry' } });
    expect(languageReads).toBe(0);
  });

  it('creates deterministic data-only context with hashes and provenance', async () => {
    const hashCheckedRequest = {
      ...request,
      designLanguage: {
        ...request.designLanguage,
        expectedSha256: '77443c9cd0060a8b59e8563868333780833075f3172419902276d52e407ac355'
      }
    };
    const first = await ingestDesignInputs(
      hashCheckedRequest,
      packageArtifact(),
      languageArtifact(),
      integrity
    );
    const second = await ingestDesignInputs(
      request,
      packageArtifact(),
      languageArtifact(),
      integrity
    );

    expect(first).toEqual(second);
    expect(first.format).toBe('selene-design-context/v1');
    expect(first.records).toHaveLength(5);
    expect(first.records.every((record) => /^[a-f0-9]{64}$/.test(record.sha256))).toBe(true);
    expect(first.language.sections.map((section) => section.heading)).toEqual([
      'Example Design Language',
      'Principles'
    ]);
  });

  it('uses a host port without giving the core package filesystem or installer behavior', async () => {
    const port: DesignInputPort = {
      resolvePackage: async () => packageArtifact(),
      readDesignLanguage: async () => languageArtifact(),
      sha256: integrity.sha256
    };
    await expect(loadDesignContext(port, request)).resolves.toMatchObject({
      library: { name: '@selene/example-design-library' }
    });
  });

  it('captures exact loader options once and reuses one runtime across concurrent loads', async () => {
    let runtimeCalls = 0;
    const runtime: DesignInputRuntime = {
      run: async (owner, method, arguments_, options) => {
        runtimeCalls += 1;
        return await testRuntime.run(owner, method, arguments_, options);
      }
    };
    const port: DesignInputPort = {
      resolvePackage: async () => packageArtifact(),
      readDesignLanguage: async () => languageArtifact(),
      sha256: integrity.sha256
    };
    const loader = createDesignInputLoader({ port, runtime });
    port.resolvePackage = async () => Promise.reject(new Error('mutated port method'));
    runtime.run = async () => Promise.reject(new Error('mutated runtime method'));

    await expect(Promise.all([loader.load(request), loader.load(request)])).resolves.toHaveLength(
      2
    );
    expect(runtimeCalls).toBeGreaterThan(4);
    expect(() => createDesignInputLoader({ port, runtime, unexpected: true } as never)).toThrow(
      DesignInputValidationError
    );
    expect(() =>
      createDesignInputLoader(
        Object.defineProperty({}, 'port', {
          enumerable: true,
          get: () => port
        }) as never
      )
    ).toThrow(DesignInputValidationError);
  });

  it('uses frozen duration requests and snapshots artifacts before adapters can mutate them', async () => {
    const sourcePackage = packageArtifact();
    const sourceLanguage = languageArtifact();
    let receivedOptions: unknown;
    const runtime: DesignInputRuntime = {
      async run(owner, method, arguments_, options) {
        receivedOptions = options;
        return await testRuntime.run(owner, method, arguments_, options);
      }
    };
    const loader = createDesignInputLoader({
      runtime,
      port: {
        resolvePackage: async () => sourcePackage,
        readDesignLanguage: async () => sourceLanguage,
        sha256: integrity.sha256
      }
    });
    const artifacts = await loader.resolveArtifacts(request);
    (sourcePackage.files[0] as { content: string }).content = 'changed after resolution';
    Object.defineProperty(sourceLanguage, 'markdown', {
      configurable: true,
      get: () => {
        throw new Error('adapter markdown was reread');
      }
    });

    expect(artifacts.packageArtifact.files[0]).toEqual({
      path: './dist/index.js',
      content: 'export const Button = {};'
    });
    expect(artifacts.designLanguageArtifact.markdown).toBe(markdown);
    expect(Object.isFrozen(artifacts.packageArtifact.packageJson)).toBe(true);
    expect(
      Object.isFrozen(
        (
          artifacts.packageArtifact.packageJson as {
            readonly selene: { readonly designSystem: object };
          }
        ).selene.designSystem
      )
    ).toBe(true);
    expect(Object.isFrozen(receivedOptions)).toBe(true);
    expect(receivedOptions).toEqual({ timeoutMs: DEFAULT_DESIGN_INPUT_LIMITS.portTimeoutMs });
  });

  it('passes immutable supervisor contexts to npm, Markdown, and integrity effects', async () => {
    const contexts: DesignInputCallContext[] = [];
    const port: DesignInputPort = {
      resolvePackage: async (context) => {
        contexts.push(context);
        return packageArtifact();
      },
      readDesignLanguage: async (context) => {
        contexts.push(context);
        return languageArtifact();
      },
      sha256: async (context, value) => {
        contexts.push(context);
        return createHash('sha256').update(value).digest('hex');
      }
    };

    await expect(loadDesignContext(port, request)).resolves.toMatchObject({
      library: { name: '@selene/example-design-library' }
    });

    expect(contexts).toHaveLength(8);
    expect(contexts.every((context) => Object.isFrozen(context))).toBe(true);
    expect(contexts.every((context) => Object.isFrozen(context.cancellation))).toBe(true);
    expect(contexts.every((context) => context.ownerGeneration > 0)).toBe(true);
    expect(contexts.every((context) => context.cancellation.isCancellationRequested())).toBe(false);
  });

  it('retains one validated request across a host await boundary', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let armProxy = false;
    const mutableRequest = {
      package: { ...request.package },
      designLanguage: { ...request.designLanguage },
      requiredPeerDependencies: { ...request.requiredPeerDependencies }
    };
    const hostileRequest = new Proxy(mutableRequest, {
      getOwnPropertyDescriptor(target, key) {
        if (armProxy) throw new Error('request was read after host resolution');
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });
    const port: DesignInputPort = {
      resolvePackage: async (_context, packageRequest) => {
        expect(packageRequest.name).toBe(request.package.name);
        started();
        await pending;
        return packageArtifact();
      },
      readDesignLanguage: async () => languageArtifact(),
      sha256: integrity.sha256
    };

    const loading = loadDesignContext(port, hostileRequest);
    await resolutionStarted;
    mutableRequest.package.name = '@selene/mutated-after-resolution';
    Object.defineProperty(mutableRequest, 'designLanguage', {
      configurable: true,
      get: () => {
        throw new Error('request accessor was read after host resolution');
      }
    });
    armProxy = true;
    release();

    await expect(loading).resolves.toMatchObject({
      library: { name: '@selene/example-design-library' }
    });
  });

  it('rejects malformed and unavailable host digests without exposing a partial context', async () => {
    const invalidDigest = { sha256: async () => 'not-a-sha256' };
    const unavailableDigest = {
      sha256: async () => Promise.reject(new Error('integrity provider unavailable'))
    };
    await Promise.all(
      [invalidDigest, unavailableDigest].map((substitute) =>
        expect(
          ingestDesignInputs(request, packageArtifact(), languageArtifact(), substitute)
        ).rejects.toBeInstanceOf(DesignInputValidationError)
      )
    );
  });

  it('rejects missing declared artifacts', async () => {
    const artifact = packageArtifact();
    await expectIssue(
      { ...artifact, files: artifact.files.filter((file) => file.path !== './dist/tokens.json') },
      languageArtifact(),
      'missing-input'
    );
  });

  it('rejects malformed package metadata and markdown', async () => {
    await expectIssue(
      packageArtifact({ version: 'latest' }),
      languageArtifact(),
      'malformed-package'
    );
    await expectIssue(
      packageArtifact(),
      languageArtifact('just prose without a heading'),
      'malformed-markdown'
    );
  });

  it('rejects incompatible requested package and peer dependency ranges', async () => {
    await expectIssue(
      packageArtifact({ version: '2.0.0' }),
      languageArtifact(),
      'incompatible-input'
    );
    await expectIssue(
      packageArtifact({ peerDependencies: { react: '^18.0.0' } }),
      languageArtifact(),
      'incompatible-input'
    );
  });

  it('rejects path traversal, lifecycle hooks, and executable markdown', async () => {
    await expectIssue(
      packageArtifact({ exports: { '.': '../outside.js' } }),
      languageArtifact(),
      'unsafe-input'
    );
    await expectIssue(
      packageArtifact({ scripts: { postinstall: 'curl bad.example' } }),
      languageArtifact(),
      'unsafe-input'
    );
    await expectIssue(
      packageArtifact(),
      languageArtifact('# Safe?\n\n[x](javascript:alert(1))'),
      'unsafe-input'
    );
  });

  it('rejects unknown shapes and redacts hostile host failures', async () => {
    const secret = 'registry-token=do-not-disclose';
    const unknownRequest = { ...request, unexpected: true };
    await expect(
      ingestDesignInputs(unknownRequest as never, packageArtifact(), languageArtifact(), integrity)
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'malformed-package' })] });
    await expect(
      ingestDesignInputs(
        request,
        { ...packageArtifact(), provenance: { ...packageArtifact().provenance, secret } } as never,
        languageArtifact(),
        integrity
      )
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'unsafe-input' })] });
    await expect(
      ingestDesignInputs(
        request,
        packageArtifact({ harmlessLookingButUnsupported: true }),
        languageArtifact(),
        integrity
      )
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'malformed-package' })] });
    await expect(
      loadDesignContext(
        {
          resolvePackage: async () => Promise.reject(new Error(secret)),
          readDesignLanguage: async () => languageArtifact(),
          sha256: integrity.sha256
        },
        request
      )
    ).rejects.toMatchObject({
      issues: [expect.not.objectContaining({ message: expect.stringContaining(secret) })]
    });
  });

  it('enforces aggregate budgets and normalizes a hostile port timeout', async () => {
    await expect(
      ingestDesignInputs(request, packageArtifact(), languageArtifact(), integrity, { maxFiles: 2 })
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'budget-exceeded' })] });
    await expect(
      loadDesignContext(
        {
          resolvePackage: async () => new Promise<ResolvedDesignPackage>(() => undefined),
          readDesignLanguage: async () => languageArtifact(),
          sha256: integrity.sha256
        },
        request,
        { portTimeoutMs: 1 }
      )
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'port-timeout' })] });
  });

  it('uses bounded integrity concurrency and returns a deeply frozen context', async () => {
    const artifact = packageArtifact();
    const artifactWithExtraFile = {
      ...artifact,
      files: [...artifact.files, { path: './dist/extra.css', content: 'body{}' }]
    };
    let active = 0;
    let maximum = 0;
    const delayedIntegrity = {
      async sha256(_context: DesignInputCallContext, value: string) {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return createHash('sha256').update(value).digest('hex');
      }
    };
    const context = await ingestDesignInputs(
      request,
      artifactWithExtraFile,
      languageArtifact(),
      delayedIntegrity,
      { maxIntegrityConcurrency: 2 }
    );
    expect(maximum).toBeLessThanOrEqual(2);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.library.selene.components)).toBe(true);
    expect(Object.isFrozen(context.records[0]?.provenance)).toBe(true);
  });

  it('is stack-safe for deeply nested hostile JSON and fuzzes malformed data into typed errors', async () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < DEFAULT_DESIGN_INPUT_LIMITS.maxJsonDepth + 16; index += 1)
      nested = { child: nested };
    await expect(
      ingestDesignInputs(request, packageArtifact({ nested }), languageArtifact(), integrity)
    ).rejects.toBeInstanceOf(DesignInputValidationError);

    await Promise.all(
      Array.from({ length: 64 }, (_unused, seed) => {
        const value =
          seed % 3 === 0 ? null : seed % 3 === 1 ? { ['x'.repeat(seed + 1)]: seed } : [];
        return expect(
          ingestDesignInputs(
            request,
            packageArtifact({ peerDependencies: value }),
            languageArtifact(),
            integrity
          )
        ).rejects.toBeInstanceOf(DesignInputValidationError);
      })
    );
  });

  it('rejects executable async package iterators and snapshots array artifacts before hashing', async () => {
    const artifact = packageArtifact();
    async function* files() {
      yield artifact.files[0]!;
      yield artifact.files[1]!;
      yield artifact.files[2]!;
    }
    const streamed = { ...artifact, files: files() };
    await expect(
      ingestDesignInputs(request, streamed, languageArtifact(), {
        async sha256(_context: DesignInputCallContext, value: string) {
          return createHash('sha256').update(value).digest('hex');
        }
      })
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'malformed-package' })] });

    const mutable = packageArtifact();
    const original = await ingestDesignInputs(
      request,
      packageArtifact(),
      languageArtifact(),
      integrity
    );
    const immutableSnapshot = await ingestDesignInputs(request, mutable, languageArtifact(), {
      async sha256(_context: DesignInputCallContext, value: string) {
        if (value === 'export const Button = {};')
          (mutable.files[1] as { content: string }).content = '{"color":"mutated"}';
        return createHash('sha256').update(value).digest('hex');
      }
    });
    expect(immutableSnapshot).toEqual(original);
  });

  it('normalizes hostile proxy/getter failures and enforces token and Markdown budgets', async () => {
    const secret = 'adapter-secret=/private/host/path';
    const hostile = new Proxy(packageArtifact(), {
      getOwnPropertyDescriptor() {
        throw new Error(secret);
      }
    });
    await expect(
      ingestDesignInputs(request, hostile, languageArtifact(), integrity)
    ).rejects.toMatchObject({
      issues: [
        expect.objectContaining({
          code: 'malformed-package',
          message: expect.not.stringContaining(secret)
        })
      ]
    });
    await expect(
      ingestDesignInputs(request, packageArtifact(), languageArtifact(), integrity, {
        maxTokenNodes: 1
      })
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'budget-exceeded' })] });
    await expect(
      ingestDesignInputs(
        request,
        packageArtifact(),
        languageArtifact('---\ntitle: Example\nowner: Design\n---\n# Example'),
        integrity,
        { maxFrontmatterEntries: 1 }
      )
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'budget-exceeded' })] });
    await expect(
      ingestDesignInputs(
        request,
        packageArtifact(),
        languageArtifact('# Example\n\nimport x from "y"'),
        integrity
      )
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'unsafe-input' })] });
  });
});
