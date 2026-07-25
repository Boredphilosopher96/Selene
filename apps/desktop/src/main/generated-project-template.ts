import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';

import type { ImmutablePublishBundle } from './designer-host-ports';
import {
  validateGeneratedProjectToolchainManifest,
  type GeneratedProjectToolchainManifest,
  type GeneratedProjectToolchainManifestPort
} from './generated-project-toolchain';

export interface GeneratedProjectFile {
  readonly path: string;
  readonly content: string;
}

export interface GeneratedProjectTemplateContribution {
  /** Host-composed only: renderer data can never supply an executable contribution. */
  readonly id: string;
  readonly version: string;
  readonly kind: 'user-template' | 'design-system';
  readonly provenance: { readonly provider: string; readonly digest: string };
  files(context: GeneratedProjectTemplateContext): readonly GeneratedProjectFile[];
}

export interface GeneratedProjectTemplateContext {
  readonly bundle: ImmutablePublishBundle;
  readonly toolchain: GeneratedProjectToolchainManifest;
  readonly template: { readonly id: string; readonly version: string };
}

export interface GeneratedProjectTemplateRequest {
  readonly contributions?: readonly GeneratedProjectTemplateContribution[];
}

export interface GeneratedProjectFilePlan {
  readonly format: 'selene-generated-project-file-plan/v1';
  readonly template: { readonly id: string; readonly version: string };
  readonly bundle: {
    readonly immutableId: string;
    readonly digest: string;
    readonly sourceEntrypoint: string;
  };
  readonly toolchain: GeneratedProjectToolchainManifest;
  readonly contributions: readonly {
    readonly id: string;
    readonly version: string;
    readonly kind: 'user-template' | 'design-system';
    readonly provenance: { readonly provider: string; readonly digest: string };
  }[];
  readonly files: readonly GeneratedProjectFile[];
  /** SHA-256 of every other field after canonical deterministic serialization. */
  readonly filePlanDigest: string;
}

export interface GeneratedProjectTemplatePort {
  readonly id: string;
  readonly version: string;
  create(
    bundle: ImmutablePublishBundle,
    request?: GeneratedProjectTemplateRequest
  ): GeneratedProjectFilePlan;
}

const maxFiles = 512;
const maxPathLength = 240;
const maxFileBytes = 1_024 * 1_024;
const maxTotalBytes = 16 * 1_024 * 1_024;
const maxContributionFiles = 128;
const digest = /^[a-f0-9]{64}$/;
const exactSemver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packageName =
  /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/[a-z0-9][a-z0-9._-]{0,213}|[a-z0-9][a-z0-9._-]{0,213})$/;
const stableIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function plainJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('generated project data cannot contain non-finite numbers');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('generated project data must be plain JSON');
  if (seen.has(value)) throw new Error('generated project data cannot contain cycles');
  if (Array.isArray(value)) {
    seen.add(value);
    const result = `[${value.map((entry) => plainJson(entry, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error('generated project data must be plain objects');
  seen.add(value);
  const record = value as Record<string, unknown>;
  const result = `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${plainJson(record[key], seen)}`)
    .join(',')}}`;
  seen.delete(value);
  return result;
}

function json(value: unknown): string {
  return `${plainJson(value)}\n`;
}

function validatePath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxPathLength ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /[\u0001-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new Error('generated project path is invalid');
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.endsWith('.') ||
        segment.endsWith(' ')
    )
  )
    throw new Error('generated project path must be a POSIX relative path');
}

function assertInertFile(file: GeneratedProjectFile): void {
  if (!file || typeof file !== 'object') throw new Error('generated project file is invalid');
  validatePath(file.path);
  if (typeof file.content !== 'string' || Buffer.byteLength(file.content, 'utf8') > maxFileBytes)
    throw new Error('generated project file content is invalid');
}

function normalizedPathIdentity(file: string): string {
  return file.normalize('NFC').toLocaleLowerCase('en-US');
}

function isReservedSelenePath(file: string): boolean {
  const normalized = normalizedPathIdentity(file);
  return (
    normalized === '.git' ||
    normalized.startsWith('.git/') ||
    normalized === 'selene' ||
    normalized.startsWith('selene/') ||
    normalized === '.storybook' ||
    normalized.startsWith('.storybook/') ||
    normalized === 'src/.selene-stories' ||
    normalized.startsWith('src/.selene-stories/')
  );
}

