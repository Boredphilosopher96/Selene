import { _electron as electron, expect, test } from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const harnessMain = fileURLToPath(new URL('./prototype-flow-harness-main.cjs', import.meta.url));
const workspaceToolbarHarnessMain = fileURLToPath(
  new URL('./workspace-toolbar-diagnostics-harness-main.cjs', import.meta.url)
);
const require = createRequire(import.meta.url);
const startupOutputLimit = 16_384;

declare global {
  interface Window {
    selenePrototypeFlowHarness?: {
      callbackCount(): number;
      remount(): void;
      settle(index: number): boolean;
      showMaximumActionLabel(): void;
    };
    seleneWorkspaceToolbarHarness?: {
      state(): {
        consentMutations: number;
        consentRefreshes: number;
        recoveryRefreshes: number;
        statusMessages: readonly string[];
        trace: readonly string[];
        component: {
          busy: string | undefined;
          consent: string | undefined;
          consentChecked: boolean | undefined;
          consentDisabled: boolean | undefined;
          recovery: string | undefined;
          saving: string | undefined;
        };
      };
      rerender(): void;
      resolveInitialRefresh(consent: string): void;
      resolveConsentMutation(): void;
    };
  }
}

function desktopArgs(userData: string): string[] {
  return [mainEntry, `--user-data-dir=${userData}`];
}

async function electronExecutable(): Promise<string> {
  const electronEntry = require.resolve('electron');
  const electronDirectory = dirname(electronEntry);
  const executable = (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim();
  return join(electronDirectory, 'dist', executable);
}

async function closeElectron(
  application: Awaited<ReturnType<typeof electron.launch>>
): Promise<void> {
  const child = application.process();
  try {
    await application.close();
  } catch {
    // Cleanup must not replace the test failure that triggered it.
  }
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, 2_000);
    child.once('exit', onExit);
  });
  if (child.exitCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The original test failure remains authoritative if cleanup races process exit.
    }
  }
}

function captureStartupOutput(child: ChildProcess): () => string {
  let output = '';
  const append = (stream: 'stderr' | 'stdout') => (chunk: unknown) => {
    output = `${output}[${stream}] ${String(chunk)}`.slice(-startupOutputLimit);
  };
  child.stdout?.on('data', append('stdout'));
  child.stderr?.on('data', append('stderr'));
  return () => output || '(Electron emitted no startup output.)';
}

