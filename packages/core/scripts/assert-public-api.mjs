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
const designEditSource = await readFile(join(packageDirectory, 'src/design-edit.ts'), 'utf8');
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
for (const surface of ['./project', './prototype', './design-revision', './design-edit']) {
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
for (const forbidden of [
  'electron',
  'node:fs',
  'node:process',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'process.',
  '@selene/host-runtime',
  '@selene/agent'
]) {
  if (designRevisionSource.includes(forbidden))
    throw new Error(`design revision core contract must remain provider-free: ${forbidden}`);
  if (designEditSource.includes(forbidden))
    throw new Error(`design edit core contract must remain provider-free: ${forbidden}`);
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
  parseReactBindingManifest as parseReactBindingManifestFromPrototype,
  validateReactBindingManifest as validateReactBindingManifestFromPrototype,
  type PrototypeGraph,
  type PrototypeRuntime,
  type ReactBindingManifest
} from '@selene/core/prototype';
import {
  parseDesignRevision as parseDesignRevisionFromSubpath,
  type DesignRevision as SubpathDesignRevision
} from '@selene/core/design-revision';
import {
  parseDesignEditProposal as parseDesignEditProposalFromSubpath,
  type DesignEditAdapterPort,
  type DesignEditDigestPort,
  type DesignEditProposal
} from '@selene/core/design-edit';
import type {
  CompilerRenderedInstanceDescriptor,
  CompilerRenderedInstanceIdentity,
  CompilerSourceIdentity,
  DlpPolicy,
  DlpScannerPort,
  DesignRevision,
  DesignRevisionExportEligibility,
  DesignRevisionExportHostState,
  DesignRevisionExportVerificationResult,
  DesignRevisionExportVerificationPort,
  DesignRevisionOperationReference,
  DesignRevisionOperationTarget,
  DesignRevisionState
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
declare const revisionAuthority: unknown;
declare const revisionState: DesignRevisionState;
declare const exportVerificationPort: DesignRevisionExportVerificationPort;
declare const exportHostState: DesignRevisionExportHostState;
declare const compilerSource: CompilerSourceIdentity;
declare const instanceDescriptor: CompilerRenderedInstanceDescriptor;
declare const designEditInput: unknown;
declare const bindingInput: unknown;
declare const designEditAdapter: DesignEditAdapterPort;
declare const designEditDigestPort: DesignEditDigestPort;
const callbackVerificationPort: DesignRevisionExportVerificationPort = () => ({
  kind: 'unauthorized'
});
const revision: DesignRevision = core.parseDesignRevision(revisionInput);
const migrationReceipt = core.migrateDesignRevisionV1(revisionInput);
const renderedInstance: CompilerRenderedInstanceIdentity = {
  ...instanceDescriptor,
  instanceDigest: core.createCompilerRenderedInstanceDigest(
    revision,
    compilerSource,
    instanceDescriptor
  )
};
const subpathRevision: SubpathDesignRevision = parseDesignRevisionFromSubpath(revisionInput);
const editProposal: DesignEditProposal = parseDesignEditProposalFromSubpath(designEditInput);
const bindingManifest: ReactBindingManifest = parseReactBindingManifestFromPrototype(bindingInput);
const target: DesignRevisionOperationTarget = core.createDesignRevisionOperationTarget(revision, nodeInput);
const operation: DesignRevisionOperationReference = core.createDesignRevisionOperationReference(
  revision,
  revisionAuthority,
  'edit',
  revisionState,
  '2026-07-25T22:00:00.000Z'
);
const tuplePayload = JSON.stringify(revision.tuple);
const privacyPayload = JSON.stringify(revision.privacy);
if (tuplePayload === undefined || privacyPayload === undefined) throw new Error('revision payload must serialize');
const tupleBinding: string = core.createDesignRevisionTupleBinding(tuplePayload);
const privacyBinding: string = core.createDesignRevisionPrivacyBinding(privacyPayload);
const revisionPayload = JSON.stringify(revision);
if (revisionPayload === undefined) throw new Error('revision must serialize');
const revisionCommitment: string = core.createDesignRevisionCommitment(revisionPayload);
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
void validateReactBindingManifestFromPrototype;
void persistence;
void command;
void graph;
void runtime;
void revision;
void migrationReceipt;
void subpathRevision;
void editProposal;
void bindingManifest;
void designEditAdapter;
void designEditDigestPort;
void target;
void operation;
void renderedInstance;
void callbackVerificationPort;
void tupleBinding;
void privacyBinding;
void revisionCommitment;
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
const designRevision = await import('@selene/core/design-revision');
const designEdit = await import('@selene/core/design-edit');
if (core.enterpriseSecurityFormat !== 'selene-enterprise-security/v2')
  throw new Error('packed core consumer did not receive enterprise surface');
if (core.exportProject !== project.exportProject)
  throw new Error('packed core root and project subpath do not preserve export identity');
if (core.createPrototypeRuntime !== prototype.createPrototypeRuntime)
  throw new Error('packed core root and prototype subpath do not preserve export identity');
if (core.validateReactBindingManifest !== prototype.validateReactBindingManifest)
  throw new Error('packed core root and prototype binding validator do not preserve export identity');
if (core.parseReactBindingManifest !== prototype.parseReactBindingManifest)
  throw new Error('packed core root and prototype binding parser do not preserve export identity');
const exact = core.serializeCanonicalData({ nested: { value: 'x' } });
if (core.serializeCanonicalData({ nested: { value: 'x' } }, { maxEncodedBytes: new TextEncoder().encode(exact).byteLength }) !== exact)
  throw new Error('packed core canonical serializer does not preserve exact nested byte accounting');
try {
  core.serializeCanonicalData(Object.defineProperty({}, 'x', { enumerable: true, get() { return 'x'; } }));
  throw new Error('packed core canonical serializer accepted an accessor');
} catch (error) {
  if (!(error instanceof core.CanonicalDataError)) throw error;
}
if (core.parseDesignRevision !== designRevision.parseDesignRevision)
  throw new Error('packed core root and design-revision subpath do not preserve export identity');
if (core.migrateDesignRevisionV1 !== designRevision.migrateDesignRevisionV1)
  throw new Error('packed core migration root and subpath do not preserve export identity');
if (core.parseDesignEditProposal !== designEdit.parseDesignEditProposal)
  throw new Error('packed core root and design-edit subpath do not preserve export identity');
if (
  typeof core.parseDesignRevision !== 'function' ||
  typeof core.migrateDesignRevisionV1 !== 'function' ||
  typeof core.createDesignRevisionTupleBinding !== 'function' ||
  typeof core.createDesignRevisionCommitment !== 'function' ||
  typeof core.createDesignRevisionPrivacyBinding !== 'function' ||
  typeof core.createDesignRevisionOperationTarget !== 'function' ||
  typeof core.createCompilerRenderedInstanceDigest !== 'function' ||
  typeof core.createDesignRevisionOperationReference !== 'function' ||
  typeof core.evaluateDesignRevisionExportEligibility !== 'function'
)
  throw new Error('packed core consumer did not receive design revision authority surface');
const digest = 'a'.repeat(64);
const compilerDigest = 'c'.repeat(64);
const revisionInput = {
  format: 'selene-design-revision/v1',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  revisionId: 'revision-1',
  sequence: 1,
  createdAt: '2026-07-26T12:01:00.000Z',
  tuple: {
    sourceDigest: digest,
    graphDigest: digest,
    bindingDigest: digest,
    commandLogDigest: digest,
    designSystemLockDigest: digest,
    deployment: {
      format: 'selene-deployment-identity/v1',
      state: 'unpublished',
      draftId: 'draft-1',
      manifestDigest: digest
    },
    preview: {
      format: 'selene-compiled-preview-identity/v1',
      buildId: 'preview-1',
      previewDigest: digest
    },
    compiler: {
      format: 'selene-compiler-identity/v1',
      compilerId: 'compiler-1',
      compilerDigest
    }
  },
  privacy: {
    format: 'selene-design-privacy/v1',
    classification: 'restricted',
    contentDigest: digest,
    lifecycle: 'active',
    fields: [{ category: 'prompt', mode: 'redact', digest }],
    retention: { deleteAfter: '2026-07-27T12:01:00.000Z' },
    deletion: { action: 'tombstone', tombstoneDigest: digest },
    exportPolicyDigest: digest,
    auditCorrelationId: 'audit-1',
    exclusions: ['legacy-raw-prompt']
  }
};
let parsedRevision;
try {
  core.parseDesignRevision(revisionInput);
  throw new Error('packed core consumer silently rewrote a v1 immutable identity');
} catch (error) {
  if (!(error instanceof core.DesignRevisionContractError))
    throw new Error('packed core consumer leaked v1 rejection details');
}
const migrationReceipt = core.migrateDesignRevisionV1(revisionInput);
parsedRevision = migrationReceipt.migratedRevision;
if (
  migrationReceipt.sourceCommitment === migrationReceipt.migratedCommitment ||
  migrationReceipt.persistence.decision !== 'host-must-persist-before-use' ||
  parsedRevision.format !== 'selene-design-revision/v2' ||
  parsedRevision.privacy.format !== 'selene-design-privacy/v2' ||
  parsedRevision.privacy.telemetry.mode !== 'disabled' ||
  !parsedRevision.privacy.exclusions.includes('source-text')
)
  throw new Error('packed core consumer did not migrate the bounded v1 revision safely');
const sourceIdentity = {
  format: 'selene-compiler-source-identity/v1',
  moduleId: 'orders-page',
  exportName: 'OrdersPage',
  astNodeId: 'orders.root',
  sourceDigest: digest,
  bindingDigest: digest
};
const instanceDescriptor = {
  format: 'selene-compiler-rendered-instance-identity/v1',
  instanceId: 'orders-root',
  ancestry: ['orders.root'],
  repeat: { kind: 'singleton' }
};
const editTarget = {
  format: 'selene-design-edit-target/v1',
  operation: {
    format: 'selene-design-revision-operation-target/v2',
    tenantId: parsedRevision.tenantId,
    projectId: parsedRevision.projectId,
    revisionId: parsedRevision.revisionId,
    tupleBinding: parsedRevision.tupleBinding,
    revisionCommitment: parsedRevision.revisionCommitment,
    node: {
      format: 'selene-compiler-node-identity/v2',
      projectId: parsedRevision.projectId,
      nodeId: 'orders.root',
      compilerDigest,
      source: sourceIdentity,
      instance: {
        ...instanceDescriptor,
        instanceDigest: core.createCompilerRenderedInstanceDigest(
          parsedRevision,
          sourceIdentity,
          instanceDescriptor
        )
      }
    }
  },
  sourceAnchorId: 'orders.root'
};
const parsedEdit = core.parseDesignEditProposal({
  format: 'selene-design-edit-proposal/v1',
  schemaVersion: 1,
  proposalId: 'proposal-1',
  commandId: 'command-1',
  actorId: 'designer-1',
  origin: 'manual-canvas',
  operation: {
    format: 'selene-design-revision-operation-reference/v2',
    kind: 'edit',
    tenantId: parsedRevision.tenantId,
    projectId: parsedRevision.projectId,
    actorId: 'designer-1',
    commandId: 'command-1',
    revisionId: parsedRevision.revisionId,
    tupleBinding: parsedRevision.tupleBinding,
    revisionCommitment: parsedRevision.revisionCommitment
  },
  base: parsedRevision,
  commands: [{ kind: 'set-content', target: editTarget, content: 'Review orders' }],
  preconditions: [
    { kind: 'source-revision', sourceDigest: digest },
    { kind: 'binding-revision', bindingDigest: digest },
    { kind: 'design-system-lock', designSystemLockDigest: digest }
  ],
  requestedAt: '2026-07-26T12:02:00.000Z'
});
if (
  parsedEdit.commands[0]?.kind !== 'set-content' ||
  parsedEdit.commands[0].content !== 'Review orders' ||
  !Object.isFrozen(parsedEdit.commands) ||
  !Object.isFrozen(parsedEdit.preconditions)
)
  throw new Error('packed core consumer did not preserve an immutable design edit proposal');
const bindingManifest = core.parseReactBindingManifest({
  format: 'selene-react-binding-manifest/v1',
  schemaVersion: '2.0',
  projectId: 'project-a',
  sourceRevisionId: 'revision-1',
  graphId: 'orders-flow',
  graphRevision: 0,
  nodeBindings: [{ graphNodeId: 'orders', sourceNodeId: 'orders.root' }],
  actionBindings: []
});
if (
  bindingManifest.nodeBindings[0]?.sourceNodeId !== 'orders.root' ||
  !Object.isFrozen(bindingManifest.nodeBindings)
)
  throw new Error('packed core consumer did not preserve an immutable React binding manifest');
for (const [parse, ErrorType, label] of [
  [core.parseDesignEditProposal, core.DesignEditContractError, 'design edit'],
  [core.parseReactBindingManifest, core.ReactBindingManifestError, 'React binding']
]) {
  const hostile = new Proxy({}, { ownKeys() { throw new Error('host trap'); } });
  try {
    parse(hostile);
    throw new Error('packed core consumer accepted a hostile ' + label + ' envelope');
  } catch (error) {
    if (!(error instanceof ErrorType))
      throw new Error('packed core consumer leaked a hostile ' + label + ' exception');
  }
}
const policy = {
  format: 'selene-design-revision-policy/v1',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  policyId: 'policy-1',
  revision: 1,
  digest,
  capabilities: ['design:revision.commit'],
  trustAnchor: {
    format: 'selene-design-revision-trust-anchor/v1',
    issuer: 'issuer-a',
    audience: 'selene-desktop',
    grantId: 'grant-1',
    schemaRevision: 1,
    commandsDigest: digest
  }
};
const authority = {
  format: 'selene-design-revision-authority/v2',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  actorId: 'designer-a',
  commandId: 'command-1',
  policyId: 'policy-1',
  policyRevision: 1,
  policyDigest: digest,
  revisionId: parsedRevision.revisionId,
  tupleBinding: parsedRevision.tupleBinding,
  revisionCommitment: parsedRevision.revisionCommitment,
  capabilities: ['design:revision.commit'],
  grantId: 'grant-1',
  grantEpoch: 1,
  issuer: 'issuer-a',
  audience: 'selene-desktop',
  schemaRevision: 1,
  commandsDigest: digest,
  issuedAt: '2026-07-26T12:00:00.000Z',
  expiresAt: '2026-07-26T13:00:00.000Z'
};
const state = {
  format: 'selene-design-revision-state/v1',
  tenantId: 'tenant-a',
  projectId: 'project-a',
  policy,
  grantStatus: {
    format: 'selene-design-revision-grant-status/v1',
    grantId: 'grant-1',
    epoch: 1,
    state: 'active'
  },
  processedCommandIds: []
};
if (core.parseDesignRevisionState(state).format !== 'selene-design-revision-state/v2')
  throw new Error('packed core consumer did not migrate an empty v1 state');
const command = { format: 'selene-design-revision-command/v2', authority, revision: parsedRevision };
const accepted = core.commitDesignRevisionOutcome(state, command, '2026-07-26T12:02:00.000Z');
if (
  accepted.kind !== 'accepted' ||
  accepted.state.head.revisionCommitment !== parsedRevision.revisionCommitment ||
  accepted.state.head.revision.revisionCommitment !== parsedRevision.revisionCommitment
)
  throw new Error('packed core consumer did not persist the full canonical revision commitment');
if (
  core.commitDesignRevisionOutcome(
    state,
    { ...command, format: 'selene-design-revision-command/v1' },
    '2026-07-26T12:02:00.000Z'
  ).kind !== 'unsupported'
)
  throw new Error('packed core consumer accepted a hybrid v1 command with v2 authority');
if (
  core.commitDesignRevisionOutcome(
    state,
    { ...command, authority: { ...authority, tenantId: 'tenant-b' } },
    '2026-07-26T12:02:00.000Z'
  ).kind !== 'unauthorized'
)
  throw new Error('packed core consumer did not reject cross-tenant authority');
const { revision: omittedRevision, ...incompleteHead } = accepted.state.head;
void omittedRevision;
if (
  core.commitDesignRevisionOutcome(
    { ...accepted.state, head: incompleteHead },
    {},
    '2026-07-26T12:02:00.000Z'
  ).kind !== 'invalid'
)
  throw new Error('packed core consumer accepted an incomplete persisted head');
const hostile = new Proxy({}, { ownKeys() { throw new Error('host trap'); } });
try {
  core.parseDesignRevision(hostile);
  throw new Error('packed core consumer accepted a hostile raw revision');
} catch (error) {
  if (!(error instanceof core.DesignRevisionContractError))
    throw new Error('packed core consumer leaked a hostile host exception');
}
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
