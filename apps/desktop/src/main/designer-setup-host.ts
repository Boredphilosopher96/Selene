import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createDesktopDesignInputLoader } from './design-input-runtime';
import { LocalProjectLifecycleService } from './project-lifecycle';

import type {
  DesignInputCallContext,
  DesignInputPort,
  DesignInputRuntime,
  InputProvenance
} from '@selene/design-inputs';

export interface DesignSystemReceipt {
  /** Staging is deliberately not activation: no package code is installed or imported. */
  readonly status: 'staged';
  readonly packageName: string;
  readonly version: string;
  readonly exports: readonly string[];
  readonly peerCompatibility: 'compatible';
  readonly provenance: InputProvenance;
  readonly artifactDigest: string;
  readonly fixture?: string;
}

export interface MarkdownDesignLanguageReceipt {
  readonly status: 'staged';
  readonly provenance: InputProvenance;
  readonly artifactDigest: string;
  readonly sectionCount: number;
}
export interface ProjectSetupReceipt {
  readonly projectId: string;
  readonly name: string;
  readonly origin: 'created' | 'template' | 'imported' | 'sample' | 'duplicated';
  readonly revisionId: string;
}

export interface RecentProject {
  readonly id: string;
  readonly name: string;
}

export interface DesignSystemCatalogPolicy {
  readonly requiredPeerDependencies: Readonly<Record<string, string>>;
  readonly provider: {
    readonly label: string;
    readonly fixture?: 'demo-only-local-catalog';
    supports(input: { readonly name: string; readonly version: string }): boolean;
  };
}

const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function data(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(descriptors);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== 'string' || !keys.includes(key))
    )
      throw new Error();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      )
        throw new Error();
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch {
    throw new Error('Setup request must be an exact data object.');
  }
}

function request(value: unknown): { readonly name: string; readonly version: string } {
  const input = data(value, ['name', 'version']);
  if (
    typeof input.name !== 'string' ||
    !packagePattern.test(input.name) ||
    typeof input.version !== 'string' ||
    !versionPattern.test(input.version)
  )
    throw new Error('Package name and exact semantic version are required.');
  return { name: input.name, version: input.version };
}

interface SafeArray extends ReadonlyArray<SafeValue> {
  readonly length: number;
}
interface SafeObject {
  [key: string]: SafeValue;
}
type SafeValue = null | boolean | number | string | SafeArray | SafeObject;

/**
 * Provider responses are treated as hostile data. This never reads a property directly,
 * invokes toJSON, or preserves a provider-owned object in a receipt/digest.
 */
function snapshot(value: unknown, depth = 0, remaining = { value: 2 * 1024 * 1024 }): SafeValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    remaining.value -= typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 8;
    if (remaining.value < 0)
      throw new Error('Catalog artifact metadata exceeds the staging limit.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Catalog artifact metadata contains an invalid number.');
    remaining.value -= 16;
    if (remaining.value < 0)
      throw new Error('Catalog artifact metadata exceeds the staging limit.');
    return value;
  }
  if (typeof value !== 'object' || depth >= 8)
    throw new Error('Catalog artifact metadata is not bounded data.');
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string'))
      throw new Error('Catalog artifact metadata has symbol keys.');
    if (Array.isArray(value)) {
      const length = descriptors.length;
      if (
        !length ||
        !Object.prototype.hasOwnProperty.call(length, 'value') ||
        !Number.isSafeInteger(length.value) ||
        length.value > 512
      )
        throw new Error('Catalog artifact metadata has an invalid array.');
      const result: SafeValue[] = [];
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        )
          throw new Error('Catalog artifact metadata has a sparse or accessor array.');
        result.push(snapshot(descriptor.value, depth + 1, remaining));
      }
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error('Catalog artifact metadata has symbol keys.');
        if (key !== 'length' && (!/^0$|^[1-9]\d*$/.test(key) || Number(key) >= length.value))
          throw new Error('Catalog artifact metadata has unexpected array keys.');
      }
      return Object.freeze(result);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('Catalog artifact metadata has an unsupported prototype.');
    const result: SafeObject = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('Catalog artifact metadata has symbol keys.');
      if (!/^[A-Za-z0-9._@/-]{1,160}$/.test(key))
        throw new Error('Catalog artifact metadata has an invalid key.');
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      )
        throw new Error('Catalog artifact metadata has an accessor.');
      remaining.value -= Buffer.byteLength(key, 'utf8');
      if (remaining.value < 0)
        throw new Error('Catalog artifact metadata exceeds the staging limit.');
      result[key] = snapshot(descriptor.value, depth + 1, remaining);
    }
    return Object.freeze(result);
  } catch (error) {
    throw error instanceof Error ? error : new Error('Catalog artifact metadata is unreadable.');
  }
}

