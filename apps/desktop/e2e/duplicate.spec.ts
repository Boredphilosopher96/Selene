import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { assertNativeElectronTestAllowed } from '../../../scripts/playwright-harness.mjs';

test.beforeAll(() => assertNativeElectronTestAllowed());

const require = createRequire(import.meta.url);
const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const authored = `export default function App(){return <main data-selene-node-id="designer.root" style={{display:'flex',flexDirection:'column',gap:20,padding:32}}><section data-selene-node-id="designer.summary" style={{padding:24,minHeight:100,backgroundColor:'#eef2ff'}}><h1 data-selene-node-id="designer.title">Duplicate this panel</h1></section><button data-selene-node-id="designer.action" data-selene-flow-node="dashboard" data-selene-action-port="open-orders" onClick={()=>window.history.pushState({},'', '/orders')}>Unsafe event handler</button></main>;}`;

async function electronExecutable(): Promise<string> {
  assertNativeElectronTestAllowed();
  const directory = dirname(require.resolve('electron'));
  return join(directory, 'dist', (await readFile(join(directory, 'path.txt'), 'utf8')).trim());
}

async function closeElectron(
  application: Awaited<ReturnType<typeof electron.launch>>
): Promise<void> {
  const child = application.process();
  try {
    await application.close();
  } catch {
    /* Preserve the assertion failure. */
  }
  if (child.exitCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function selectSourceElement(window: Page, element: Locator, nodeId: string): Promise<void> {
  await window
    .getByRole('toolbar', { name: 'Canvas tools' })
    .getByRole('button', { name: 'Selection', exact: true })
    .click();
  await expect(element).toBeVisible({ timeout: 15_000 });
  const frame = window.locator('iframe[title="Generated React preview frame"]');
  let previous = '';
  let stable = 0;
  let clickPoint: { x: number; y: number } | undefined;
  await expect
    .poll(
      async () => {
        const [bounds, metrics, local] = await Promise.all([
          frame.boundingBox(),
          frame.evaluate((node) => ({
            clientLeft: node.clientLeft,
            clientTop: node.clientTop,
            clientWidth: node.clientWidth,
            clientHeight: node.clientHeight,
            offsetWidth: node.offsetWidth,
            offsetHeight: node.offsetHeight,
            identity: node.src
          })),
          element.evaluate((node, expectedId) => {
            const rect = node.getBoundingClientRect();
            const points = [
              { x: rect.left + 6, y: rect.top + 6 },
              { x: rect.right - 6, y: rect.bottom - 6 },
              { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
            ];
            return {
              point: points.find(
                (point) =>
                  document
                    .elementFromPoint(point.x, point.y)
                    ?.closest('[data-selene-node-id]')
                    ?.getAttribute('data-selene-node-id') === expectedId
              ),
              width: window.innerWidth,
              height: window.innerHeight
            };
          }, nodeId)
        ]);
        if (!bounds || !local.point || metrics.offsetWidth === 0 || metrics.offsetHeight === 0)
          return false;
        const scale = {
          x: bounds.width / metrics.offsetWidth,
          y: bounds.height / metrics.offsetHeight
        };
        const point = {
          x: bounds.x + metrics.clientLeft * scale.x + local.point.x * scale.x,
          y: bounds.y + metrics.clientTop * scale.y + local.point.y * scale.y
        };
        const receivesPointer = await window.evaluate(
          (location) =>
            document
              .elementFromPoint(location.x, location.y)
              ?.hasAttribute('data-selene-native-input-bridge') ?? false,
          point
        );
        const sample = JSON.stringify({ bounds, metrics, local });
        stable = sample === previous ? stable + 1 : 0;
        previous = sample;
        clickPoint = point;
        return receivesPointer && stable >= 3;
      },
      { intervals: [80] }
    )
    .toBe(true);
  if (!clickPoint) throw new Error('Source target has no stable physical click point.');
  await window.mouse.click(clickPoint.x, clickPoint.y);
  await expect
    .poll(() =>
      window.evaluate(async () => (await window.selene.designer.snapshot()).selectedNodeId)
    )
    .toBe(nodeId);
  await expect(
    window.getByRole('toolbar', { name: 'Selected React element actions' })
  ).toBeVisible();
}

test('duplicates mapped descendants through the UI and persists undo, redo and unsafe rejection', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'selene-native-duplicate-'));
  const fixture = join(userData, 'duplicate-agent.mjs');
  await writeFile(
    fixture,
    `const content=${JSON.stringify(authored)};
let sequence=0,buffer='';
const write=(kind,fields={})=>process.stdout.write(JSON.stringify({protocolVersion:'1.0',kind,messageId:'duplicate-fixture-'+(++sequence),sentAt:'2026-09-30T00:00:00.000Z',...fields})+'\\n');
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffer+=chunk;let newline=buffer.indexOf('\\n');while(newline>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line){const message=JSON.parse(line);if(message.kind==='hello')write('hello',{implementation:'duplicate-native-fixture',capabilities:['react.revise']});if(message.kind==='request')write('event',{requestId:message.requestId,event:'completed',output:{summary:'Prepared a static duplicate fixture.',operations:[{type:'write',path:'src/App.tsx',content}]}});}newline=buffer.indexOf('\\n');}});
`
  );
  await writeFile(
    join(userData, 'designer-agents.json'),
    JSON.stringify({
      version: 'selene-desktop-agents/v1',
      agents: [
        {
          id: 'duplicate-fixture',
          label: 'Duplicate fixture',
          command: process.execPath,
          args: [fixture],
          workspaceRoot: process.cwd(),
          readOnly: true,
          capabilityGrants: ['react.revise'],
          designOperation: 'react.revise',
          requestTimeoutMs: 10_000
        }
      ]
    })
  );
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: [mainEntry, `--user-data-dir=${userData}`]
  });
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.bringToFront();
    await window.getByLabel('Project name').fill('Native duplicate journey');
    await window.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect
      .poll(() =>
        window.evaluate(async () => (await window.selene.designer.snapshot()).source.revision.id)
      )
      .toMatch(/^native-duplicate-journey-/);
    const preview = window.frameLocator('iframe[title="Generated React preview frame"]');
    await window.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
    await window.getByLabel('Configured agent').selectOption('duplicate-fixture');
    await window.getByLabel('AI change instruction').fill('Prepare static duplicate fixture.');
    const initialNode = preview.locator('[data-selene-node-id]').first();
    const initialNodeId = await initialNode.getAttribute('data-selene-node-id');
    if (!initialNodeId) throw new Error('Initial source marker missing.');
    await selectSourceElement(window, initialNode, initialNodeId);
    await window
      .getByRole('toolbar', { name: 'Selected React element actions' })
      .getByRole('button', { name: 'Ask AI', exact: true })
      .click();
    await window.getByRole('button', { name: 'Send AI change', exact: true }).click();
    const proposal = window
      .getByLabel('AI conversation history')
      .locator('[data-status="reviewing"]')
      .filter({ hasText: 'Prepare static duplicate fixture.' });
    await expect(proposal).toBeVisible({ timeout: 15_000 });
    await proposal
      .getByRole('button', {
        name: 'Accept AI proposal: Prepare static duplicate fixture.',
        exact: true
      })
      .click();
    await expect(preview.getByRole('heading', { name: 'Duplicate this panel' })).toBeVisible({
      timeout: 15_000
    });
    await window.getByRole('button', { name: 'Hide AI rail', exact: true }).click();
    await window.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    const before = await window.evaluate(async () => window.selene.designer.snapshot());
    const panel = preview.locator('[data-selene-node-id="designer.summary"]');
    await selectSourceElement(window, panel, 'designer.summary');
    await window
      .getByRole('toolbar', { name: 'Selected React element actions' })
      .getByRole('button', { name: 'Duplicate', exact: true })
      .click();
    await expect(window.getByLabel('Manual React edit status')).toHaveText(
      'Element duplicated from React source.'
    );
    await expect(preview.getByRole('heading', { name: 'Duplicate this panel' })).toHaveCount(2);
    const copied = await window.evaluate(async () => window.selene.designer.snapshot());
    expect(copied.source.revision.id).not.toBe(before.source.revision.id);
    const freshNodes = copied.source.nodes.filter(
      (node) => !before.source.nodes.some((original) => original.nodeId === node.nodeId)
    );
    expect(freshNodes).toHaveLength(2);
    expect(new Set(copied.source.nodes.map((node) => node.nodeId)).size).toBe(
      copied.source.nodes.length
    );
    expect(
      await preview
        .locator('[data-selene-node-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-selene-node-id')))
    ).toEqual(expect.arrayContaining(freshNodes.map((node) => node.nodeId)));
    const activity = copied.designActivity.at(-1);
    expect(activity).toMatchObject({
      origin: 'manual',
      kind: 'duplicate',
      label: 'Duplicated React element',
      status: 'applied'
    });
    await window.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
    const duplicateActivity = window
      .getByLabel('AI conversation history')
      .locator('[data-status="applied"]')
      .filter({ hasText: 'Duplicated React element' });
    await duplicateActivity
      .getByRole('button', { name: 'Undo manual change', exact: true })
      .click();
    await expect(preview.getByRole('heading', { name: 'Duplicate this panel' })).toHaveCount(1);
    const undone = await window.evaluate(async () => window.selene.designer.snapshot());
    expect(undone.source.files).toEqual(before.source.files);
    expect(undone.source.nodes).toEqual(before.source.nodes);
    await window.reload();
    await expect(preview.getByRole('heading', { name: 'Duplicate this panel' })).toHaveCount(1);
    await window.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
    await window
      .getByLabel('AI conversation history')
      .locator('[data-status="undone"]')
      .filter({ hasText: 'Duplicated React element' })
      .getByRole('button', { name: 'Redo manual change', exact: true })
      .click();
    await expect(preview.getByRole('heading', { name: 'Duplicate this panel' })).toHaveCount(2);
    await window.reload();
    await expect(preview.getByRole('heading', { name: 'Duplicate this panel' })).toHaveCount(2);
    const reloaded = await window.evaluate(async () => window.selene.designer.snapshot());
    expect(reloaded.source.files).toEqual(copied.source.files);
    expect(reloaded.source.nodes).toEqual(copied.source.nodes);
    await selectSourceElement(
      window,
      preview.getByRole('button', { name: 'Unsafe event handler' }),
      'designer.action'
    );
    const unsafeBefore = await window.evaluate(async () => window.selene.designer.snapshot());
    await window
      .getByRole('toolbar', { name: 'Selected React element actions' })
      .getByRole('button', { name: 'Duplicate', exact: true })
      .click();
    await expect(window.getByLabel('Direct manipulation status')).toHaveText(
      'This element cannot be duplicated safely from React source.'
    );
    const unsafeAfter = await window.evaluate(async () => window.selene.designer.snapshot());
    expect(unsafeAfter.source).toEqual(unsafeBefore.source);
    expect(unsafeAfter.designActivity).toEqual(unsafeBefore.designActivity);
    const evidence = testInfo.outputPath('duplicate-native-evidence.json');
    await writeFile(
      evidence,
      JSON.stringify(
        {
          beforeRevision: before.source.revision.id,
          copiedRevision: copied.source.revision.id,
          freshNodes,
          activity,
          undoFilesMatch: true,
          reloadFilesMatch: true,
          unsafeSourceUnchanged: true
        },
        null,
        2
      )
    );
    await testInfo.attach('duplicate-native-evidence.json', {
      path: evidence,
      contentType: 'application/json'
    });
    const screenshot = testInfo.outputPath('duplicate-native.png');
    await window.screenshot({ path: screenshot });
    await testInfo.attach('duplicate-native.png', { path: screenshot, contentType: 'image/png' });
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
