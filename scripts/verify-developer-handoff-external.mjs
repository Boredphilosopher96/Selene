import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import {
  HANDOFF_ARCHIVE_NAME,
  HANDOFF_RECEIPT_NAME,
  assertArchive,
  assertReceipt,
  canonicalBuildProvenance,
  extractDeveloperHandoffArchive
} from './developer-handoff-archive.mjs';

const root = process.cwd();
const publishedArchive = resolve(
  process.argv[2] ?? join(root, 'apps/web/public/handoffs', HANDOFF_ARCHIVE_NAME)
);
const publishedReceipt = resolve(dirname(publishedArchive), HANDOFF_RECEIPT_NAME);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'selene-handoff-external-'));
const downloaded = resolve(temporaryRoot, 'downloaded');
const cleanEnvironment = {
  PATH: process.env.PATH ?? '',
  HOME: resolve(temporaryRoot, 'home'),
  TMPDIR: resolve(temporaryRoot, 'tmp'),
  BUN_INSTALL_CACHE_DIR: resolve(temporaryRoot, 'bun-cache'),
  CI: '1',
  NO_COLOR: '1'
};
let consumer;

function run(command, args, cwd, timeoutMs = 120_000) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: cleanEnvironment, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      rejectRun(new Error(`${command} ${args.join(' ')} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}`));
    });
  });
}

try {
  const expectedBuild = await canonicalBuildProvenance(root);
  await mkdir(downloaded, { recursive: true });
  await Promise.all([
    mkdir(cleanEnvironment.HOME, { recursive: true }),
    mkdir(cleanEnvironment.TMPDIR, { recursive: true })
  ]);
  await copyFile(publishedArchive, resolve(downloaded, HANDOFF_ARCHIVE_NAME));
  await copyFile(publishedReceipt, resolve(downloaded, HANDOFF_RECEIPT_NAME));
  const archivePayload = await readFile(resolve(downloaded, HANDOFF_ARCHIVE_NAME), 'utf8');
  const archive = JSON.parse(archivePayload);
  const receipt = JSON.parse(await readFile(resolve(downloaded, HANDOFF_RECEIPT_NAME), 'utf8'));
  const files = assertArchive(archive, expectedBuild);
  assertReceipt(receipt, archivePayload, archive, expectedBuild);
  const artifact = files.get('src/orders-review-r18.tsx');
  if (artifact === undefined) throw new Error('Archive omitted the React artifact');
  if (
    createHash('sha256').update(artifact).digest('hex') !==
    '45fcab29dfc3243625ffc567bcc026187d39e59ae5830d93ecb640c8a7ef32bf'
  ) {
    throw new Error('Archive React artifact digest does not match the r18 receipt');
  }
  consumer = await extractDeveloperHandoffArchive(archive, expectedBuild);
  try {
    await run('bun', ['install', '--frozen-lockfile'], consumer);
  } catch (error) {
    const originalLock = await readFile(resolve(consumer, 'bun.lock'), 'utf8');
    await run('bun', ['install', '--lockfile-only', '--ignore-scripts'], consumer);
    const canonicalLock = await readFile(resolve(consumer, 'bun.lock'), 'utf8');
    const diagnostics = resolve(root, 'test-results/developer-handoff');
    await mkdir(diagnostics, { recursive: true });
    await Promise.all([
      writeFile(resolve(diagnostics, 'projected.bun.lock'), originalLock),
      writeFile(resolve(diagnostics, 'canonical.bun.lock'), canonicalLock)
    ]);
    throw new Error(
      'Projected standalone lock is not canonical; preserved both locks as CI diagnostics.',
      { cause: error }
    );
  }
  await run('bun', ['run', 'typecheck'], consumer);
  await run('bun', ['run', 'build'], consumer);
  await run('bun', ['run', 'build-storybook'], consumer);
  await run('bunx', ['playwright', 'install', '--with-deps', 'chromium'], consumer);
  await run('bun', ['run', 'verify:render'], consumer);
} finally {
  if (consumer !== undefined) await rm(consumer, { recursive: true, force: true });
  await rm(temporaryRoot, { recursive: true, force: true });
}
