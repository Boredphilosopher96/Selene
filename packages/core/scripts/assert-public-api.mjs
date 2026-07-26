import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = join(packageDirectory, '../..');
const schemaDirectory = join(repositoryRoot, 'packages/project-schema');
const declaration = await readFile(join(packageDirectory, 'dist/index.d.ts'), 'utf8');
const designRevisionSource = await readFile(
  join(packageDirectory, 'src/design-revision.ts'),
  'utf8'
);
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
for (const surface of ['./project', './prototype']) {
  const entry = manifest.exports?.[surface];
  if (
    entry?.import !== `./dist/${surface.slice(2)}.js` ||
    entry.types !== `./dist/${surface.slice(2)}.d.ts`
  ) {
    throw new Error(`@selene/core must publish a stable ${surface} entrypoint and declaration`);
  }
}

for (const forbidden of ['@selene/host-runtime', 'HostCallContext', 'HostEffectSupervisor']) {
  if (declaration.includes(forbidden))
    throw new Error(`@selene/core public declaration leaked ${forbidden}`);
}
if (manifest.dependencies?.['@selene/host-runtime'] !== undefined)
  throw new Error('@selene/core must not declare @selene/host-runtime as a production dependency');
for (const forbidden of ['electron', 'node:fs', 'node:process', 'node:net', 'node:http']) {
  if (designRevisionSource.includes(forbidden))
    throw new Error(`design revision core contract must remain provider-free: ${forbidden}`);
}

const temporaryConsumer = await mkdtemp(join(tmpdir(), 'selene-core-consumer-'));
const tarballs = join(temporaryConsumer, 'tarballs');

async function pack(directory, filename) {
  await mkdir(tarballs, { recursive: true });
  const archive = join(tarballs, filename);
  await execFile('bun', ['pm', 'pack', '--ignore-scripts', '--quiet', '--filename', archive], {
    cwd: directory
  });
  return archive;
}

try {
  const [coreArchive, schemaArchive] = await Promise.all([
    pack(packageDirectory, 'selene-core.tgz'),
    pack(schemaDirectory, 'selene-project-schema.tgz')
  ]);
  await writeFile(
    join(temporaryConsumer, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@selene/core': `file:${coreArchive}`,
          '@selene/project-schema': `file:${schemaArchive}`
        },
        overrides: {
          '@selene/project-schema': `file:${schemaArchive}`
        },
        devDependencies: { typescript: '7.0.2' }
      },
      null,
      2
    )
  );
  await writeFile(
    join(temporaryConsumer, 'consumer.ts'),
    `import * as core from '@selene/core';
import {
  exportProject as exportProjectFromProject,
  type LocalProjectPersistencePort,
  type ProjectCommand
} from '@selene/core/project';
import {
  createPrototypeRuntime as createPrototypeRuntimeFromPrototype,
  type PrototypeGraph,
  type PrototypeRuntime
} from '@selene/core/prototype';
import type {
  DlpPolicy,
  DlpScannerPort,
  DesignRevision,
  DesignRevisionExportEligibility,
  DesignRevisionExportHostState,
  DesignRevisionExportVerificationResult,
  DesignRevisionExportVerificationPort,
  DesignRevisionOperationTarget
} from '@selene/core';

declare const policy: DlpPolicy;
declare const scanner: DlpScannerPort;
declare const persistence: LocalProjectPersistencePort;
declare const command: ProjectCommand;
declare const graph: PrototypeGraph;
declare const runtime: PrototypeRuntime;
declare const revisionInput: unknown;
declare const nodeInput: unknown;
declare const exportAuthority: unknown;
declare const exportVerificationPort: DesignRevisionExportVerificationPort;
declare const exportHostState: DesignRevisionExportHostState;
const revision: DesignRevision = core.parseDesignRevision(revisionInput);
const target: DesignRevisionOperationTarget = core.createDesignRevisionOperationTarget(revision, nodeInput);
const tuplePayload = JSON.stringify(revision.tuple);
const privacyPayload = JSON.stringify(revision.privacy);
if (tuplePayload === undefined || privacyPayload === undefined) throw new Error('revision payload must serialize');
const tupleBinding: string = core.createDesignRevisionTupleBinding(tuplePayload);
const privacyBinding: string = core.createDesignRevisionPrivacyBinding(privacyPayload);
const exportEligibility: DesignRevisionExportEligibility = core.evaluateDesignRevisionExportEligibility(revision, exportAuthority, exportVerificationPort, '2026-07-25T22:00:00.000Z');
const nonConsumingExportResult: DesignRevisionExportVerificationResult = {
  kind: 'ineligible',
  code: 'lifecycle',
  commitment: exportHostState
};
void core.enterpriseSecurityFormat;
void core.protectContent(policy, scanner, 'tenant', 'actor', 'content');
void exportProjectFromProject;
void createPrototypeRuntimeFromPrototype;
void persistence;
void command;
void graph;
void runtime;
void revision;
void target;
void tupleBinding;
void privacyBinding;
void exportEligibility;
void nonConsumingExportResult;
`
  );
  await writeFile(
    join(temporaryConsumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          noEmit: true,
          strict: true,
          target: 'ES2024'
        },
        include: ['consumer.ts']
      },
      null,
      2
    )
  );
  await writeFile(
    join(temporaryConsumer, 'consumer.mjs'),
    `const manifest = await import('./node_modules/@selene/core/package.json', { with: { type: 'json' } });
for (const surface of Object.keys(manifest.default.exports ?? { '.': './dist/index.js' })) {
  const specifier = surface === '.' ? '@selene/core' : '@selene/core/' + surface.slice(2);
  await import(specifier);
}
const core = await import('@selene/core');
const project = await import('@selene/core/project');
const prototype = await import('@selene/core/prototype');
if (core.enterpriseSecurityFormat !== 'selene-enterprise-security/v2')
  throw new Error('packed core consumer did not receive enterprise surface');
if (core.exportProject !== project.exportProject)
  throw new Error('packed core root and project subpath do not preserve export identity');
if (core.createPrototypeRuntime !== prototype.createPrototypeRuntime)
  throw new Error('packed core root and prototype subpath do not preserve export identity');
if (
  typeof core.parseDesignRevision !== 'function' ||
  typeof core.createDesignRevisionTupleBinding !== 'function' ||
  typeof core.createDesignRevisionPrivacyBinding !== 'function' ||
  typeof core.createDesignRevisionOperationTarget !== 'function' ||
  typeof core.evaluateDesignRevisionExportEligibility !== 'function'
)
  throw new Error('packed core consumer did not receive design revision authority surface');
`
  );
  await execFile('bun', ['install', '--ignore-scripts'], { cwd: temporaryConsumer });
  await execFile('bun', ['install', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: temporaryConsumer
  });
  await execFile('bunx', ['tsc', '-p', 'tsconfig.json'], { cwd: temporaryConsumer });
  await execFile(process.execPath, ['--check', 'consumer.mjs'], { cwd: temporaryConsumer });
  await execFile(process.execPath, ['consumer.mjs'], { cwd: temporaryConsumer });
} finally {
  await rm(temporaryConsumer, { recursive: true, force: true });
}

console.log(
  'ok: packed @selene/core consumer typechecks root/subpaths, uses public authority functions, and preserves export identity'
);
