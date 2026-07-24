import { describe, expect, it } from 'vitest';

import {
  activateExtensionPlan,
  createAgentExtensionBridge,
  createDesignInputExtensionBridge,
  createExtensionPlan,
  agentCapability,
  extensionKernelPackageName,
  ExtensionValidationError,
  MAX_EXTENSION_AGENT_TIMEOUT_MS,
  MAX_EXTENSION_ISSUES,
  migrateExtensionManifest,
  satisfiesSemver,
  validateExtensions,
  type ExtensionManifest,
  type ExtensionPolicy
} from './index';
import { DeterministicFakeAdapter, type AgentProviderCallContext } from '@selene/agent-sdk';
import {
  createDesignInputLoader,
  type DesignInputCallContext,
  type DesignInputRuntime
} from '@selene/design-inputs';
import agentSample from '../../../examples/extensions/composed/agent.extension.json';
import designSystemSample from '../../../examples/extensions/composed/design-system.extension.json';
import exporterSample from '../../../examples/extensions/composed/exporter.extension.json';
import policySample from '../../../examples/extensions/composed/policy.extension.json';
import previewSample from '../../../examples/extensions/composed/preview.extension.json';
import reactTemplateSample from '../../../examples/extensions/composed/react-template.extension.json';
import validatorSample from '../../../examples/extensions/composed/validator.extension.json';

const policy: ExtensionPolicy = {
  allowedPermissions: ['agent.execute', 'design-input.read', 'export.write', 'preview.decorate'],
  minimumTrust: 'verified'
};

const agentRuntime = {
  run: async <T>(_owner: object, effect: (context: AgentProviderCallContext) => T): Promise<T> =>
    effect({
      ownerGeneration: 1,
      cancellation: {
        isCancellationRequested: () => false,
        reason: () => undefined,
        subscribe: () => () => undefined
      }
    }),
  runCleanup: async <T>(
    _owner: object,
    effect: (context: AgentProviderCallContext) => T
  ): Promise<T> =>
    effect({
      ownerGeneration: 1,
      cancellation: {
        isCancellationRequested: () => false,
        reason: () => undefined,
        subscribe: () => () => undefined
      }
    }),
  replaceGeneration: () => undefined,
  recover: () => undefined
};

const designInputRuntime: DesignInputRuntime = {
  async run(owner, method, arguments_, options) {
    const context: DesignInputCallContext = Object.freeze({
      ownerGeneration: 1,
      remainingMs: options.timeoutMs,
      cancellation: Object.freeze({
        isCancellationRequested: () => false,
        reason: () => undefined,
        subscribe: () => () => undefined
      })
    });
    const effect = (owner as Record<string, unknown>)[method];
    if (typeof effect !== 'function') return Object.freeze({ status: 'effect-failed' as const });
    return Object.freeze({
      status: 'ok' as const,
      value: await Reflect.apply(effect, owner, [context, ...arguments_])
    });
  }
};

function manifest(id: string, overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    manifestVersion: '1.0',
    id,
    version: '1.2.3',
    kind: 'react-template',
    capabilities: ['template.generate'],
    permissions: [],
    trust: {
      level: 'verified',
      provenance: { publisher: 'selene', source: 'npm:@selene/example' },
      integrity: { sha256: `sha256-${'A'.repeat(43)}=`, source: 'npm:@selene/example' }
    },
    ...overrides
  };
}

