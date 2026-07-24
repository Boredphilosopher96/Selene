import { describe, expect, it } from 'vitest';

import {
  activateExtensionPlan,
  createAgentExtensionBridge,
  createDesignInputExtensionBridge,
  createExtensionPlan,
  extensionKernelPackageName,
  migrateExtensionManifest,
  satisfiesSemver,
  type ExtensionManifest,
  type ExtensionPolicy
} from './index';
import { DeterministicFakeAdapter } from '@selene/agent-sdk';
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
        'design.library': { viewport: 'tablet', scale: 0 }
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

  it('bridges existing agent-sdk and design-input adapters without runtime imports', async () => {
    const agent = createAgentExtensionBridge(
      new DeterministicFakeAdapter({
        'template.generate': { events: [{ event: 'completed', output: { ok: true } }] }
      })
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
      {
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
