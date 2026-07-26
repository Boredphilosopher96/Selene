import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

export const HANDOFF_ARCHIVE_NAME = 'orders-review-r18.handoff.json';
export const HANDOFF_RECEIPT_NAME = 'orders-review-r18.receipt.json';
export const HANDOFF_ARCHIVE_FORMAT = 'selene-developer-handoff-archive/v2';
export const HANDOFF_RECEIPT_FORMAT = 'selene-developer-handoff-receipt/v1';
export const HANDOFF_ARTIFACT_ID = 'orders-review-7f3a-b9c1';
export const HANDOFF_SOURCE_REVISION = 'orders-r18-7f3a';
export const HANDOFF_BASELINE_REVISION = 'orders-r17-b9c1';
export const HANDOFF_TOOLCHAIN = Object.freeze({
  runtime: 'bun@1.3.14',
  react: '19.2.8',
  typescript: '7.0.2',
  vite: '8.1.5',
  storybook: '10.5.4'
});

const encoder = new TextEncoder();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const execFile = promisify(execFileCallback);
const MAX_ARCHIVE_ENTRIES = 32;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_ENCODED_ENTRY_BYTES = 4 * Math.ceil(MAX_ENTRY_BYTES / 3);
const MAX_STRING_BYTES = 64 * 1024;
const MAX_LOCK_PACKAGES = 2_000;
const MAX_LOCK_RECORD_KEYS = 128;
const MAX_LOCK_RECORD_ARRAY = 16;
const MAX_LOCK_RECORD_DEPTH = 12;
const gitRefPattern = /^[a-f0-9]{40}$/;

const metadataStringMaximum = () => MAX_STRING_BYTES;
const archiveStringMaximum = (path) =>
  path.length === 3 && path[0] === 'files' && Number.isInteger(path[1]) && path[2] === 'content'
    ? MAX_ENCODED_ENTRY_BYTES
    : MAX_STRING_BYTES;

function canonicalJson(value, depth = 0, path = [], stringMaximum = metadataStringMaximum) {
  if (depth > 32) throw new Error('Archive metadata nesting exceeds bound');
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string')
    return JSON.stringify(assertBoundedString(value, 'archive string', stringMaximum(path)));
  if (Array.isArray(value)) {
    if (value.length > 4_096) throw new Error('Archive metadata array exceeds bound');
    return `[${value
      .map((item, index) => canonicalJson(item, depth + 1, [...path, index], stringMaximum))
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 4_096) throw new Error('Archive metadata object exceeds bound');
    return `{${keys
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            value[key],
            depth + 1,
            [...path, key],
            stringMaximum
          )}`
      )
      .join(',')}}`;
  }
  throw new TypeError(`Unsupported archive value: ${typeof value}`);
}

function canonicalArchiveJson(archive) {
  return canonicalJson(archive, 0, [], archiveStringMaximum);
}

function assertBoundedString(value, label, maximum = MAX_STRING_BYTES) {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > maximum) {
    throw new Error(`Invalid or oversized ${label}`);
  }
  return value;
}

function stripJsoncTrailingCommas(value) {
  return value.replace(/,\s*([}\]])/g, '$1');
}

function assertRegistryLockString(value, label) {
  assertBoundedString(value, label);
  if (
    /(?:^|[\\/])\.\.?[\\/]/.test(value) ||
    /^(?:[A-Za-z]:|~[\\/]|[\\/])/.test(value) ||
    /(?:^|[\s(])(?:file|link|workspace|git|ssh|https?|github|npm):/i.test(value) ||
    /:\/\//.test(value) ||
    /^[^/\s:@]+@[^/\s:]+:/.test(value) ||
    /(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::|\/|$)/i.test(value) ||
    /\/\/[^/\s]*@/.test(value) ||
    /@selene\//i.test(value)
  ) {
    throw new Error(`Non-registry or local lock provenance in ${label}`);
  }
}

function assertRegistryLockValue(value, depth = 0) {
  if (depth > MAX_LOCK_RECORD_DEPTH) throw new Error('Lock provenance nesting exceeds bound');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid lock provenance number');
    return;
  }
  if (typeof value === 'string') return assertRegistryLockString(value, 'bun.lock');
  if (Array.isArray(value)) {
    if (value.length > MAX_LOCK_RECORD_ARRAY)
      throw new Error('Lock provenance array exceeds bound');
    for (const item of value) assertRegistryLockValue(item, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > MAX_LOCK_RECORD_KEYS)
      throw new Error('Lock provenance object exceeds bound');
    for (const [key, item] of entries) {
      assertRegistryLockString(key, 'bun.lock key');
      assertRegistryLockValue(item, depth + 1);
    }
    return;
  }
  throw new Error('Invalid lock provenance value');
}