/** The lock-only host command supplies its own config and must not inherit one from a bundle. */
function isForbiddenLockConfigurationPath(file: string): boolean {
  const normalized = normalizedPathIdentity(file);
  return (
    normalized === 'bunfig.toml' ||
    normalized === '.npmrc' ||
    normalized === 'bun.lock' ||
    normalized === 'bun.lockb' ||
    normalized === 'node_modules' ||
    normalized.startsWith('node_modules/')
  );
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value && typeof value === 'object') {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

interface ValidatedContribution {
  readonly files: (context: GeneratedProjectTemplateContext) => readonly GeneratedProjectFile[];
  readonly descriptor: {
    readonly id: string;
    readonly version: string;
    readonly kind: 'user-template' | 'design-system';
    readonly provenance: { readonly provider: string; readonly digest: string };
  };
}

function validateContribution(value: unknown): ValidatedContribution {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('generated project contribution provenance is invalid');
  const contribution = value as GeneratedProjectTemplateContribution;
  const files = contribution.files;
  if (
    !stableIdentifier.test(contribution.id) ||
    !exactSemver.test(contribution.version) ||
    !digest.test(contribution.provenance?.digest ?? '') ||
    (contribution.kind !== 'user-template' && contribution.kind !== 'design-system') ||
    typeof contribution.provenance?.provider !== 'string' ||
    contribution.provenance.provider.length === 0 ||
    contribution.provenance.provider.length > 256 ||
    typeof files !== 'function'
  )
    throw new Error('generated project contribution provenance is invalid');
  return {
    files,
    descriptor: {
      id: contribution.id,
      version: contribution.version,
      kind: contribution.kind,
      provenance: {
        provider: contribution.provenance.provider,
        digest: contribution.provenance.digest
      }
    }
  };
}

type UndigestedGeneratedProjectFilePlan = Omit<GeneratedProjectFilePlan, 'filePlanDigest'>;
export function generatedProjectFilePlanDigest(plan: UndigestedGeneratedProjectFilePlan): string {
  return createHash('sha256')
    .update(
      plainJson({
        format: plan.format,
        template: plan.template,
        bundle: plan.bundle,
        toolchain: plan.toolchain,
        contributions: plan.contributions,
        files: plan.files
      })
    )
    .digest('hex');
}

function normalizeImportPath(from: string, destination: string): string {
  const relative = path.relative(path.dirname(from), destination).replace(/\.(?:tsx?|jsx?)$/, '');
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function catalogNodes(bundle: ImmutablePublishBundle) {
  const nodes = new Map<string, { readonly path: string; readonly exportName: string }>();
  for (const node of bundle.source.nodes)
    nodes.set(`${node.path}\u0000${node.exportName}`, {
      path: node.path,
      exportName: node.exportName
    });
  return [...nodes.values()].sort((left, right) =>
    comparePath(`${left.path}\u0000${left.exportName}`, `${right.path}\u0000${right.exportName}`)
  );
}

function storyFile(node: {
  readonly path: string;
  readonly exportName: string;
}): GeneratedProjectFile {
  const storyPath = `src/.selene-stories/${createHash('sha256').update(`${node.path}\u0000${node.exportName}`).digest('hex').slice(0, 24)}.stories.tsx`;
  const importPath = normalizeImportPath(storyPath, node.path);
  const componentImport =
    node.exportName === 'default'
      ? `import Component from '${importPath}';`
      : `import { ${node.exportName} as Component } from '${importPath}';`;
  return {
    path: storyPath,
    content: `import type { Meta, StoryObj } from '@storybook/react-vite';\n${componentImport}\n\nconst meta = { component: Component } satisfies Meta<typeof Component>;\nexport default meta;\ntype Story = StoryObj<typeof meta>;\nexport const Default: Story = {};\n`
  };
}

function packageJson(
  bundle: ImmutablePublishBundle,
  toolchain: GeneratedProjectToolchainManifest
): string {
  const supported = new Set(['react', 'react-dom']);
  const normalized = new Set<string>();
  for (const dependency of bundle.source.dependencies) {
    const name = dependency === 'react-dom/client' ? 'react-dom' : dependency;
    if (!supported.has(name) && name !== bundle.designInputProvenance.designSystem?.packageName)
      throw new Error(`generated project does not support workspace dependency: ${dependency}`);
    normalized.add(name);
  }
  if (!normalized.has('react') || !normalized.has('react-dom'))
    throw new Error('generated React workspace must declare react and react-dom dependencies');
  const dependencies: Record<string, string> = {
    react: toolchain.packages.react,
    'react-dom': toolchain.packages.reactDom
  };
  const stagedDesignSystem = bundle.designInputProvenance.designSystem;
  if (stagedDesignSystem !== undefined) {
    if (
      !packageName.test(stagedDesignSystem.packageName) ||
      stagedDesignSystem.packageName.length > 214 ||
      !exactSemver.test(stagedDesignSystem.version)
    )
      throw new Error('staged design-system package provenance is invalid');
    const existing = dependencies[stagedDesignSystem.packageName];
    if (existing !== undefined && existing !== stagedDesignSystem.version)
      throw new Error('staged design-system package conflicts with generated React dependencies');
    dependencies[stagedDesignSystem.packageName] = stagedDesignSystem.version;
  }
  return json({
    name: `selene-${
      bundle.projectId
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'generated-project'
    }`,
    private: true,
    version: '0.0.0',
    type: 'module',
    packageManager: `bun@${toolchain.bunVersion}`,
    engines: { bun: toolchain.bunVersion },
    scripts: {
      dev: 'vite',
      build: 'vite build',
      storybook: 'storybook dev -p 6006',
      'build-storybook': 'storybook build'
    },
    dependencies,
    devDependencies: {
      '@storybook/addon-a11y': toolchain.packages.storybookAddonA11y,
      '@storybook/react-vite': toolchain.packages.storybookReactVite,
      '@vitejs/plugin-react': toolchain.packages.viteReact,
      storybook: toolchain.packages.storybook,
      typescript: toolchain.packages.typescript,
      vite: toolchain.packages.vite
    },
    selene: { generatedLockfile: { state: 'pending-install', path: 'bun.lock' } }
  });
}

function requiredFiles(
  bundle: ImmutablePublishBundle,
  toolchain: GeneratedProjectToolchainManifest
): readonly GeneratedProjectFile[] {
  const entryNode =
    bundle.source.nodes.find(
      (node) => node.path === bundle.source.entrypoint && node.exportName === 'default'
    ) ?? bundle.source.nodes.find((node) => node.path === bundle.source.entrypoint);
  if (entryNode === undefined)
    throw new Error('generated workspace entrypoint has no component export metadata');
  const entryImport = normalizeImportPath('src/main.tsx', entryNode.path);
  const entryComponent =
    entryNode.exportName === 'default'
      ? `import App from '${entryImport}';`
      : `import { ${entryNode.exportName} as App } from '${entryImport}';`;
  const designSystem = bundle.designInputProvenance.designSystem ?? null;
  const stagedLanguage = bundle.designInputProvenance.designLanguage;
  return [
    { path: 'package.json', content: packageJson(bundle, toolchain) },
    {
      path: 'index.html',
      content:
        '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Selene generated project</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n'
    },
    {
      path: 'tsconfig.json',
      content: json({
        compilerOptions: {
          target: 'ES2022',
          useDefineForClassFields: true,
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          allowJs: false,
          skipLibCheck: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: true,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: 'react-jsx'
        },
        include: ['src', '.storybook']
      })
    },
    {
      path: 'vite.config.ts',
      content:
        "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n"
    },
    {
      path: 'src/main.tsx',
      content: `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\n${entryComponent}\n\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n`
    },
    {
      path: '.storybook/main.ts',
      content:
        "import type { StorybookConfig } from '@storybook/react-vite';\n\nconst config: StorybookConfig = { framework: '@storybook/react-vite', stories: ['../src/.selene-stories/**/*.stories.tsx'], addons: ['@storybook/addon-a11y'] };\nexport default config;\n"
    },
    {
      path: '.storybook/preview.ts',
      content:
        'const preview = { parameters: { controls: { expanded: true } } };\nexport default preview;\n'
    },
    {
      path: 'README.md',
      content: `# ${bundle.projectId}\n\nThis is a deterministic Selene generated React project for bundle \`${bundle.immutableId}\`.\n\n- It uses Bun ${toolchain.bunVersion}, Vite, TypeScript, React, and Storybook exact pins from embedded build provenance.\n- \`bun.lock\` is intentionally absent from this immutable plan. Local validation creates and validates it only inside a temporary host lease; durable lock output is pending the future remote adapter.\n- The executable prototype is preserved in \`selene/prototype.json\`; Storybook only scaffolds source component exports.\n- Design-language content is provenance-only because Selene retained its digest and receipt, not the original Markdown.\n`
    },
    {
      path: 'selene/bundle.json',
      content: json({
        format: 'selene-generated-project-bundle/v1',
        immutableId: bundle.immutableId,
        digest: bundle.bundleDigest,
        projectId: bundle.projectId,
        sourceRevisionId: bundle.sourceRevisionId,
        graphRevision: bundle.graphRevision
      })
    },
    {
      path: 'selene/prototype.json',
      content: json({
        format: 'selene-generated-project-prototype/v1',
        revision: bundle.graphRevision,
        graph: bundle.prototype.graph
      })
    },
    {
      path: 'selene/collaboration.json',
      content: bundle.collaborationSnapshot.endsWith('\n')
        ? bundle.collaborationSnapshot
        : `${bundle.collaborationSnapshot}\n`
    },
    {
      path: 'selene/design-inputs.json',
      content: json({
        format: 'selene-generated-project-design-inputs/v1',
        designSystem,
        designLanguage:
          stagedLanguage === undefined ? null : { ...stagedLanguage, content: 'provenance-only' }
      })
    },
    {
      path: 'selene/component-catalog.json',
      content: json({
        format: 'selene-generated-project-component-catalog/v1',
        catalog: bundle.componentCatalog
      })
    },
    {
      path: 'selene/handoff-metadata.json',
      content: json({
        format: 'selene-generated-project-handoff/v1',
        packageProvenance: bundle.packageProvenance,
        generatedLockfile: {
          state: 'temporary-local-validation',
          path: 'bun.lock',
          requiredFor: 'bounded host validation; durable remote materialization remains pending'
        }
      })
    },
    ...bundle.source.files.map((file) => ({ path: file.path, content: file.content })),
    ...catalogNodes(bundle).map(storyFile)
  ];
}

/** Validates the inert file plan before a host materializer ever receives it. */
export function validateGeneratedProjectFilePlan(value: unknown): GeneratedProjectFilePlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('generated project file plan is invalid');
  const plan = value as GeneratedProjectFilePlan;
  if (
    plan.format !== 'selene-generated-project-file-plan/v1' ||
    !digest.test(plan.bundle?.digest ?? '') ||
    typeof plan.bundle?.immutableId !== 'string' ||
    !stableIdentifier.test(plan.template?.id ?? '') ||
    !exactSemver.test(plan.template?.version ?? '')
  )
    throw new Error('generated project file plan provenance is invalid');
  validatePath(plan.bundle.sourceEntrypoint);
  validateGeneratedProjectToolchainManifest(plan.toolchain);
  if (!Array.isArray(plan.contributions) || plan.contributions.length > 64)
    throw new Error('generated project contribution plan is invalid');
  const contributionIds = new Set<string>();
  for (const contribution of plan.contributions) {
    if (
      !contribution ||
      !stableIdentifier.test(contribution.id) ||
      !exactSemver.test(contribution.version) ||
      (contribution.kind !== 'user-template' && contribution.kind !== 'design-system') ||
      typeof contribution.provenance?.provider !== 'string' ||
      contribution.provenance.provider.length === 0 ||
      contribution.provenance.provider.length > 256 ||
      !digest.test(contribution.provenance.digest) ||
      contributionIds.has(`${contribution.id}\u0000${contribution.version}`)
    )
      throw new Error('generated project contribution plan is invalid');
    contributionIds.add(`${contribution.id}\u0000${contribution.version}`);
  }
  if (!Array.isArray(plan.files) || plan.files.length === 0 || plan.files.length > maxFiles)
    throw new Error('generated project file count is invalid');
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of plan.files) {
    assertInertFile(file);
    if (isForbiddenLockConfigurationPath(file.path))
      throw new Error('generated project cannot contain lock command configuration');
    const normalized = normalizedPathIdentity(file.path);
    if (seen.has(normalized)) throw new Error('generated project paths collide');
    seen.add(normalized);
    bytes += Buffer.byteLength(file.content, 'utf8');
  }
  if (bytes > maxTotalBytes) throw new Error('generated project exceeds the total byte limit');
  const paths = plan.files.map((file) => file.path);
  if (
    !paths.includes('package.json') ||
    !paths.includes('src/main.tsx') ||
    !paths.includes(plan.bundle.sourceEntrypoint)
  )
    throw new Error('generated project scaffolding is incomplete');
  const source = plan.files.find((file) => file.path === 'selene/bundle.json');
  if (source === undefined) throw new Error('generated project bundle manifest is missing');
  if (paths.some((entry, index) => index > 0 && comparePath(paths[index - 1]!, entry) > 0))
    throw new Error('generated project files must be deterministically sorted');
  if (
    !digest.test(plan.filePlanDigest) ||
    generatedProjectFilePlanDigest({
      format: plan.format,
      template: plan.template,
      bundle: plan.bundle,
      toolchain: plan.toolchain,
      contributions: plan.contributions,
      files: plan.files
    }) !== plan.filePlanDigest
  )
    throw new Error('generated project file plan digest is invalid');
  plainJson(plan);
  return structuredClone(plan);
}