function canonical(value: SafeValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return `{${Object.keys(descriptors)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(descriptors[key]!.value as SafeValue)}`)
    .join(',')}}`;
}

function isSafeObject(value: SafeValue): value is SafeObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: SafeValue): Readonly<Record<string, SafeValue>> | undefined {
  return isSafeObject(value) ? value : undefined;
}

function manifestExports(value: SafeValue): readonly string[] {
  const manifest = recordValue(value);
  const exports = manifest ? recordValue(manifest.exports ?? null) : undefined;
  return exports ? Object.keys(exports).sort() : [];
}

function receiptProvenance(value: unknown): InputProvenance {
  const provenance = recordValue(snapshot(value));
  const provider = provenance?.provider;
  const location = provenance?.location;
  const retrievedAt = provenance?.retrievedAt;
  if (
    typeof provider !== 'string' ||
    provider.length === 0 ||
    provider.length > 64 ||
    typeof location !== 'string' ||
    location.length === 0 ||
    location.length > 512 ||
    (retrievedAt !== undefined && (typeof retrievedAt !== 'string' || retrievedAt.length > 128))
  )
    throw new Error('Catalog provenance is invalid.');
  return Object.freeze({
    provider,
    location,
    ...(typeof retrievedAt === 'string' ? { retrievedAt } : {})
  });
}

function packageReceipt(
  value: unknown,
  peers: Readonly<Record<string, string>>
): {
  readonly exports: readonly string[];
  readonly provenance: InputProvenance;
  readonly artifactDigest: string;
} {
  // This is the first and only inspection of a provider-returned artifact. `snapshot`
  // traverses descriptors into inert data; nothing below can invoke a provider getter/toJSON.
  const artifact = recordValue(snapshot(value));
  const manifest = artifact?.packageJson;
  const files = artifact?.files;
  const provenance = artifact?.provenance;
  if (!artifact || manifest === undefined || !Array.isArray(files) || provenance === undefined)
    throw new Error('Catalog package artifact is invalid.');
  const canonicalValue: SafeValue = Object.freeze({
    manifest,
    files: Object.freeze(
      [...files].sort((left, right) => canonical(left).localeCompare(canonical(right)))
    ),
    peerRequirements: Object.freeze(
      Object.entries(peers)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, version]) => Object.freeze({ name, version }))
    ),
    provenance
  });
  return Object.freeze({
    exports: manifestExports(manifest),
    provenance: receiptProvenance(provenance),
    artifactDigest: createHash('sha256').update(canonical(canonicalValue)).digest('hex')
  });
}

function localPackageInspectionPort(port: DesignInputPort): DesignInputPort {
  return Object.freeze({
    resolvePackage: port.resolvePackage.bind(port),
    sha256: port.sha256.bind(port),
    async readDesignLanguage() {
      return {
        markdown: '# Package inspection\n\n## Metadata\n\nOnly package metadata is staged.',
        provenance: {
          provider: 'desktop-package-inspection',
          location: 'local://package-inspection'
        }
      };
    }
  });
}

function localMarkdownStagingPort(markdown: string, location: string): DesignInputPort {
  return Object.freeze({
    async resolvePackage() {
      return {
        packageJson: {
          name: '@selene/local-markdown-stage',
          version: '1.0.0',
          peerDependencies: { react: '^19.0.0' },
          exports: { '.': './index.js' },
          selene: {
            designSystem: {
              schemaVersion: '1',
              tokenFiles: ['./tokens.json'],
              components: [{ name: 'MarkdownStage', exportName: 'MarkdownStage', entrypoint: '.' }]
            }
          }
        },
        files: [
          { path: './index.js', content: 'export const MarkdownStage = Object.freeze({});' },
          { path: './tokens.json', content: '{"color":"#2563eb"}' }
        ],
        provenance: {
          provider: 'desktop-local-markdown-stage',
          location: 'local://guided-setup/schema'
        }
      };
    },
    async readDesignLanguage() {
      return { markdown, provenance: { provider: 'desktop-local-content', location } };
    },
    async sha256(_context: DesignInputCallContext, content: string) {
      return createHash('sha256').update(content).digest('hex');
    }
  });
}

/** Provider-agnostic host port. It validates data only and never installs or imports a package. */
export class DesktopDesignSystemIntake {
  public constructor(
    private readonly port: DesignInputPort,
    private readonly runtime: DesignInputRuntime,
    private readonly policy: DesignSystemCatalogPolicy
  ) {}

  public async inspectPackage(value: unknown): Promise<DesignSystemReceipt> {
    const packageRequest = request(value);
    if (!this.policy.provider.supports(packageRequest))
      throw new Error(
        `${this.policy.provider.label} is unavailable for ${packageRequest.name}@${packageRequest.version}; no package was staged.`
      );
    // The inspection adapter supplies its own local validation document. It never asks the
    // configured package provider for npm:<package>/DESIGN.md.
    const loader = createDesktopDesignInputLoader(
      localPackageInspectionPort(this.port),
      this.runtime
    );
    const artifacts = await loader.resolveArtifacts({
      package: packageRequest,
      designLanguage: { location: 'local://package-inspection' },
      requiredPeerDependencies: this.policy.requiredPeerDependencies
    });
    // Ingest validates the staged package against the local inspection document without a
    // second effect call, installation, import, or design-language lookup from npm.
    await loader.ingest(
      artifacts.request,
      artifacts.packageArtifact,
      artifacts.designLanguageArtifact
    );
    const receipt = packageReceipt(artifacts.packageArtifact, this.policy.requiredPeerDependencies);
    return {
      status: 'staged',
      packageName: packageRequest.name,
      version: packageRequest.version,
      exports: receipt.exports,
      peerCompatibility: 'compatible',
      provenance: receipt.provenance,
      artifactDigest: receipt.artifactDigest,
      ...(this.policy.provider.fixture ? { fixture: this.policy.provider.label } : {})
    };
  }

  public async ingestMarkdown(value: unknown): Promise<MarkdownDesignLanguageReceipt> {
    const markdown = data(value, ['markdown']).markdown;
    if (typeof markdown !== 'string' || markdown.length === 0 || markdown.length > 256 * 1024)
      throw new Error('Markdown must be between 1 and 262144 characters.');
    const location = 'local://guided-setup/markdown';
    // Markdown staging deliberately owns a tiny local validation package. It is independent
    // of whichever optional npm catalog adapter is configured for package inspection.
    const loader = createDesktopDesignInputLoader(
      localMarkdownStagingPort(markdown, location),
      this.runtime
    );
    const context = await loader.load({
      package: { name: '@selene/local-markdown-stage', version: '1.0.0' },
      designLanguage: { location },
      requiredPeerDependencies: this.policy.requiredPeerDependencies
    });
    return {
      status: 'staged',
      provenance: { provider: 'desktop-local-content', location },
      artifactDigest: createHash('sha256').update(markdown).digest('hex'),
      sectionCount: context.language.sections.length
    };
  }
}

/** Narrow adapter over the sole local-project lifecycle; no renderer path reaches it. */
export class DesktopProjectSetup {
  public constructor(
    private readonly lifecycle: LocalProjectLifecycleService,
    private readonly workspace: (
      projectId: string,
      template: 'blank' | 'dashboard' | 'review'
    ) => import('@selene/core').ReactSourceWorkspace
  ) {}
  public async create(value: unknown): Promise<ProjectSetupReceipt> {
    const input = data(value, ['id', 'name', 'template']);
    if (
      typeof input.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(input.id) ||
      typeof input.name !== 'string' ||
      input.name.trim().length === 0 ||
      input.name.length > 120 ||
      (input.template !== 'blank' && input.template !== 'dashboard' && input.template !== 'review')
    )
      throw new Error('Project create request is invalid.');
    const record = await this.lifecycle.create({
      id: input.id,
      name: input.name.trim(),
      origin: input.template === 'blank' ? 'created' : 'template',
      workspace: this.workspace(input.id, input.template)
    });
    return {
      projectId: record.project.id,
      name: record.project.name,
      origin: record.project.origin as 'created' | 'template',
      revisionId: record.current.revision.id
    };
  }

  /** Bounded metadata inventory; workspaces and lifecycle timestamps stay in the host. */
  public async listRecent(): Promise<readonly RecentProject[]> {
    return (await this.lifecycle.listRecent())
      .slice(0, 12)
      .map(({ id, name }) => Object.freeze({ id, name }));
  }

  /** Exact renderer input is validated before the lifecycle performs a durable open. */
  public async openProject(value: unknown) {
    const input = data(value, ['projectId']);
    if (typeof input.projectId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.projectId))
      throw new Error('Project open request is invalid.');
    return this.lifecycle.open(input.projectId);
  }

  public async open(projectId: string) {
    return this.lifecycle.open(projectId);
  }
  public async importText(value: unknown): Promise<ProjectSetupReceipt> {
    const input = data(value, ['contents']);
    if (
      typeof input.contents !== 'string' ||
      Buffer.byteLength(input.contents, 'utf8') > 1024 * 1024
    )
      throw new Error('Project import is invalid or exceeds 1 MiB.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.contents) as unknown;
    } catch {
      throw new Error('Project import JSON is invalid.');
    }
    const record = await this.lifecycle.importRecord(parsed);
    return {
      projectId: record.project.id,
      name: record.project.name,
      origin: 'imported',
      revisionId: record.current.revision.id
    };
  }
  public async importFile(path: string): Promise<ProjectSetupReceipt> {
    const contents = await readFile(path, 'utf8');
    return this.importText({ contents });
  }
}

/** Explicit demo-only adapter: it labels its local fixture and supports one exact catalog entry. */
export function createLocalCatalogFixturePort(): DesignInputPort {
  const name = '@selene/design-tokens';
  const version = '1.0.0';
  const markdown = '# Design\n\n## Principles\n\nUse semantic tokens.';
  return {
    async resolvePackage(_context, input) {
      if (input.name !== name || input.version !== version)
        throw new Error('Fixture catalog has no matching package.');
      return {
        packageJson: {
          name,
          version,
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
          { path: './DESIGN.md', content: markdown }
        ],
        provenance: {
          provider: 'desktop-local-catalog-fixture',
          location: `npm:${name}@${version}`
        }
      };
    },
    async readDesignLanguage() {
      return {
        markdown,
        provenance: {
          provider: 'desktop-local-catalog-fixture',
          location: `npm:${name}@${version}/DESIGN.md`
        }
      };
    },
    async sha256(_context, value) {
      return createHash('sha256').update(value).digest('hex');
    }
  };
}