describe('extension kernel', () => {
  it('exports a stable package identifier and semver matcher', () => {
    expect(extensionKernelPackageName).toBe('@selene/extension-kernel');
    expect(satisfiesSemver('1.2.3', '^1.0.0')).toBe(true);
    expect(satisfiesSemver('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfiesSemver('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesSemver('0.0.4', '^0.0.3')).toBe(false);
  });

  it('orders dependencies and lifecycle commands deterministically', () => {
    const plan = createExtensionPlan(
      [
        manifest('app.template', {
          dependencies: [{ id: 'base.library', range: '^1.0.0' }],
          configuration: { defaults: { language: 'tsx' }, required: ['language'] },
          lifecycle: [{ id: 'activate-template', event: 'activate', input: { strict: true } }]
        }),
        manifest('base.library', { lifecycle: [{ id: 'install-library', event: 'install' }] })
      ],
      policy
    );
    expect(plan.extensions.map((extension) => extension.manifest.id)).toEqual([
      'base.library',
      'app.template'
    ]);
    expect(plan.lifecycle).toEqual([
      { extensionId: 'base.library', event: 'install', commandId: 'install-library', input: {} },
      {
        extensionId: 'app.template',
        event: 'activate',
        commandId: 'activate-template',
        input: { language: 'tsx', strict: true }
      }
    ]);
  });

  it('fails closed for cycles, forbidden permissions, and bad integrity', async () => {
    expect(() =>
      createExtensionPlan(
        [
          manifest('a.extension', { dependencies: [{ id: 'b.extension', range: '^1.0.0' }] }),
          manifest('b.extension', { dependencies: [{ id: 'a.extension', range: '^1.0.0' }] })
        ],
        policy
      )
    ).toThrow(/cycle/);
    expect(() =>
      createExtensionPlan([manifest('bad.extension', { permissions: ['export.write'] })], {
        ...policy,
        allowedPermissions: []
      })
    ).toThrow(/permission/);
    const plan = createExtensionPlan([manifest('safe.extension')], policy);
    await expect(
      activateExtensionPlan(plan, policy, {
        integrity: { verify: () => false },
        emit: () => undefined
      })
    ).rejects.toThrow(/integrity/);
  });

  it('validates typed configuration and design-system contributions', () => {
    const designLibrary = manifest('design.library', {
      kind: 'design-library',
      configuration: {
        schema: {
          type: 'object',
          properties: {
            viewport: { type: 'string', enum: ['mobile', 'desktop'] },
            scale: { type: 'integer', minimum: 1 }
          },
          required: ['viewport'],
          additionalProperties: false
        }
      },
      contributes: {
        designSystem: {
          tokenCollections: [
            {
              id: 'color',
              modes: [
                { kind: 'theme', id: 'light', label: 'Light' },
                { kind: 'theme', id: 'dark', label: 'Dark' },
                { kind: 'viewport', id: 'mobile', label: 'Mobile' }
              ],
              tokens: [
                { id: 'surface', value: '#fff', modes: { dark: '#111' } },
                { id: 'surface-muted', value: '#eee', aliases: [{ target: 'surface' }] }
              ]
            }
          ],
          components: [
            {
              id: 'button',
              exportName: 'Button',
              variants: [{ id: 'tone', values: ['primary', 'secondary'] }],
              slots: [{ id: 'icon' }, { id: 'children', required: true }]
            }
          ]
        }
      }
    });
    expect(() =>
      createExtensionPlan([designLibrary], policy, {
        'design.library': { viewport: 'desktop', scale: 2 }
      })
    ).not.toThrow();
    expect(() =>
      createExtensionPlan([designLibrary], policy, {
        'design.library': { viewport: 'tablet', scale: 2 }
      })
    ).toThrow(/allowed value/);
  });

  it('migrates the supported v0.9 type field and rejects unknown schema versions', () => {
    const legacy = {
      ...manifest('legacy.template'),
      manifestVersion: '0.9',
      type: 'react-template'
    };
    delete (legacy as { kind?: string }).kind;
    const migrated = migrateExtensionManifest(legacy);
    expect(migrated.kind).toBe('react-template');
    expect(migrated).not.toHaveProperty('type');
    expect(() =>
      migrateExtensionManifest({ ...manifest('future.template'), manifestVersion: '2.0' })
    ).toThrow(/unsupported manifest version/);
  });

  it('rejects unsupported lifecycle and manifest schema values without executing them', () => {
    expect(() =>
      createExtensionPlan(
        [
          manifest('unsafe.lifecycle', {
            lifecycle: [{ id: 'run-anything', event: 'run' as 'activate' }]
          })
        ],
        policy
      )
    ).toThrow(/lifecycle/);
    expect(() =>
      createExtensionPlan(
        [manifest('unsafe.permission', { permissions: ['filesystem.write' as 'export.write'] })],
        policy
      )
    ).toThrow(/permissions/);
    expect(() =>
      createExtensionPlan(
        [
          manifest('unsafe.alias', {
            kind: 'design-library',
            contributes: {
              designSystem: {
                tokenCollections: [
                  {
                    id: 'colors',
                    modes: [],
                    tokens: [{ id: 'surface', value: '#fff', aliases: [{ target: 'missing' }] }]
                  }
                ],
                components: []
              }
            }
          })
        ],
        policy
      )
    ).toThrow(/design-system/);
    expect(() =>
      migrateExtensionManifest({
        ...manifest('unsafe.schema'),
        configuration: {
          schema: { type: 'object', properties: { name: { type: 'string', pattern: '[' } } }
        }
      })
    ).toThrow(/configuration schema/);
  });

  it('never compiles manifest-provided regex and bounds malformed parser input', () => {
    expect(() =>
      migrateExtensionManifest({
        ...manifest('unsafe.pattern'),
        configuration: {
          schema: {
            type: 'object',
            properties: { name: { type: 'string', pattern: '^(a+)+$' } }
          }
        }
      })
    ).toThrow(/configuration schema/);
    const tooMany = Array.from({ length: 96 }, (_, index) => manifest(`bounded-${index}`));
    const issues = validateExtensions(tooMany, policy);
    expect(issues).toHaveLength(1);
    expect(issues.length).toBeLessThanOrEqual(MAX_EXTENSION_ISSUES);
    expect(() =>
      migrateExtensionManifest({ ...manifest('deep.data'), extra: [[[[]]]] })
    ).not.toThrow();
  });

  it('fuzzes bounded unknown manifests without leaking host exceptions', () => {
    const accessor = {};
    Object.defineProperty(accessor, 'id', {
      enumerable: true,
      get: () => {
        throw new Error('host getter must not run');
      }
    });
    const reserved = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(reserved, '__proto__', { enumerable: true, value: 'reject' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolKeyed = { ...manifest('symbol-keyed') };
    Object.defineProperty(symbolKeyed, Symbol('untrusted'), { enumerable: true, value: 'reject' });
    const overDeep = Array.from({ length: 18 }).reduce<unknown>((value) => [value], 'leaf');
    const candidates: unknown[] = [
      null,
      [],
      accessor,
      reserved,
      cyclic,
      symbolKeyed,
      { ...manifest('too-many-fields'), values: Array.from({ length: 257 }, () => 'x') },
      { ...manifest('too-deep'), values: overDeep },
      { ...manifest('bad-dependency'), dependencies: [{ id: 'safe.extension', range: null }] },
      { ...manifest('bad-lifecycle'), lifecycle: [{ id: 'run', event: 'activate', input: [] }] }
    ];
    let arrayOwnKeys = 0;
    const hugeArray = new Proxy([], {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'length')
          return { value: 1_000_000_000, writable: true, enumerable: false, configurable: false };
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys() {
        arrayOwnKeys += 1;
        throw new Error('unbounded array enumeration');
      }
    });
    expect(validateExtensions(hugeArray as never, policy)[0]?.code).toBe('invalid-manifest');
    expect(arrayOwnKeys).toBe(0);
    for (const candidate of candidates) {
      expect(() => migrateExtensionManifest(candidate)).toThrow(
        /manifest|configuration|dependencies|lifecycle/
      );
    }
  });

  it('snapshots plans, rejects forged plans, and validates bounded host ports', async () => {
    const source = manifest('snapshot.template', {
      lifecycle: [{ id: 'activate-snapshot', event: 'activate', input: { mode: 'safe' } }]
    });
    const plan = createExtensionPlan([source], policy);
    const sourceInput = source.lifecycle?.[0]?.input;
    if (sourceInput === undefined) throw new Error('fixture must include lifecycle input');
    (sourceInput as { mode: string }).mode = 'mutated';
    expect(plan.lifecycle[0]?.input).toEqual({ mode: 'safe' });
    expect(Object.isFrozen(plan)).toBe(true);
    await expect(
      activateExtensionPlan({ ...plan }, policy, { emit: () => undefined })
    ).rejects.toThrow(/created by this kernel/);
    await expect(
      activateExtensionPlan(plan, policy, {
        integrity: { verify: () => 'yes' as unknown as boolean },
        emit: () => undefined
      })
    ).rejects.toThrow(/integrity/);
    await expect(
      activateExtensionPlan(plan, policy, { integrity: { verify: () => true } } as never)
    ).rejects.toThrow(/event host port/);
  });

  it('normalizes hostile public inputs and binds activation to its exact policy', async () => {
    const arraySubclass = class extends Array<unknown> {};
    const hiddenArray = [manifest('hidden-array')];
    Object.defineProperty(hiddenArray, 'extra', { enumerable: false, value: 'reject' });
    const sparseArray = new Array(1) as unknown[];
    const hostileValues: unknown[] = [new arraySubclass(), hiddenArray, sparseArray];
    for (const value of hostileValues)
      expect(() => validateExtensions(value as never, policy)).not.toThrow();
    expect(validateExtensions(new arraySubclass(), policy)[0]?.code).toBe('invalid-manifest');
    expect(validateExtensions(hiddenArray, policy)[0]?.code).toBe('invalid-manifest');
    expect(validateExtensions(sparseArray, policy)[0]?.code).toBe('invalid-manifest');
    expect(satisfiesSemver({ trim: () => '1.0.0' }, '^1.0.0')).toBe(false);
    expect(satisfiesSemver('1.0.0', 'x'.repeat(16 * 1024 + 1))).toBe(false);
    expect(() => agentCapability({ toString: () => 'project.inspect' })).toThrow(/invalid agent/);
    const hostileIssues = {};
    Object.defineProperty(hostileIssues, 'map', {
      get: () => {
        throw new Error('must not read map');
      }
    });
    expect(() => {
      void new ExtensionValidationError(hostileIssues);
    }).not.toThrow();
    const forged = new ExtensionValidationError([
      { code: 'invalid-manifest', extensionIds: [], message: 'forged caller message' }
    ]);
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw forged;
        }
      }
    );
    expect(() => createAgentExtensionBridge(proxy as never, { runtime: agentRuntime })).toThrow(
      /safe host ports/
    );

    const plan = createExtensionPlan([manifest('policy-bound')], policy);
    let effects = 0;
    await expect(
      activateExtensionPlan(
        plan,
        { ...policy, allowedPermissions: [] },
        {
          integrity: { verify: () => true },
          emit: () => {
            effects += 1;
          }
        }
      )
    ).rejects.toThrow(/policy/);
    expect(effects).toBe(0);

    const hostileLoader = {};
    Object.defineProperty(hostileLoader, 'resolveArtifacts', {
      get: () => {
        throw new Error('loader getter must not run');
      }
    });
    expect(() =>
      createDesignInputExtensionBridge(hostileLoader as never, (() => ({})) as never)
    ).toThrow(/safe resolvers/);
    const subclassedCallback = () => ({});
    Object.setPrototypeOf(subclassedCallback, {});
    expect(() =>
      createDesignInputExtensionBridge(
        createDesignInputLoader({
          port: {
            resolvePackage: async () => ({
              packageJson: {},
              files: [],
              provenance: { provider: 'x', location: 'x' }
            }),
            readDesignLanguage: async () => ({
              markdown: 'x',
              provenance: { provider: 'x', location: 'x' }
            }),
            sha256: async () => 'a'.repeat(64)
          },
          runtime: designInputRuntime
        }),
        subclassedCallback as never
      )
    ).toThrow(/safe resolvers/);
  });

  it('caps agent timeout and closes an over-budget iterator', async () => {
    let optionsOwnKeys = 0;
    const boundedOptions = new Proxy(
      { runtime: agentRuntime },
      {
        ownKeys() {
          optionsOwnKeys += 1;
          throw new Error('unbounded options enumeration');
        }
      }
    );
    expect(() =>
      createAgentExtensionBridge(
        { capabilities: ['project.inspect'], async *stream() {} },
        boundedOptions as never
      )
    ).not.toThrow();
    expect(optionsOwnKeys).toBe(0);
    expect(() =>
      createAgentExtensionBridge(
        { capabilities: ['project.inspect'], async *stream() {} },
        { runtime: agentRuntime, timeoutMs: MAX_EXTENSION_AGENT_TIMEOUT_MS + 1 }
      )
    ).toThrow(/safe host ports/);
    let closed = false;
    const bridge = createAgentExtensionBridge(
      {
        capabilities: ['project.inspect'],
        async *stream(_context, execution) {
          try {
            for (let index = 0; index < 257; index += 1)
              yield {
                protocolVersion: '1.0' as const,
                kind: 'event' as const,
                messageId: `message-${index}`,
                sentAt: '2026-07-24T00:00:00Z',
                requestId: execution.requestId,
                event: 'progress' as const
              };
          } finally {
            closed = true;
          }
        }
      },
      { runtime: agentRuntime }
    );
    await expect(
      (async () => {
        for await (const event of bridge.stream({
          requestId: 'request-1',
          capability: 'project.inspect',
          input: {}
        }))
          void event;
      })()
    ).rejects.toThrow(/event limit/);
    expect(closed).toBe(true);
  });

  it('contains hostile adapter and design-port output at the consumer boundary', async () => {
    const hostile = createAgentExtensionBridge(
      {
        capabilities: ['project.inspect'],
        async *stream() {
          yield { kind: 'event', requestId: 'request-1' } as never;
        }
      },
      { runtime: agentRuntime }
    );
    await expect(
      (async () => {
        for await (const event of hostile.stream({
          requestId: 'request-1',
          capability: 'project.inspect',
          input: {}
        })) {
          // The malformed envelope must be rejected before a consumer observes it.
          void event;
        }
      })()
    ).rejects.toThrow(/invalid event/);
    const design = createDesignInputExtensionBridge(
      createDesignInputLoader({
        port: {
          resolvePackage: async () => ({
            packageJson: {},
            files: [],
            provenance: { provider: 'test', location: 'package' }
          }),
          readDesignLanguage: async () => ({
            markdown: '# Design',
            provenance: { provider: 'test', location: 'design' }
          }),
          sha256: async () => 'a'.repeat(64)
        },
        runtime: designInputRuntime
      }),
      () => ({ format: 'wrong' }) as never
    );
    const request = {
      package: { name: '@selene/test', version: '1.0.0' },
      designLanguage: { location: 'design' }
    };
    const artifacts = await design.resolve(request);
    expect(() => design.toContext(request, artifacts)).toThrow(/context decoder/);
  });

  it('bridges existing agent-sdk and design-input adapters without runtime imports', async () => {
    const agent = createAgentExtensionBridge(
      new DeterministicFakeAdapter({
        'template.generate': { events: [{ event: 'completed', output: { ok: true } }] }
      }),
      { runtime: agentRuntime }
    );
    expect(agent.supports('template.generate')).toBe(true);
    const events = [];
    for await (const event of agent.stream({
      requestId: 'request-1',
      capability: 'template.generate',
      input: {}
    }))
      events.push(event.event);
    expect(events).toEqual(['completed']);

    const design = createDesignInputExtensionBridge(
      createDesignInputLoader({
        port: {
          resolvePackage: async () => ({
            packageJson: {},
            files: [],
            provenance: { provider: 'test', location: 'package' }
          }),
          readDesignLanguage: async () => ({
            markdown: '# Design',
            provenance: { provider: 'test', location: 'design' }
          }),
          sha256: async () => 'a'.repeat(64)
        },
        runtime: designInputRuntime
      }),
      (_request, packageArtifact, designLanguageArtifact) => ({
        format: 'selene-design-context/v1',
        library: {} as never,
        language: {} as never,
        records: [],
        sha256: `${packageArtifact.provenance.location}:${designLanguageArtifact.provenance.location}`
      })
    );
    const artifacts = await design.resolve({
      package: { name: '@selene/test', version: '1.0.0' },
      designLanguage: { location: 'design' }
    });
    expect(
      design.toContext(
        {
          package: { name: '@selene/test', version: '1.0.0' },
          designLanguage: { location: 'design' }
        },
        artifacts
      ).sha256
    ).toBe('package:design');
  });

  it('plans the composed custom agent, npm library, template, decorator, validator, exporter, and policy samples', () => {
    const plan = createExtensionPlan(
      [
        agentSample,
        designSystemSample,
        reactTemplateSample,
        previewSample,
        validatorSample,
        exporterSample,
        policySample
      ] as unknown as ExtensionManifest[],
      policy,
      { 'enterprise.react-template': { viewport: 'desktop' } }
    );
    expect(plan.extensions.map((extension) => extension.manifest.kind)).toEqual([
      'agent',
      'design-library',
      'validator',
      'exporter',
      'policy',
      'react-template',
      'preview-decorator'
    ]);
  });
});