test('renders one compiled artboard canvas with prototype wiring as a mode', async ({
  browserName: _browserName
}, testInfo) => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-unified-canvas-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let startupOutput: (() => string) | undefined;
  try {
    const launchedApplication = await electron.launch({
      executablePath: await electronExecutable(),
      args: desktopArgs(userData)
    });
    application = launchedApplication;
    startupOutput = captureStartupOutput(launchedApplication.process());
    const window = await launchedApplication.firstWindow({ timeout: 5_000 });
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.getByLabel('Project name').fill('Unified canvas test', { timeout: 5_000 });
    await window.getByRole('button', { name: 'Create project' }).click({ timeout: 5_000 });

    const canvas = window.getByLabel('Unified design canvas');
    const compiledArtboard = canvas.getByLabel('Compiled React artboard');
    const modebar = canvas.getByRole('toolbar', { name: 'Canvas modes' });
    await expect(canvas).toBeVisible({ timeout: 5_000 });
    await expect(compiledArtboard).toBeVisible({ timeout: 5_000 });
    await expect(
      compiledArtboard
        .frameLocator('iframe[title="Generated React preview frame"]')
        .getByRole('heading', { name: 'Dashboard' })
    ).toBeVisible({ timeout: 5_000 });
    await expect(modebar.getByRole('button')).toHaveText([
      'Design & arrange',
      'Comment',
      'Prototype',
      'Present'
    ]);
    await expect(modebar.getByRole('button', { name: 'Design & arrange' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(window.getByRole('button', { name: 'Flow', exact: true })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
    await expect(canvas.getByLabel('Artboards')).toBeVisible();
    await expect(canvas.getByRole('group', { name: 'Canvas library' })).toBeVisible();
    await expect(canvas.getByText('Live React', { exact: true })).toBeVisible();

    const dragArtboard = async (
      artboard: ReturnType<typeof canvas.locator>,
      delta: { readonly x: number; readonly y: number }
    ) => {
      await artboard.evaluate((node) => {
        const events: unknown[] = [];
        node.setAttribute('data-selene-drag-events', '[]');
        const record = (event: Event) => {
          const pointer = event as PointerEvent;
          events.push({
            type: event.type,
            target:
              event.target instanceof HTMLElement
                ? `${event.target.tagName}.${event.target.className}`
                : null,
            button: pointer.button,
            buttons: pointer.buttons,
            clientX: pointer.clientX,
            clientY: pointer.clientY,
            defaultPrevented: event.defaultPrevented
          });
          node.setAttribute('data-selene-drag-events', JSON.stringify(events));
        };
        for (const type of [
          'pointerdown',
          'mousedown',
          'pointermove',
          'mousemove',
          'pointerup',
          'mouseup'
        ])
          node.addEventListener(type, record, { capture: true });
      });
      const handle = artboard
        .locator('.canvas-artboard__drag-handle, .canvas-artboard__label')
        .first();
      const bounds = await handle.boundingBox();
      expect(bounds).not.toBeNull();
      if (!bounds) return;
      const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const hitOwnership = await handle.evaluate((element, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          hitClass: hit instanceof HTMLElement ? hit.className : null,
          hitTag: hit?.tagName ?? null,
          ownedByHandle: hit !== null && (hit === element || element.contains(hit))
        };
      }, start);
      expect(hitOwnership.ownedByHandle, JSON.stringify(hitOwnership)).toBe(true);
      const samples: unknown[] = [];
      const sample = async (checkpoint: string) => {
        samples.push(
          await artboard.evaluate((node, name) => {
            const events = JSON.parse(node.getAttribute('data-selene-drag-events') ?? '[]');
            return {
              checkpoint: name,
              className: node.className,
              style: node.getAttribute('style'),
              mode: node.closest('[aria-label="Unified design canvas"]')?.getAttribute('data-mode'),
              events
            };
          }, checkpoint)
        );
      };
      await sample('before pointer delivery');
      await window.mouse.move(start.x, start.y);
      await sample('handle hovered');
      await window.mouse.down();
      await sample('pointer held');
      for (let step = 1; step <= 4; step += 1) {
        await window.mouse.move(start.x + (delta.x * step) / 4, start.y + (delta.y * step) / 4);
        await sample(`held move ${step}`);
      }
      await window.mouse.up();
      await sample('pointer released');
      const evidence = JSON.stringify({ hitOwnership, samples }, null, 2);
      await testInfo.attach(`canvas-drag-${await artboard.getAttribute('data-id')}.json`, {
        body: evidence,
        contentType: 'application/json'
      });
      expect(await artboard.getAttribute('class'), evidence).toContain('draggable');
      expect(evidence, evidence).toContain('"type": "pointerdown"');
      expect(evidence, evidence).toContain('"type": "mousedown"');
      expect(evidence, evidence).toContain('"type": "pointermove"');
      expect(evidence, evidence).toContain('"type": "mousemove"');
      expect(evidence, evidence).toContain('"type": "pointerup"');
      expect(evidence, evidence).toContain('"type": "mouseup"');
      expect(evidence, evidence).toContain('dragging');
      return evidence;
    };
    const activeArtboard = canvas.locator('.react-flow__node[data-id="dashboard"]');
    const ordersArtboard = canvas.locator('.react-flow__node[data-id="orders"]');
    await expect(activeArtboard).toBeVisible();
    await expect(ordersArtboard).toBeVisible();
    const activePositionBefore = await activeArtboard.getAttribute('style');
    const ordersPositionBefore = await ordersArtboard.getAttribute('style');
    const activeDragEvidence = await dragArtboard(activeArtboard, { x: 50, y: 30 });
    await expect
      .poll(() => activeArtboard.getAttribute('style'), { message: activeDragEvidence })
      .not.toBe(activePositionBefore);
    const ordersDragEvidence = await dragArtboard(ordersArtboard, { x: -36, y: 44 });
    await expect
      .poll(() => ordersArtboard.getAttribute('style'), { message: ordersDragEvidence })
      .not.toBe(ordersPositionBefore);
    await expect(canvas.locator('.canvas-workspace__modebar output')).toContainText(
      /Saved graph revision \d+\./
    );
    const persistedActivePosition = await activeArtboard.getAttribute('style');
    const persistedOrdersPosition = await ordersArtboard.getAttribute('style');

    await window.reload();
    const reloadedCanvas = window.getByLabel('Unified design canvas');
    await expect(reloadedCanvas).toBeVisible({ timeout: 5_000 });
    await expect(reloadedCanvas.getByLabel('Compiled React artboard')).toBeVisible({
      timeout: 5_000
    });
    await expect(reloadedCanvas.locator('.react-flow__node[data-id="dashboard"]')).toHaveAttribute(
      'style',
      persistedActivePosition ?? ''
    );
    await expect(reloadedCanvas.locator('.react-flow__node[data-id="orders"]')).toHaveAttribute(
      'style',
      persistedOrdersPosition ?? ''
    );

    await modebar.getByRole('button', { name: 'Prototype' }).click();
    await expect(canvas).toHaveAttribute('data-mode', 'prototype');
    await expect(modebar.getByRole('button', { name: 'Prototype' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(canvas.locator('.canvas-prototype-edge')).not.toHaveCount(0);
    await expect(canvas.locator('.canvas-artboard__source-handle')).not.toHaveCount(0);
    await expect(compiledArtboard).toBeVisible();
    await ordersArtboard.click();
    await window.keyboard.press('Delete');
    await expect(canvas.locator('.react-flow__node[data-id="orders"]')).toHaveCount(1);

    const edge = canvas.locator('.react-flow__edge').first();
    await expect(edge).toBeVisible();
    await edge.locator('.react-flow__edge-interaction').click({ force: true });
    await expect(window.getByText('Prototype connection', { exact: true })).toBeVisible();
    await expect(window.getByText('Frame-level binding.', { exact: false })).toBeVisible();

    await modebar.getByRole('button', { name: 'Comment' }).click();
    await expect(canvas).toHaveAttribute('data-mode', 'comment');
    await expect(canvas.locator('.canvas-prototype-edge')).toHaveCount(0);
    await expect(compiledArtboard).toBeVisible();
    const commentPosition = await activeArtboard.getAttribute('style');
    await dragArtboard(activeArtboard, { x: 70, y: 35 });
    await expect(activeArtboard).toHaveAttribute('style', commentPosition ?? '');
    await window.screenshot({
      path: '../../test-results/prototype-flow-unified-wide.png',
      fullPage: true
    });

    await modebar.getByRole('button', { name: 'Present' }).click();
    await expect(canvas).toHaveAttribute('data-mode', 'present');
    await expect(canvas.getByLabel('Artboards')).toHaveCount(0);
    await expect(canvas.locator('.react-flow__node')).toHaveCount(1);
    await expect(modebar.getByRole('button')).toHaveText(['Exit presentation']);
    await expect(window.getByLabel('AI conversation')).toBeHidden();
    await expect(window.getByLabel('Progressive inspector')).toBeHidden();
    await window.screenshot({
      path: '../../test-results/prototype-flow-unified-present.png',
      fullPage: true
    });
    await window.setViewportSize({ width: 620, height: 760 });
    await expect(canvas).toBeVisible();
    await expect(compiledArtboard).toBeVisible();
    await window.screenshot({
      path: '../../test-results/prototype-flow-unified-compact.png',
      fullPage: true
    });
  } catch (error) {
    if (startupOutput) {
      try {
        await testInfo.attach('desktop-startup-output.txt', {
          body: startupOutput(),
          contentType: 'text/plain'
        });
      } catch {
        // Preserve the production journey's original assertion or startup error.
      }
    }
    throw error;
  } finally {
    if (application) await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('legacy web PrototypeFlowCanvas component contract keeps callbacks single-flight', async () => {
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: [harnessMain]
  });
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    const flow = window.getByLabel('Prototype flow canvas');
    const run = flow.getByRole('button', { name: 'Run committed graph in Preview' });
    await run.dblclick();
    await expect(run).toBeDisabled();
    await expect
      .poll(() => window.evaluate(() => window.selenePrototypeFlowHarness?.callbackCount()))
      .toBe(1);

    await window.evaluate(() => window.selenePrototypeFlowHarness?.remount());
    await expect(run).toBeEnabled();
    await run.dblclick();
    await expect(run).toBeDisabled();
    await expect
      .poll(() => window.evaluate(() => window.selenePrototypeFlowHarness?.callbackCount()))
      .toBe(2);

    expect(await window.evaluate(() => window.selenePrototypeFlowHarness?.settle(0))).toBe(true);
    await expect(flow.getByRole('status')).toContainText('Starting the committed graph in Preview');
    expect(await window.evaluate(() => window.selenePrototypeFlowHarness?.settle(1))).toBe(true);
    await expect(flow.getByRole('status')).toContainText('Preview is running the committed graph.');
  } finally {
    await closeElectron(application);
  }
});

test('legacy web PrototypeFlowCanvas component contract preserves maximum action labels', async () => {
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: [harnessMain]
  });
  const maximumActionLabel = 'W'.repeat(160);
  const evidence: unknown[] = [];
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    await expect
      .poll(() =>
        window.evaluate(() => typeof window.selenePrototypeFlowHarness?.showMaximumActionLabel)
      )
      .toBe('function');
    await window.evaluate(() => window.selenePrototypeFlowHarness?.showMaximumActionLabel());
    const flow = window.getByLabel('Prototype flow canvas');
    const longPort = flow.getByRole('button', {
      name: `${maximumActionLabel} action port`,
      exact: true
    });

    const assertViewport = async ({
      height,
      layout,
      name,
      width
    }: {
      readonly height: number;
      readonly layout: 'compact-topology' | 'source-positions';
      readonly name: 'compact' | 'wide';
      readonly width: number;
    }) => {
      await window.setViewportSize({ width, height });
      await expect
        .poll(() =>
          flow.locator('.prototype-flow__plane').getAttribute('data-prototype-flow-layout')
        )
        .toBe(layout);
      await expect(longPort).toHaveText(maximumActionLabel);
      const geometry = await flow.evaluate((element, expectedLabel) => {
        const stage = element.querySelector<HTMLElement>('.prototype-flow__viewport');
        const card = element.querySelector<HTMLElement>('[data-prototype-node="orders"]');
        const port = element.querySelector<HTMLElement>('[data-prototype-port="create"]');
        const portText = port?.querySelector<HTMLElement>('span');
        const wire = element.querySelector<SVGPathElement>(
          '[data-prototype-wire="create-order"] .prototype-flow__wire'
        );
        if (!stage || !card || !port || !portText || !wire)
          throw new Error(
            'Maximum-label Flow harness must retain its stage, card, port, and wire.'
          );
        const stageRect = stage.getBoundingClientRect();
        const stageClient = {
          bottom: stageRect.top + stage.clientTop + stage.clientHeight,
          left: stageRect.left + stage.clientLeft,
          right: stageRect.left + stage.clientLeft + stage.clientWidth,
          top: stageRect.top + stage.clientTop
        };
        const portRect = port.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const matrix = wire.getScreenCTM();
        if (!matrix) throw new Error('Maximum-label Flow wire must have a physical screen matrix.');
        const start = wire.getPointAtLength(0);
        const wireStart = {
          x: start.x * matrix.a + start.y * matrix.c + matrix.e,
          y: start.x * matrix.b + start.y * matrix.d + matrix.f
        };
        const cards = [...element.querySelectorAll<HTMLElement>('[data-prototype-node]')].map(
          (item) => item.getBoundingClientRect()
        );
        const overlaps = cards.flatMap((left, index) =>
          cards
            .slice(index + 1)
            .map(
              (right) =>
                left.left < right.right &&
                left.right > right.left &&
                left.top < right.bottom &&
                left.bottom > right.top
            )
        );
        const style = getComputedStyle(port);
        return {
          cardContainsPort:
            portRect.left >= cardRect.left &&
            portRect.right <= cardRect.right &&
            portRect.top >= cardRect.top &&
            portRect.bottom <= cardRect.bottom,
          cardHeight: cardRect.height,
          cardsWithinStage: cards.every(
            (item) =>
              item.left >= stageClient.left &&
              item.right <= stageClient.right &&
              item.top >= stageClient.top &&
              item.bottom <= stageClient.bottom
          ),
          fullText: portText.textContent === expectedLabel,
          overflowWrap: style.overflowWrap,
          overlaps,
          portHeight: port.clientHeight,
          portWidth: port.clientWidth,
          paintedPortHeight: portRect.height,
          paintedPortWidth: portRect.width,
          scrollHeight: port.scrollHeight,
          scrollWidth: port.scrollWidth,
          stageClientHeight: stage.clientHeight,
          stageClientWidth: stage.clientWidth,
          stageScrollHeight: stage.scrollHeight,
          stageScrollWidth: stage.scrollWidth,
          textOverflow: style.textOverflow,
          whiteSpace: style.whiteSpace,
          wireStartDistance: Math.hypot(
            wireStart.x - (portRect.left + portRect.width / 2),
            wireStart.y - (portRect.top + portRect.height / 2)
          )
        };
      }, maximumActionLabel);
      evidence.push({ layout: name, ...geometry });
      expect(geometry.fullText).toBe(true);
      expect(geometry.whiteSpace).toBe('normal');
      expect(geometry.overflowWrap).toBe('anywhere');
      expect(geometry.textOverflow).toBe('clip');
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.portWidth);
      expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.portHeight);
      expect(geometry.paintedPortWidth).toBeGreaterThanOrEqual(44);
      expect(geometry.paintedPortHeight).toBeGreaterThanOrEqual(44);
      expect(geometry.cardHeight).toBeGreaterThan(geometry.paintedPortHeight);
      expect(geometry.cardContainsPort).toBe(true);
      expect(geometry.wireStartDistance).toBeLessThanOrEqual(2);
      expect(geometry.overlaps).not.toContain(true);
      expect(geometry.cardsWithinStage).toBe(true);
      expect(geometry.stageScrollWidth).toBeLessThanOrEqual(geometry.stageClientWidth);
      expect(geometry.stageScrollHeight).toBeLessThanOrEqual(geometry.stageClientHeight);
    };

    await assertViewport({ height: 700, layout: 'source-positions', name: 'wide', width: 1100 });
    await assertViewport({ height: 760, layout: 'compact-topology', name: 'compact', width: 620 });
    await test.info().attach('prototype-flow-maximum-label-geometry.json', {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json'
    });
  } finally {
    await closeElectron(application);
  }
});