function assertRegistryPackageLocator(locator) {
  assertBoundedString(locator, 'bun.lock package locator', 512);
  if (!/^(?:@?[A-Za-z0-9_.-]+)(?:\/@?[A-Za-z0-9_.-]+)*$/.test(locator)) {
    throw new Error(`Non-registry bun.lock package locator: ${locator}`);
  }
}

function assertPackageRelativeBinPath(value) {
  assertBoundedString(value, 'bun.lock bin path', 1_024);
  const normalized = value.startsWith('./') ? value.slice(2) : value;
  const segments = normalized.split('/');
  if (
    !/^[A-Za-z0-9@._+-]+(?:\/[A-Za-z0-9@._+-]+)*$/.test(normalized) ||
    segments.some((segment) => segment === '.' || segment === '..' || segment === 'node_modules')
  ) {
    throw new Error('Unsafe bun.lock package-relative bin path');
  }
}

function assertRegistryBin(value, depth) {
  if (typeof value === 'string') return assertPackageRelativeBinPath(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid bun.lock bin record');
  }
  const entries = Object.entries(value);
  if (depth > MAX_LOCK_RECORD_DEPTH || entries.length > MAX_LOCK_RECORD_KEYS) {
    throw new Error('Lock provenance bin record exceeds bound');
  }
  for (const [name, path] of entries) {
    assertRegistryLockString(name, 'bun.lock bin name');
    assertPackageRelativeBinPath(path);
  }
}

function assertRegistryPackageMetadata(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('bun.lock package metadata is invalid');
  }
  const entries = Object.entries(metadata);
  if (entries.length > MAX_LOCK_RECORD_KEYS) {
    throw new Error('Lock provenance object exceeds bound');
  }
  for (const [key, value] of entries) {
    assertRegistryLockString(key, 'bun.lock metadata key');
    if (key === 'bin') assertRegistryBin(value, 1);
    else assertRegistryLockValue(value, 1);
  }
}

function assertRegistryPackageRecord(record) {
  if (!Array.isArray(record) || record.length !== 4) {
    throw new Error('bun.lock package record shape is invalid');
  }
  const [identity, source, metadata, integrity] = record;
  assertRegistryLockString(identity, 'bun.lock package identity');
  if (source !== undefined) {
    assertRegistryLockString(source, 'bun.lock package source');
    if (source !== '') throw new Error('bun.lock package source is invalid');
  }
  assertRegistryPackageMetadata(metadata);
  assertRegistryLockString(integrity, 'bun.lock package integrity');
}

export function assertStandaloneLock(parsed, packageJson) {
  assertExactKeys(
    parsed,
    ['lockfileVersion', 'configVersion', 'workspaces', 'packages'],
    'bun.lock'
  );
  if (parsed.lockfileVersion !== 1 || parsed.configVersion !== 1) {
    throw new Error('Unsupported bun.lock schema version');
  }
  assertExactObject(
    parsed.workspaces,
    {
      '': {
        name: packageJson.name,
        version: packageJson.version,
        dependencies: packageJson.dependencies,
        devDependencies: packageJson.devDependencies
      }
    },
    'bun.lock direct dependency allowlist'
  );
  if (
    parsed.packages === null ||
    typeof parsed.packages !== 'object' ||
    Array.isArray(parsed.packages)
  ) {
    throw new Error('bun.lock packages table is invalid');
  }
  const locators = Object.keys(parsed.packages);
  if (locators.length === 0 || locators.length > MAX_LOCK_PACKAGES)
    throw new Error('bun.lock package bound exceeded');
  assertRegistryLockValue(parsed.workspaces);
  for (const [locator, record] of Object.entries(parsed.packages)) {
    assertRegistryPackageLocator(locator);
    assertRegistryPackageRecord(record);
  }
}

