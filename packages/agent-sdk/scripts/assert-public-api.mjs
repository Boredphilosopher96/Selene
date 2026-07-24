import { execFile as execFileCallback } from 'node:child_process';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = dirname(scriptDirectory);
const declaration = await readFile(join(packageDirectory, 'dist/index.d.ts'), 'utf8');
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));

for (const forbidden of ['@selene/host-runtime', 'HostCallContext', 'HostEffectSupervisor']) {
  if (declaration.includes(forbidden))
    throw new Error(`@selene/agent-sdk public declaration leaked ${forbidden}`);
}
if (manifest.dependencies?.['@selene/host-runtime'] !== undefined)
  throw new Error(
    '@selene/agent-sdk must not declare @selene/host-runtime as a production dependency'
  );

const temporaryConsumer = await (async () => {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(join(tmpdir(), 'selene-agent-sdk-consumer-'));
})();

try {
  const installedPackage = join(temporaryConsumer, 'node_modules/@selene/agent-sdk');
  await mkdir(installedPackage, { recursive: true });
  await cp(join(packageDirectory, 'dist'), join(installedPackage, 'dist'), { recursive: true });
  await cp(join(packageDirectory, 'package.json'), join(installedPackage, 'package.json'));
  try {
    await access(join(temporaryConsumer, 'node_modules/@selene/host-runtime'));
    throw new Error('isolated consumer unexpectedly contains @selene/host-runtime');
  } catch (error) {
    if (error instanceof Error && error.message.includes('unexpectedly contains')) throw error;
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
  }
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
    join(temporaryConsumer, 'consumer.ts'),
    `import {
  streamValidatedEvents,
  type AgentAdapter,
  createAgentProviderRuntimeError,
  recoverAdapterGeneration,
  replaceAdapterGeneration,
  type AgentProviderCancellationPort,
  type AgentProviderCallContext,
  type AgentProviderRuntimeCallOptions,
  type AgentProviderRuntimeError,
  type AgentProviderRuntimeErrorCode,
  type AgentProviderRuntime,
  type StreamValidationOptions
} from '@selene/agent-sdk';

declare const runtime: AgentProviderRuntime;
declare const cancellation: AgentProviderCancellationPort;
const outcome: AgentProviderRuntimeError = createAgentProviderRuntimeError('DEADLINE_EXCEEDED');
const outcomeCode: AgentProviderRuntimeErrorCode = outcome.code;
const runtimeOptions: AgentProviderRuntimeCallOptions = { timeoutMs: 1, cancellation };
const options: StreamValidationOptions = { runtime };
const adapter: AgentAdapter = {
  capabilities: ['project.inspect'],
  async *stream(_context: AgentProviderCallContext, execution) {
    yield {
      protocolVersion: '1.0', kind: 'event', messageId: 'consumer-1',
      sentAt: '2026-07-24T00:00:00Z', requestId: execution.requestId, event: 'completed'
    };
  }
};
void streamValidatedEvents(adapter, { requestId: 'request-1', capability: 'project.inspect', input: {} }, options);
replaceAdapterGeneration(adapter, runtime);
recoverAdapterGeneration(adapter, runtime);
void outcomeCode;
void runtimeOptions;
`
  );
  await writeFile(
    join(temporaryConsumer, 'consumer.mjs'),
    `const surfaces = ${JSON.stringify(Object.keys(manifest.exports ?? { '.': './dist/index.js' }))};
for (const surface of surfaces) {
  const specifier = surface === '.' ? '@selene/agent-sdk' : '@selene/agent-sdk/' + surface.slice(2);
  await import(specifier);
}
const sdk = await import('@selene/agent-sdk');
const runtime = {
  run: async (_owner, effect) => effect({
    ownerGeneration: 1,
    cancellation: {
      isCancellationRequested: () => false,
      reason: () => undefined,
      subscribe: () => () => undefined
    }
  }),
  runCleanup: async (_owner, effect) => effect({
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
const stream = sdk.streamValidatedEvents({
  capabilities: ['project.inspect'],
  async *stream(_context, execution) {
    yield {
      protocolVersion: '1.0', kind: 'event', messageId: 'consumer-1',
      sentAt: '2026-07-24T00:00:00Z', requestId: execution.requestId, event: 'completed'
    };
  }
}, { requestId: 'request-1', capability: 'project.inspect', input: {} }, { runtime });
const result = await stream[Symbol.asyncIterator]().next();
if (result.value?.event !== 'completed') throw new Error('isolated SDK consumer did not receive completion');
`
  );
  const typeScript = join(packageDirectory, '../../node_modules/typescript/bin/tsc');
  await execFile(process.execPath, [typeScript, '-p', 'tsconfig.json'], { cwd: temporaryConsumer });
  await execFile(process.execPath, ['--check', 'consumer.mjs'], { cwd: temporaryConsumer });
  await execFile(process.execPath, ['consumer.mjs'], { cwd: temporaryConsumer });
} finally {
  await rm(temporaryConsumer, { recursive: true, force: true });
}