test('replays diagnostics through StrictMode with a fresh current lane', async ({
  browserName: _browserName
}, testInfo) => {
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: [workspaceToolbarHarnessMain]
  });
  const evidencePath = testInfo.outputPath('workspace-toolbar-diagnostics-evidence.json');
  const evidence: unknown[] = [];
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    window.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
    window.on('pageerror', (error) => pageErrors.push(error.message));
    const recordEvidence = async (checkpoint: string) => {
      evidence.push({
        checkpoint,
        component: await window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state()),
        console: [...consoleMessages],
        pageErrors: [...pageErrors]
      });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    };
    await recordEvidence('launched');
    await expect
      .poll(() =>
        window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().consentRefreshes)
      )
      .toBe(1);
    await expect
      .poll(() =>
        window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().recoveryRefreshes)
      )
      .toBe(1);
    await recordEvidence('initial host reads started');
    await window.evaluate(() => window.seleneWorkspaceToolbarHarness?.rerender());
    await expect
      .poll(() =>
        window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().consentRefreshes)
      )
      .toBe(1);
    await expect
      .poll(() =>
        window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().recoveryRefreshes)
      )
      .toBe(1);
    await recordEvidence('host wrapper rerender retained initial reads');

    await window.getByRole('button', { name: 'More' }).click();
    const operations = window.getByRole('dialog', { name: 'Workspace operations' });
    const consent = operations.getByLabel('Store local crash diagnostics');
    await expect(consent).toBeDisabled();
    await recordEvidence('initial consent remains fail-closed');
    await window.evaluate(() =>
      window.seleneWorkspaceToolbarHarness?.resolveInitialRefresh('unknown')
    );
    await expect(consent).toBeEnabled();
    await expect
      .poll(() => window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().component))
      .toMatchObject({
        busy: 'false',
        consent: 'unknown',
        consentDisabled: false,
        recovery: 'clear',
        saving: 'false'
      });
    await expect
      .poll(() => window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().trace))
      .toEqual(expect.arrayContaining(['consent:read:1:fulfilled', 'recovery:read:1:fulfilled']));
    await recordEvidence('initial reads settled unknown and enabled consent');
    await consent.check();
    await expect(consent).toBeDisabled();
    await expect
      .poll(() => window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().component))
      .toMatchObject({ busy: 'true', consentDisabled: true, saving: 'true' });
    await expect(consent).toBeChecked();
    await expect
      .poll(() =>
        window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().consentMutations)
      )
      .toBe(1);
    await window.evaluate(() => window.seleneWorkspaceToolbarHarness?.resolveConsentMutation());

    await expect(consent).toBeChecked();
    await expect(window.getByRole('button', { name: 'Render' })).toBeEnabled();
    await expect
      .poll(() =>
        window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().statusMessages)
      )
      .toEqual(['Local diagnostics enabled.']);
    await expect
      .poll(() => window.evaluate(() => window.seleneWorkspaceToolbarHarness?.state().component))
      .toMatchObject({
        busy: 'false',
        consent: 'granted',
        consentChecked: true,
        consentDisabled: false,
        recovery: 'clear',
        saving: 'false'
      });
    await recordEvidence('optimistic consent write settled');
    await testInfo.attach('workspace-toolbar-diagnostics-evidence', {
      path: evidencePath,
      contentType: 'application/json'
    });
  } finally {
    await closeElectron(application);
  }
});
