import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repositoryRoot = resolve(import.meta.dir, '..');
const packageDirectory = join(repositoryRoot, 'packages/design-inputs');
const declarationPath = join(packageDirectory, 'dist/index.d.ts');
const declaration = await readFile(declarationPath, 'utf8');
if (declaration.includes('@selene/host-runtime'))
  throw new Error(
    '@selene/design-inputs public declarations must not expose @selene/host-runtime.'
  );

const consumerDirectory = await mkdtemp(join(tmpdir(), 'selene-design-inputs-consumer-'));
try {
  const packageTarget = join(consumerDirectory, 'node_modules/@selene/design-inputs');
  await mkdir(dirname(packageTarget), { recursive: true });
  await cp(join(packageDirectory, 'dist'), join(packageTarget, 'dist'), { recursive: true });
  await writeFile(
    join(packageTarget, 'package.json'),
    JSON.stringify({
      name: '@selene/design-inputs',
      type: 'module',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }
    })
  );
  await writeFile(
    join(consumerDirectory, 'consumer.ts'),
    `import type {
  DesignInputCallContext,
  DesignInputRuntime,
  DesignInputPort,
  ResolvedDesignLanguage,
  ResolvedDesignPackage
} from '@selene/design-inputs';

declare const packageArtifact: ResolvedDesignPackage;
declare const languageArtifact: ResolvedDesignLanguage;
const port: DesignInputPort = {
  resolvePackage: async (_context: DesignInputCallContext) => packageArtifact,
  readDesignLanguage: async (_context: DesignInputCallContext) => languageArtifact,
  sha256: async (_context: DesignInputCallContext, value: string) => value.padEnd(64, '0').slice(0, 64)
};
void port;
const runtime: DesignInputRuntime = {
  run: async (_owner, _method, _arguments, _options) => undefined as never
};
void runtime;
`
  );
  await writeFile(
    join(consumerDirectory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true
      },
      include: ['consumer.ts']
    })
  );
  const result = Bun.spawnSync(
    [
      join(repositoryRoot, 'node_modules/.bin/tsc'),
      '--project',
      join(consumerDirectory, 'tsconfig.json')
    ],
    { cwd: consumerDirectory, stderr: 'pipe', stdout: 'pipe' }
  );
  if (result.exitCode !== 0)
    throw new Error(
      `clean @selene/design-inputs consumer failed:\n${new TextDecoder().decode(result.stderr)}`
    );
  await writeFile(
    join(consumerDirectory, 'consumer.mjs'),
    String.raw`import { createHash } from 'node:crypto';
import { createDesignInputLoader } from '@selene/design-inputs';

const runtime = {
  async run(owner, method, arguments_, options) {
    const effect = owner[method];
    const context = Object.freeze({
      ownerGeneration: 1,
      deadlineMs: options.timeoutMs,
      cancellation: Object.freeze({
        isCancellationRequested: () => false,
        reason: () => undefined,
        subscribe: () => () => undefined
      })
    });
    return Object.freeze({
      status: 'ok',
      value: await Reflect.apply(effect, owner, [context, ...arguments_])
    });
  }
};
const markdown = '# Example\n\n## Principles\n\nUse tokens.';
const loader = createDesignInputLoader({
  runtime,
  port: {
    resolvePackage: async () => ({
      packageJson: {
        name: '@selene/example', version: '1.0.0', peerDependencies: { react: '^19.0.0' },
        exports: { '.': './dist/index.js', './tokens': './dist/tokens.json' },
        selene: { designSystem: { schemaVersion: '1', tokenFiles: ['./dist/tokens.json'], components: [{ name: 'Button', exportName: 'Button', entrypoint: '.' }], designLanguagePath: './DESIGN.md' } }
      },
      files: [{ path: './dist/index.js', content: 'export {}' }, { path: './dist/tokens.json', content: '{"color":"blue"}' }, { path: './DESIGN.md', content: markdown }],
      provenance: { provider: 'test', location: 'npm:@selene/example@1.0.0' }
    }),
    readDesignLanguage: async () => ({ markdown, provenance: { provider: 'test', location: 'design:example' } }),
    sha256: async (_context, value) => createHash('sha256').update(value).digest('hex')
  }
});
const input = { package: { name: '@selene/example', version: '1.0.0' }, designLanguage: { location: 'design:example' }, requiredPeerDependencies: { react: '^19.0.0' } };
const artifacts = await loader.resolveArtifacts(input);
const context = await loader.load(input);
if (artifacts.request.package.name !== '@selene/example' || context.library.name !== '@selene/example') throw new Error('clean consumer did not load the npm design system');
if (context.library.selene.tokenFiles[0] !== './dist/tokens.json' || context.language.sections[1]?.heading !== 'Principles' || context.records.length !== 5) throw new Error('clean consumer did not preserve token or Markdown ownership');
`
  );
  const runtimeResult = Bun.spawnSync([process.execPath, join(consumerDirectory, 'consumer.mjs')], {
    cwd: consumerDirectory,
    stderr: 'pipe',
    stdout: 'pipe'
  });
  if (runtimeResult.exitCode !== 0)
    throw new Error(
      `clean @selene/design-inputs runtime consumer failed:\n${new TextDecoder().decode(runtimeResult.stderr)}`
    );
} finally {
  await rm(consumerDirectory, { force: true, recursive: true });
}

console.log('ok: @selene/design-inputs declarations are self-contained for a clean consumer');