function assertStandaloneLockPublicProvenance(parsed) {
  assertNoPrivateOrLocalValue(
    {
      lockfileVersion: parsed.lockfileVersion,
      configVersion: parsed.configVersion,
      workspaces: parsed.workspaces
    },
    'bun.lock'
  );
  for (const [locator, record] of Object.entries(parsed.packages)) {
    assertNoPrivateOrLocalValue(locator, 'bun.lock package locator');
    assertNoPrivateOrLocalValue(record, `bun.lock package record: ${locator}`);
  }
}

function assertNoPrivateOrLocalValue(value, label = 'archive value', depth = 0) {
  if (depth > 24) throw new Error(`Hostile nested ${label}`);
  if (typeof value === 'string') {
    assertBoundedString(value, label);
    assertPublicText(label, value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARCHIVE_ENTRIES * 8) throw new Error(`Oversized ${label}`);
    for (const item of value) assertNoPrivateOrLocalValue(item, label, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > MAX_ARCHIVE_ENTRIES * 8) throw new Error(`Oversized ${label}`);
    for (const [key, item] of entries) {
      assertBoundedString(key, `${label} key`, 180);
      assertNoPrivateOrLocalValue(item, label, depth + 1);
    }
  }
}

async function gitSourceRef(root) {
  const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: root });
  const sourceRef = stdout.trim();
  if (!gitRefPattern.test(sourceRef)) throw new Error('Unable to resolve an exact source Git ref');
  return sourceRef;
}

function assertCanonicalBuildInput(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Missing or invalid canonical ${label}`);
  }
  return value;
}

export async function canonicalBuildProvenance(root, environment = process.env) {
  const sha = assertCanonicalBuildInput(
    environment.SELENE_HANDOFF_SHA ?? environment.GITHUB_SHA,
    'artifact checkout SHA',
    gitRefPattern
  );
  const repository = assertCanonicalBuildInput(
    environment.SELENE_HANDOFF_REPOSITORY ?? environment.GITHUB_REPOSITORY,
    'artifact checkout repository',
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
  );
  const ref = assertCanonicalBuildInput(
    environment.SELENE_HANDOFF_REF ?? environment.GITHUB_REF,
    'artifact checkout ref',
    /^refs\/(?:heads|pull|tags)\/[A-Za-z0-9_./-]+$/
  );
  const head = await gitSourceRef(root);
  if (head !== sha)
    throw new Error('Canonical artifact SHA does not match the checked-out Git HEAD');
  return Object.freeze({ provider: 'github', repository, ref, sha });
}

function safeArchivePath(path) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 180 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.includes('//') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`Unsafe handoff archive path: ${String(path)}`);
  }
  return path;
}

function assertPublicText(path, contents) {
  const blocked = [
    /@selene\//i,
    /workspace:/i,
    /(?:^|\W)(?:file|link):/i,
    /(?:^|\s)[^/\s:@]+@[^/\s:]+:/,
    /(?:^|\W)--filter(?:\W|$)/i,
    /(?:^|\W)(?:\/Users\/|[A-Z]:\\|\\\\[^\\]+\\|\.\.?\\)/,
    /(?:api[_-]?key|secret|password|auth[_-]?token)\s*[:=]/i
  ];
  if (blocked.some((pattern) => pattern.test(contents))) {
    throw new Error(`Unsafe private, local, or secret-bearing content in ${path}`);
  }
}

function handoffPackage() {
  return {
    name: 'orders-review-r18-handoff',
    version: '18.0.0',
    private: true,
    type: 'module',
    packageManager: 'bun@1.3.14',
    engines: { bun: '1.3.14' },
    scripts: {
      start: 'vite --host 127.0.0.1',
      build: 'vite build',
      typecheck: 'tsc --noEmit',
      storybook: 'storybook dev --host 127.0.0.1',
      'build-storybook': 'storybook build --output-dir storybook-static',
      'verify:render': 'node scripts/verify-render.mjs',
      verify: 'bun run typecheck && bun run build'
    },
    dependencies: { react: '19.2.8', 'react-dom': '19.2.8' },
    devDependencies: {
      '@storybook/addon-a11y': '10.5.4',
      '@storybook/react-vite': '10.5.4',
      '@playwright/test': '1.61.1',
      '@types/react': '19.2.17',
      '@types/react-dom': '19.2.3',
      '@vitejs/plugin-react': '6.0.4',
      storybook: '10.5.4',
      typescript: '7.0.2',
      vite: '8.1.5'
    }
  };
}

export function consumerLock(rootLock, packageJson) {
  const packagesStart = rootLock.indexOf('  "packages": {');
  if (packagesStart === -1) throw new Error('Root bun.lock is missing the packages table');

  const packageTable = rootLock
    .slice(packagesStart)
    .split('\n')
    .filter((line) => !line.includes('"@selene/'))
    .join('\n');
  const workspace = {
    name: packageJson.name,
    version: packageJson.version,
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies
  };
  const lock = `{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": ${canonicalJson(workspace)}
  },
${packageTable}`;
  assertPublicText('bun.lock', lock);
  let parsed;
  try {
    parsed = JSON.parse(stripJsoncTrailingCommas(lock));
  } catch (error) {
    throw new Error(
      `Generated bun.lock is not parseable JSONC: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  assertStandaloneLock(parsed, packageJson);
  assertStandaloneLockPublicProvenance(parsed);
  return lock;
}