/** Host-only deterministic Bun/Vite/React template; it has no GitHub or renderer authority. */
export class BunViteReactGeneratedProjectTemplate implements GeneratedProjectTemplatePort {
  public readonly id = 'selene-bun-vite-react';
  public readonly version = '1.0.0';
  public constructor(private readonly toolchainPort: GeneratedProjectToolchainManifestPort) {}

  public create(
    bundle: ImmutablePublishBundle,
    request: GeneratedProjectTemplateRequest = {}
  ): GeneratedProjectFilePlan {
    const toolchain = validateGeneratedProjectToolchainManifest(this.toolchainPort.load());
    const sourcePaths = new Set(bundle.source.files.map((file) => file.path));
    if (
      bundle.source.files.some(
        (file) => isReservedSelenePath(file.path) || isForbiddenLockConfigurationPath(file.path)
      )
    )
      throw new Error('bundle source cannot use reserved generated-project paths');
    if (!sourcePaths.has(bundle.source.entrypoint))
      throw new Error('generated workspace entrypoint is missing from source files');
    const files = new Map<string, GeneratedProjectFile>();
    const add = (file: GeneratedProjectFile, source: 'bundle' | 'template' | 'contribution') => {
      assertInertFile(file);
      if (source === 'template' && sourcePaths.has(file.path))
        throw new Error(`template would overwrite bundle source: ${file.path}`);
      if (
        source === 'contribution' &&
        (sourcePaths.has(file.path) ||
          isReservedSelenePath(file.path) ||
          isForbiddenLockConfigurationPath(file.path))
      )
        throw new Error(`contribution cannot overwrite reserved project data: ${file.path}`);
      const existing = files.get(file.path);
      if (existing !== undefined) throw new Error(`generated project file conflict: ${file.path}`);
      files.set(file.path, { path: file.path, content: file.content });
    };
    for (const file of requiredFiles(bundle, toolchain))
      add(file, sourcePaths.has(file.path) ? 'bundle' : 'template');
    const context: GeneratedProjectTemplateContext = deepFreeze(
      structuredClone({ bundle, toolchain, template: { id: this.id, version: this.version } })
    );
    if (!Array.isArray(request.contributions) && request.contributions !== undefined)
      throw new Error('generated project contributions are invalid');
    if ((request.contributions?.length ?? 0) > 64)
      throw new Error('generated project contributions exceed the limit');
    const contributions = (request.contributions ?? [])
      .map((contribution) => validateContribution(contribution))
      .sort((left, right) =>
        comparePath(
          `${left.descriptor.id}\u0000${left.descriptor.version}\u0000${left.descriptor.provenance.digest}`,
          `${right.descriptor.id}\u0000${right.descriptor.version}\u0000${right.descriptor.provenance.digest}`
        )
      );
    const contributedIds = new Set<string>();
    const contributionProvenance = contributions.map((contribution) => {
      const descriptor = contribution.descriptor;
      if (contributedIds.has(`${descriptor.id}\u0000${descriptor.version}`))
        throw new Error('generated project contribution provenance is invalid');
      contributedIds.add(`${descriptor.id}\u0000${descriptor.version}`);
      const contributed = contribution.files(context);
      if (!Array.isArray(contributed) || contributed.length > maxContributionFiles)
        throw new Error('generated project contribution files are invalid');
      for (const file of contributed) assertInertFile(file);
      for (const file of [...contributed].sort((left, right) => comparePath(left.path, right.path)))
        add(file, 'contribution');
      return descriptor;
    });
    add(
      {
        path: 'selene/template.json',
        content: json({
          format: 'selene-generated-project-template/v1',
          template: { id: this.id, version: this.version },
          toolchain,
          contributions: contributionProvenance
        })
      },
      'template'
    );
    const unsignedPlan: UndigestedGeneratedProjectFilePlan = {
      format: 'selene-generated-project-file-plan/v1',
      template: { id: this.id, version: this.version },
      bundle: {
        immutableId: bundle.immutableId,
        digest: bundle.bundleDigest,
        sourceEntrypoint: bundle.source.entrypoint
      },
      toolchain,
      contributions: contributionProvenance,
      files: [...files.values()].sort((left, right) => comparePath(left.path, right.path))
    };
    const plan: GeneratedProjectFilePlan = {
      ...unsignedPlan,
      filePlanDigest: generatedProjectFilePlanDigest(unsignedPlan)
    };
    return validateGeneratedProjectFilePlan(plan);
  }
}
