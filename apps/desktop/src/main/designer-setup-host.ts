import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createDesktopDesignInputLoader } from './design-input-runtime';
import { LocalProjectLifecycleService } from './project-lifecycle';

import type {
  DesignInputPort,
  DesignInputRuntime,
  InputProvenance,
  ResolvedDesignPackage
} from '@selene/design-inputs';

export interface DesignSystemReceipt {
  readonly status: 'staged' | 'approved' | 'activated';
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
export interface ProjectSetupReceipt { readonly projectId: string; readonly name: string; readonly origin: 'created' | 'template' | 'imported'; readonly revisionId: string; }

export interface DesignSystemCatalogPolicy {
  readonly requiredPeerDependencies: Readonly<Record<string, string>>;
  readonly markdownValidationPackage: { readonly name: string; readonly version: string };
  readonly fixtureLabel?: string;
}

const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function data(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(descriptors);
    if (own.length !== keys.length || own.some((key) => typeof key !== 'string' || !keys.includes(key))) throw new Error();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw new Error();
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch { throw new Error('Setup request must be an exact data object.'); }
}

function request(value: unknown): { readonly name: string; readonly version: string } {
  const input = data(value, ['name', 'version']);
  if (typeof input.name !== 'string' || !packagePattern.test(input.name) || typeof input.version !== 'string' || !versionPattern.test(input.version))
    throw new Error('Package name and exact semantic version are required.');
  return { name: input.name, version: input.version };
}

function digestPackage(value: ResolvedDesignPackage, peers: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify({
    manifest: value.packageJson,
    files: [...value.files].map((file) => ({ path: file.path, content: file.content })).sort((a, b) => a.path.localeCompare(b.path)),
    peerRequirements: Object.entries(peers).sort(([a], [b]) => a.localeCompare(b)),
    provenance: value.provenance
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function manifestExports(value: unknown): readonly string[] {
  try {
    const snapshot = JSON.parse(JSON.stringify(value)) as { readonly exports?: unknown };
    return snapshot.exports && typeof snapshot.exports === 'object' && !Array.isArray(snapshot.exports)
      ? Object.keys(snapshot.exports as Record<string, unknown>).sort()
      : [];
  } catch {
    return [];
  }
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
    const loader = createDesktopDesignInputLoader(this.port, this.runtime);
    const artifacts = await loader.resolveArtifacts({
      package: packageRequest,
      designLanguage: { location: `npm:${packageRequest.name}@${packageRequest.version}/DESIGN.md` },
      requiredPeerDependencies: this.policy.requiredPeerDependencies
    });
    // `resolveArtifacts` runs the bounded host effects; `load` performs the
    // parser/peer/export validation without executing package code.
    await loader.load(artifacts.request);
    return {
      status: 'staged', packageName: packageRequest.name, version: packageRequest.version,
      exports: manifestExports(artifacts.packageArtifact.packageJson), peerCompatibility: 'compatible',
      provenance: artifacts.packageArtifact.provenance,
      artifactDigest: digestPackage(artifacts.packageArtifact, this.policy.requiredPeerDependencies),
      ...(this.policy.fixtureLabel ? { fixture: this.policy.fixtureLabel } : {})
    };
  }

  public async ingestMarkdown(value: unknown): Promise<MarkdownDesignLanguageReceipt> {
    const markdown = data(value, ['markdown']).markdown;
    if (typeof markdown !== 'string' || markdown.length === 0 || markdown.length > 256 * 1024)
      throw new Error('Markdown must be between 1 and 262144 characters.');
    const location = 'local://guided-setup/markdown';
    const localContentPort: DesignInputPort = {
      resolvePackage: this.port.resolvePackage.bind(this.port),
      sha256: this.port.sha256.bind(this.port),
      async readDesignLanguage() {
        return { markdown, provenance: { provider: 'desktop-local-content', location } };
      }
    };
    const loader = createDesktopDesignInputLoader(localContentPort, this.runtime);
    const context = await loader.load({
      package: this.policy.markdownValidationPackage,
      designLanguage: { location },
      requiredPeerDependencies: this.policy.requiredPeerDependencies
    });
    return {
      status: 'staged', provenance: { provider: 'desktop-local-content', location },
      artifactDigest: createHash('sha256').update(markdown).digest('hex'),
      sectionCount: context.language.sections.length
    };
  }
}

/** Narrow adapter over the sole local-project lifecycle; no renderer path reaches it. */
export class DesktopProjectSetup {
  public constructor(
    private readonly lifecycle: LocalProjectLifecycleService,
    private readonly workspace: (projectId: string, template: 'blank' | 'dashboard' | 'review') => import('@selene/core').ReactSourceWorkspace
  ) {}
  public async create(value: unknown): Promise<ProjectSetupReceipt> {
    const input = data(value, ['id', 'name', 'template']);
    if (typeof input.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.id) || typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 120 || (input.template !== 'blank' && input.template !== 'dashboard' && input.template !== 'review')) throw new Error('Project create request is invalid.');
    const record = await this.lifecycle.create({ id: input.id, name: input.name.trim(), origin: input.template === 'blank' ? 'created' : 'template', workspace: this.workspace(input.id, input.template) });
    return { projectId: record.project.id, name: record.project.name, origin: record.project.origin as 'created' | 'template', revisionId: record.current.revision.id };
  }
  public async open(projectId: string) { return this.lifecycle.open(projectId); }
  public async importText(value: unknown): Promise<ProjectSetupReceipt> {
    const input = data(value, ['contents']);
    if (typeof input.contents !== 'string' || Buffer.byteLength(input.contents, 'utf8') > 1024 * 1024) throw new Error('Project import is invalid or exceeds 1 MiB.');
    let parsed: unknown;
    try { parsed = JSON.parse(input.contents) as unknown; }
    catch { throw new Error('Project import JSON is invalid.'); }
    const record = await this.lifecycle.importRecord(parsed);
    return { projectId: record.project.id, name: record.project.name, origin: 'imported', revisionId: record.current.revision.id };
  }
  public async importFile(path: string): Promise<ProjectSetupReceipt> {
    const contents = await readFile(path, 'utf8');
    return this.importText({ contents });
  }
}

/** Explicit demo-only adapter: it labels its local fixture and supports one exact catalog entry. */
export function createLocalCatalogFixturePort(): DesignInputPort {
  const name = '@selene/design-tokens'; const version = '1.0.0';
  const markdown = '# Design\n\n## Principles\n\nUse semantic tokens.';
  return {
    async resolvePackage(_context, input) {
      if (input.name !== name || input.version !== version) throw new Error('Fixture catalog has no matching package.');
      return {
        packageJson: { name, version, peerDependencies: { react: '^19.0.0' }, exports: { '.': './dist/index.js', './tokens': './dist/tokens.json' }, selene: { designSystem: { schemaVersion: '1', tokenFiles: ['./dist/tokens.json'], components: [{ name: 'Button', exportName: 'Button', entrypoint: '.' }], designLanguagePath: './DESIGN.md' } } },
        files: [{ path: './dist/index.js', content: 'export const Button = {};' }, { path: './dist/tokens.json', content: '{"color":"blue"}' }, { path: './DESIGN.md', content: markdown }],
        provenance: { provider: 'desktop-local-catalog-fixture', location: `npm:${name}@${version}` }
      };
    },
    async readDesignLanguage() { return { markdown, provenance: { provider: 'desktop-local-catalog-fixture', location: `npm:${name}@${version}/DESIGN.md` } }; },
    async sha256(_context, value) { return createHash('sha256').update(value).digest('hex'); }
  };
}