const ordersReviewRow = `import type { ReactElement } from 'react';

export type OrderStatus = 'Needs review' | 'Packing' | 'Shipped';

export interface ReviewedOrder {
  readonly id: string;
  readonly customer: string;
  readonly total: string;
  readonly status: OrderStatus;
}

export function OrdersReviewRow({ order }: { readonly order: ReviewedOrder }): ReactElement {
  return (
    <tr data-review-order={order.id}>
      <td>{order.id}</td><td>{order.customer}</td><td>{order.status}</td><td>{order.total}</td>
    </tr>
  );
}
`;

const appSource = `import { OrdersReviewRow, type ReviewedOrder } from './orders-review-r18';
import crescent from './assets/selene-crescent.svg';
import './styles.css';

const orders: readonly ReviewedOrder[] = [
  { id: '#1048', customer: 'Olivia Parker', status: 'Needs review', total: '$240.00' },
  { id: '#1047', customer: 'Amir Cooper', status: 'Packing', total: '$96.00' },
  { id: '#1046', customer: 'Elliot Vaughn', status: 'Shipped', total: '$180.00' }
];

export function App() {
  return (
    <main className="orders-review" aria-labelledby="orders-title">
      <header><img src={crescent} alt="" /><p>Northstar · Orders</p><span>Revision 18</span></header>
      <section><p className="eyebrow">Developer handoff</p><h1 id="orders-title">Orders ready for review</h1><p>Address-confirmation decisions remain visible before fulfillment.</p></section>
      <section className="orders-card" aria-label="Orders review table"><table><thead><tr><th>Order</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead><tbody>{orders.map((order) => <OrdersReviewRow key={order.id} order={order} />)}</tbody></table></section>
    </main>
  );
}
`;

const mainSource = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
`;

const styles = `:root { color: #17203b; background: #f5f6fb; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
.orders-review { margin: 0 auto; max-width: 960px; padding: 48px 28px 72px; }
header { align-items: center; display: flex; gap: 10px; justify-content: flex-start; color: #53607e; font-size: 14px; }
header img { height: 24px; width: 24px; } header p { font-weight: 700; margin: 0; } header span { margin-left: auto; }
section { margin-top: 52px; } .eyebrow { color: #4f46e5; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
h1 { font-size: clamp(36px, 7vw, 64px); letter-spacing: -.055em; line-height: .98; margin: 12px 0 18px; }
.orders-card { background: #fff; border: 1px solid #dfe3f0; border-radius: 18px; box-shadow: 0 18px 48px rgba(31, 41, 85, .08); overflow-x: auto; padding: 8px 22px; }
table { border-collapse: collapse; min-width: 620px; width: 100%; } th, td { border-bottom: 1px solid #edf0f7; padding: 18px 8px; text-align: left; } th { color: #64708b; font-size: 12px; letter-spacing: .04em; text-transform: uppercase; } td:nth-child(3) { color: #4338ca; font-weight: 700; } td:last-child, th:last-child { text-align: right; }
@media (max-width: 560px) { .orders-review { padding: 28px 18px 48px; } section { margin-top: 32px; } }
`;

const story = `import type { Meta, StoryObj } from '@storybook/react-vite';
import { App } from './app';

const meta = { title: 'Northstar/Orders review r18', component: App } satisfies Meta<typeof App>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {};
`;

const storybookMain = `import type { StorybookConfig } from '@storybook/react-vite';

const config = { stories: ['../src/**/*.stories.@(ts|tsx)'], addons: ['@storybook/addon-a11y'], framework: '@storybook/react-vite' } satisfies StorybookConfig;
export default config;
`;

const renderVerifier = `import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { chromium } from '@playwright/test';

const root = process.cwd();
const mime = new Map([['.css', 'text/css'], ['.html', 'text/html'], ['.js', 'text/javascript'], ['.svg', 'image/svg+xml']]);
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function startStatic(rootDirectory, port) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const candidate = pathname === '/' ? 'index.html' : pathname.replace(/^\\/+/, '');
    const target = resolve(rootDirectory, candidate);
    if (target !== rootDirectory && !target.startsWith(rootDirectory + sep)) { response.writeHead(400).end(); return; }
    try {
      await access(target);
      response.writeHead(200, { 'content-type': mime.get(extname(target)) ?? 'application/octet-stream' });
      createReadStream(target).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

async function waitForApp(url, process) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    if (process.exitCode !== null) throw new Error('Vite exited before the browser proof');
    await delay(100);
  }
  throw new Error('Timed out starting the handoff Vite application');
}

async function stopProcess(process) {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await Promise.race([once(process, 'exit'), delay(2_000).then(() => { process.kill('SIGKILL'); return once(process, 'exit'); })]);
}

async function stopServer(server) {
  await Promise.race([
    new Promise((resolveClose) => server.close(resolveClose)),
    delay(2_000).then(() => {
      server.closeAllConnections();
      return new Promise((resolveClose) => server.close(resolveClose));
    })
  ]);
}

const vite = spawn('bun', ['run', 'start', '--', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { cwd: root, stdio: 'inherit' });
const storybook = startStatic(resolve(root, 'storybook-static'), 6006);
let browser;
try {
  await waitForApp('http://127.0.0.1:4173/', vite);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4173/', { waitUntil: 'networkidle', timeout: 15_000 });
  await page.getByRole('heading', { name: 'Orders ready for review' }).waitFor();
  await page.getByRole('cell', { name: '#1048' }).waitFor();
  const story = await browser.newPage();
  await story.goto('http://127.0.0.1:6006/iframe.html?id=northstar-orders-review-r18--ready&viewMode=story', { waitUntil: 'networkidle', timeout: 15_000 });
  await story.getByRole('heading', { name: 'Orders ready for review' }).waitFor();
} finally {
  if (browser !== undefined) await browser.close();
  await stopServer(storybook);
  await stopProcess(vite);
}
`;

const filesFor = (rootLock) => {
  const packageJson = handoffPackage();
  return new Map([
    ['package.json', `${canonicalJson(packageJson)}\n`],
    ['bun.lock', consumerLock(rootLock, packageJson)],
    [
      'tsconfig.json',
      `${canonicalJson({ compilerOptions: { jsx: 'react-jsx', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], skipLibCheck: true }, include: ['src', '.storybook'] })}\n`
    ],
    [
      'vite.config.ts',
      `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()] });\n`
    ],
    [
      'index.html',
      '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>Northstar Orders r18</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n'
    ],
    [
      'README.md',
      `# Northstar Orders r18\n\nSelf-contained React + TypeScript handoff for ${HANDOFF_ARTIFACT_ID}.\n\n\`bun install --frozen-lockfile\`\n\`bun run typecheck\`\n\`bun run build\`\n\`bun run start -- --host 127.0.0.1 --port 4173 --strictPort\`\n\nThe packaged Storybook story is at \`src/orders-review-r18.stories.tsx\`.\n`
    ],
    ['.storybook/main.ts', storybookMain],
    ['scripts/verify-render.mjs', renderVerifier],
    ['src/vite-env.d.ts', '/// <reference types="vite/client" />\n'],
    ['src/main.tsx', mainSource],
    ['src/app.tsx', appSource],
    ['src/orders-review-r18.tsx', ordersReviewRow],
    ['src/orders-review-r18.stories.tsx', story],
    ['src/styles.css', styles],
    [
      'src/assets/selene-crescent.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Selene"><circle cx="16" cy="16" r="14" fill="#4f46e5"/><circle cx="21" cy="11" r="12" fill="#f5f6fb"/></svg>\n'
    ]
  ]);
};

function manifestFor(files, build) {
  const packageJson = handoffPackage();
  return {
    format: 'selene-developer-handoff/v2',
    artifact: {
      id: HANDOFF_ARTIFACT_ID,
      project: 'Northstar · Orders experience',
      projectId: 'northstar',
      sourceRevisionId: HANDOFF_SOURCE_REVISION,
      baselineRevisionId: HANDOFF_BASELINE_REVISION,
      sourceRef: build
    },
    build,
    toolchain: HANDOFF_TOOLCHAIN,
    dependencies: {
      package: 'package.json',
      runtime: packageJson.dependencies,
      tooling: packageJson.devDependencies
    },
    commands: {
      install: 'bun install --frozen-lockfile',
      typecheck: 'bun run typecheck',
      build: 'bun run build',
      start: 'bun run start -- --host 127.0.0.1 --port 4173 --strictPort'
    },
    provenance: {
      storybook: {
        kind: 'packaged-story-source',
        path: 'src/orders-review-r18.stories.tsx',
        story: 'Northstar/Orders review r18/Ready'
      },
      scenarios: ['ready-orders', 'address-confirmation', 'empty-orders', 'unavailable-orders'],
      components: ['OrdersReviewRow', 'OrderStatus'],
      designDirection: [
        'Preserve data-review-order identities.',
        'Keep order status text visible with color.',
        'Use the bundled local CSS tokens; no private design-system package is required.'
      ]
    },
    safety: {
      archiveEntries: 'regular-files-only',
      paths: 'normalized-project-relative',
      secrets: 'rejected',
      localPaths: 'rejected',
      symlinks: 'rejected'
    },
    files: [...files.entries()]
      .map(([path, contents]) => ({
        path,
        bytes: encoder.encode(contents).byteLength,
        digest: { algorithm: 'sha256', value: sha256(contents) }
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
  };
}

function assertExactObject(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Invalid ${label}`);
}

function assertExactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`Invalid ${label} fields`);
}

function assertManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object')
    throw new Error('Invalid archive manifest');
  assertExactKeys(
    manifest,
    [
      'format',
      'artifact',
      'build',
      'toolchain',
      'dependencies',
      'commands',
      'provenance',
      'safety',
      'files',
      'archive'
    ],
    'archive manifest'
  );
  if (manifest.format !== 'selene-developer-handoff/v2')
    throw new Error('Invalid archive manifest format');
  assertExactObject(
    {
      id: manifest.artifact?.id,
      project: manifest.artifact?.project,
      projectId: manifest.artifact?.projectId,
      sourceRevisionId: manifest.artifact?.sourceRevisionId,
      baselineRevisionId: manifest.artifact?.baselineRevisionId
    },
    {
      id: HANDOFF_ARTIFACT_ID,
      project: 'Northstar · Orders experience',
      projectId: 'northstar',
      sourceRevisionId: HANDOFF_SOURCE_REVISION,
      baselineRevisionId: HANDOFF_BASELINE_REVISION
    },
    'archive identity'
  );
  const sourceRef = manifest.artifact?.sourceRef;
  if (
    sourceRef === null ||
    typeof sourceRef !== 'object' ||
    sourceRef.provider !== 'github' ||
    !gitRefPattern.test(sourceRef.sha) ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRef.repository) ||
    !/^refs\/(?:heads|pull|tags)\/[A-Za-z0-9_./-]+$/.test(sourceRef.ref)
  ) {
    throw new Error('Invalid archive source ref');
  }
  assertExactObject(manifest.build, sourceRef, 'archive build provenance');
  assertExactObject(manifest.toolchain, HANDOFF_TOOLCHAIN, 'archive toolchain');
  const packageJson = handoffPackage();
  assertExactObject(
    manifest.dependencies,
    {
      package: 'package.json',
      runtime: packageJson.dependencies,
      tooling: packageJson.devDependencies
    },
    'archive dependencies'
  );
  assertExactObject(
    manifest.commands,
    {
      install: 'bun install --frozen-lockfile',
      typecheck: 'bun run typecheck',
      build: 'bun run build',
      start: 'bun run start -- --host 127.0.0.1 --port 4173 --strictPort'
    },
    'archive commands'
  );
  assertExactObject(
    manifest.provenance,
    {
      storybook: {
        kind: 'packaged-story-source',
        path: 'src/orders-review-r18.stories.tsx',
        story: 'Northstar/Orders review r18/Ready'
      },
      scenarios: ['ready-orders', 'address-confirmation', 'empty-orders', 'unavailable-orders'],
      components: ['OrdersReviewRow', 'OrderStatus'],
      designDirection: [
        'Preserve data-review-order identities.',
        'Keep order status text visible with color.',
        'Use the bundled local CSS tokens; no private design-system package is required.'
      ]
    },
    'archive provenance'
  );
  assertExactObject(
    manifest.safety,
    {
      archiveEntries: 'regular-files-only',
      paths: 'normalized-project-relative',
      secrets: 'rejected',
      localPaths: 'rejected',
      symlinks: 'rejected'
    },
    'archive safety policy'
  );
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0 ||
    manifest.files.length > MAX_ARCHIVE_ENTRIES
  ) {
    throw new Error('Invalid archive file receipt');
  }
  assertNoPrivateOrLocalValue(manifest, 'archive manifest');
}

function receiptFor(archive, archivePayload) {
  return {
    format: HANDOFF_RECEIPT_FORMAT,
    archive: {
      name: HANDOFF_ARCHIVE_NAME,
      digest: { algorithm: 'sha256', value: sha256(archivePayload) },
      contentDigest: archive.manifest.archive.contentDigest
    },
    artifact: archive.manifest.artifact,
    build: archive.manifest.build,
    toolchain: archive.manifest.toolchain,
    provenance: archive.manifest.provenance
  };
}

export function createDeveloperHandoffReceipt(archive, archivePayload) {
  const receipt = receiptFor(archive, archivePayload);
  assertReceipt(receipt, archivePayload, archive);
  return receipt;
}

export function receiptText(receipt) {
  return `${canonicalJson(receipt)}\n`;
}

export function assertReceipt(receipt, archivePayload, archive, expectedBuild) {
  if (receipt?.format !== HANDOFF_RECEIPT_FORMAT) throw new Error('Invalid handoff receipt format');
  assertExactKeys(
    receipt,
    ['format', 'archive', 'artifact', 'build', 'toolchain', 'provenance'],
    'handoff receipt'
  );
  assertManifest(archive?.manifest);
  if (expectedBuild !== undefined)
    assertExactObject(archive.manifest.build, expectedBuild, 'expected GitHub build provenance');
  assertExactObject(receipt.artifact, archive.manifest.artifact, 'receipt artifact identity');
  assertExactObject(receipt.build, archive.manifest.build, 'receipt build provenance');
  assertExactObject(receipt.toolchain, archive.manifest.toolchain, 'receipt toolchain');
  assertExactObject(receipt.provenance, archive.manifest.provenance, 'receipt provenance');
  assertExactObject(
    receipt.archive,
    {
      name: HANDOFF_ARCHIVE_NAME,
      digest: { algorithm: 'sha256', value: sha256(archivePayload) },
      contentDigest: archive.manifest.archive.contentDigest
    },
    'receipt archive digest'
  );
  assertNoPrivateOrLocalValue(receipt, 'handoff receipt');
}

export async function createDeveloperHandoffArchive(root = process.cwd()) {
  const rootLock = await readFile(resolve(root, 'bun.lock'), 'utf8');
  const build = await canonicalBuildProvenance(root);
  const files = filesFor(rootLock);
  let totalBytes = 0;
  for (const [path, contents] of files) {
    safeArchivePath(path);
    assertPublicText(path, contents);
    const bytes = encoder.encode(contents).byteLength;
    if (bytes > MAX_ENTRY_BYTES) throw new Error(`Archive entry exceeds byte bound: ${path}`);
    totalBytes += bytes;
    if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error('Archive aggregate byte bound exceeded');
  }
  const manifest = manifestFor(files, build);
  const encodedFiles = [...files.entries()]
    .map(([path, contents]) => ({
      path,
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(contents).toString('base64')
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const preimage = {
    format: HANDOFF_ARCHIVE_FORMAT,
    manifest: {
      ...manifest,
      archive: { contentDigest: null, digestScope: 'archive with contentDigest value omitted' }
    },
    files: encodedFiles
  };
  const digest = sha256(canonicalArchiveJson(preimage));
  const archive = {
    ...preimage,
    manifest: {
      ...manifest,
      archive: {
        contentDigest: { algorithm: 'sha256', value: digest },
        digestScope: 'archive with contentDigest value omitted'
      }
    }
  };
  assertManifest(archive.manifest);
  if (encoder.encode(archiveText(archive)).byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error('Developer handoff archive exceeds its bounded size');
  }
  return archive;
}

export function archiveText(archive) {
  assertArchive(archive);
  return `${canonicalArchiveJson(archive)}\n`;
}

export async function writeDeveloperHandoffArtifacts(root = process.cwd()) {
  const archive = await createDeveloperHandoffArchive(root);
  const archivePayload = archiveText(archive);
  const receipt = createDeveloperHandoffReceipt(archive, archivePayload);
  const directory = resolve(root, 'apps/web/public/handoffs');
  const archivePath = resolve(directory, HANDOFF_ARCHIVE_NAME);
  const receiptPath = resolve(directory, HANDOFF_RECEIPT_NAME);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.handoff-publish-'));
  try {
    const stagedArchive = join(staging, HANDOFF_ARCHIVE_NAME);
    const stagedReceipt = join(staging, HANDOFF_RECEIPT_NAME);
    await writeFile(stagedArchive, archivePayload, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
    await writeFile(stagedReceipt, receiptText(receipt), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644
    });
    await rename(stagedArchive, archivePath);
    await rename(stagedReceipt, receiptPath);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return {
    archivePath,
    receiptPath,
    digest: receipt.archive.digest.value,
    bytes: encoder.encode(archivePayload).byteLength
  };
}

export function assertArchive(archive, expectedBuild) {
  if (
    archive?.format !== HANDOFF_ARCHIVE_FORMAT ||
    !Array.isArray(archive.files) ||
    !archive.manifest
  ) {
    throw new Error('Invalid developer handoff archive shape');
  }
  assertExactKeys(archive, ['format', 'manifest', 'files'], 'developer handoff archive');
  assertManifest(archive.manifest);
  if (expectedBuild !== undefined)
    assertExactObject(archive.manifest.build, expectedBuild, 'expected GitHub build provenance');
  if (archive.files.length > MAX_ARCHIVE_ENTRIES) throw new Error('Archive entry bound exceeded');
  const seen = new Set();
  const decoded = new Map();
  let totalBytes = 0;
  for (const entry of archive.files) {
    assertExactKeys(entry, ['path', 'type', 'encoding', 'content'], 'archive entry');
    const path = safeArchivePath(entry?.path);
    if (
      seen.has(path) ||
      entry.type !== 'file' ||
      entry.encoding !== 'base64' ||
      typeof entry.content !== 'string' ||
      entry.content.length > MAX_ENCODED_ENTRY_BYTES
    ) {
      throw new Error(`Invalid or duplicate archive entry: ${path}`);
    }
    seen.add(path);
    const contents = Buffer.from(entry.content, 'base64').toString('utf8');
    if (Buffer.from(contents).toString('base64') !== entry.content)
      throw new Error(`Invalid base64 archive entry: ${path}`);
    assertPublicText(path, contents);
    const bytes = encoder.encode(contents).byteLength;
    if (bytes > MAX_ENTRY_BYTES) throw new Error(`Archive entry exceeds byte bound: ${path}`);
    totalBytes += bytes;
    if (totalBytes > MAX_ARCHIVE_BYTES) throw new Error('Archive aggregate byte bound exceeded');
    decoded.set(path, contents);
  }
  const expected = [...decoded.entries()]
    .map(([path, contents]) => ({
      path,
      bytes: encoder.encode(contents).byteLength,
      digest: { algorithm: 'sha256', value: sha256(contents) }
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (canonicalJson(expected) !== canonicalJson(archive.manifest.files))
    throw new Error('Archive file receipt mismatch');
  const preimage = {
    ...archive,
    manifest: { ...archive.manifest, archive: { ...archive.manifest.archive, contentDigest: null } }
  };
  const digest = sha256(canonicalArchiveJson(preimage));
  if (archive.manifest.archive?.contentDigest?.value !== digest)
    throw new Error('Archive content digest mismatch');
  return decoded;
}

export async function extractDeveloperHandoffArchive(archive, expectedBuild) {
  const files = assertArchive(archive, expectedBuild);
  const root = await mkdtemp(join(tmpdir(), 'selene-handoff-consumer-'));
  try {
    const writeEntry = async (index) => {
      if (index >= files.size) return;
      const [path, contents] = [...files.entries()][index];
      if (path === undefined || contents === undefined)
        throw new Error('Archive entry disappeared');
      const target = join(root, ...path.split('/'));
      const targetDirectory = dirname(target);
      await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
      await writeFile(target, contents, { encoding: 'utf8', flag: 'wx', mode: 0o644 });
      return writeEntry(index + 1);
    };
    await writeEntry(0);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
