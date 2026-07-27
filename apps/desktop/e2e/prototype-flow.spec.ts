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

test('renders one compiled React artboard with prototype wiring on the unified design canvas', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(60_000);
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

    const canvas = window.getByLabel('Design canvas');
    const compiledArtboard = canvas.getByLabel('Compiled React artboard');
    const canvasTools = canvas.getByRole('toolbar', { name: 'Canvas tools' });
    await expect(canvas).toBeVisible({ timeout: 5_000 });
    await expect(compiledArtboard).toBeVisible({ timeout: 5_000 });
    await expect(
      compiledArtboard
        .frameLocator('iframe[title="Generated React preview frame"]')
        .getByRole('heading', { name: 'Dashboard' })
    ).toBeVisible({ timeout: 5_000 });
    await expect(canvasTools.getByRole('button')).toHaveText([
      'Design',
      'Present',
      'Hand H',
      'Fit all ⇧1',
      'Reset ⇧0',
      'Selection ⇧2',
      '@ Ask AI',
      '+ Comment'
    ]);
    await expect(canvasTools.getByRole('button', { name: 'Design' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(canvasTools.getByRole('button', { name: 'Hand', exact: true })).toHaveAttribute(
      'aria-keyshortcuts',
      'H'
    );
    await expect(canvasTools.getByRole('button', { name: 'Fit all', exact: true })).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+1'
    );
    await expect(canvasTools.getByRole('button', { name: 'Reset', exact: true })).toHaveAttribute(
      'aria-keyshortcuts',
      'Shift+0'
    );
    await expect(
      canvasTools.getByRole('button', { name: 'Selection', exact: true })
    ).toHaveAttribute('aria-keyshortcuts', 'Shift+2');
    await expect(window.getByRole('button', { name: 'Flow', exact: true })).toHaveCount(0);
    await expect(window.getByRole('button', { name: 'Preview', exact: true })).toHaveCount(0);
    await expect(canvas.getByText('Current screen', { exact: true })).toBeVisible();

    const activeArtboard = canvas.locator('.react-flow__node[data-id="dashboard"]');
    const ordersArtboard = canvas.locator('.react-flow__node[data-id="orders"]');
    const prototypeEdge = canvas.locator('.react-flow__edge').first();
    const graphViewport = canvas.locator('.react-flow');
    const startupGeometry = async () => {
      const [dashboardBounds, ordersBounds, edgeBounds, viewportBounds] = await Promise.all([
        activeArtboard.boundingBox(),
        ordersArtboard.boundingBox(),
        prototypeEdge.boundingBox(),
        graphViewport.boundingBox()
      ]);
      if (!dashboardBounds || !ordersBounds || !edgeBounds || !viewportBounds) return null;
      const fullyVisible = (bounds: { x: number; y: number; width: number; height: number }) =>
        bounds.x >= viewportBounds.x - 1 &&
        bounds.y >= viewportBounds.y - 1 &&
        bounds.x + bounds.width <= viewportBounds.x + viewportBounds.width + 1 &&
        bounds.y + bounds.height <= viewportBounds.y + viewportBounds.height + 1;
      const horizontallySeparated =
        dashboardBounds.x + dashboardBounds.width + 16 <= ordersBounds.x ||
        ordersBounds.x + ordersBounds.width + 16 <= dashboardBounds.x;
      const verticallySeparated =
        dashboardBounds.y + dashboardBounds.height + 16 <= ordersBounds.y ||
        ordersBounds.y + ordersBounds.height + 16 <= dashboardBounds.y;
      return {
        dashboard: dashboardBounds,
        orders: ordersBounds,
        edge: edgeBounds,
        viewport: viewportBounds,
        fullyVisible: {
          dashboard: fullyVisible(dashboardBounds),
          orders: fullyVisible(ordersBounds),
          edge: fullyVisible(edgeBounds)
        },
        authoredScreenParity: {
          heightRatio: ordersBounds.height / dashboardBounds.height,
          widthRatio: ordersBounds.width / dashboardBounds.width
        },
        artboardFramedWidthRatio:
          (Math.max(
            dashboardBounds.x + dashboardBounds.width,
            ordersBounds.x + ordersBounds.width
          ) -
            Math.min(dashboardBounds.x, ordersBounds.x)) /
          viewportBounds.width,
        nonOverlapping: horizontallySeparated || verticallySeparated
      };
    };
    await expect
      .poll(async () => {
        const [activeBounds, viewportBounds] = await Promise.all([
          activeArtboard.boundingBox(),
          graphViewport.boundingBox()
        ]);
        if (!activeBounds || !viewportBounds) return 0;
        return activeBounds.width / viewportBounds.width;
      })
      .toBeGreaterThanOrEqual(0.66);
    const fitAllPhysical = await window.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-canvas-command="fit-all"]');
      if (!button) throw new Error('Fit all command is missing from the canvas toolbar.');
      const rect = button.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return {
        center,
        hit: document.elementFromPoint(center.x, center.y)?.tagName,
        rect: rect.toJSON(),
        viewport: { height: window.innerHeight, width: window.innerWidth }
      };
    });
    await testInfo.attach('canvas-fit-all-hit.json', {
      body: JSON.stringify(fitAllPhysical, null, 2),
      contentType: 'application/json'
    });
    expect(fitAllPhysical.hit).toBe('BUTTON');
    const initialActiveScreenScreenshot = testInfo.outputPath('canvas-initial-active-screen.png');
    await window.screenshot({ path: initialActiveScreenScreenshot, fullPage: true });
    await testInfo.attach('canvas-initial-active-screen.png', {
      path: initialActiveScreenScreenshot,
      contentType: 'image/png'
    });
    await window.mouse.click(fitAllPhysical.center.x, fitAllPhysical.center.y);
    await expect(ordersArtboard).toBeVisible({ timeout: 5_000 });
    await expect(prototypeEdge).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () => (await startupGeometry())?.fullyVisible.dashboard ?? false)
      .toBe(true);
    await expect
      .poll(async () => (await startupGeometry())?.fullyVisible.orders ?? false)
      .toBe(true);
    await expect.poll(async () => (await startupGeometry())?.fullyVisible.edge ?? false).toBe(true);
    await expect
      .poll(async () => (await startupGeometry())?.authoredScreenParity.widthRatio ?? 0)
      .toBeGreaterThanOrEqual(0.98);
    await expect
      .poll(async () => (await startupGeometry())?.authoredScreenParity.heightRatio ?? 0)
      .toBeGreaterThanOrEqual(0.98);
    await expect
      .poll(async () => (await startupGeometry())?.artboardFramedWidthRatio ?? 0)
      .toBeGreaterThanOrEqual(0.72);
    await expect.poll(async () => (await startupGeometry())?.nonOverlapping ?? false).toBe(true);
    const livePreviewFrame = compiledArtboard.locator(
      'iframe[title="Generated React preview frame"]'
    );
    const topContentOwnsPointer = await livePreviewFrame.evaluate((frame) => {
      const bounds = frame.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + Math.min(12, bounds.height / 2)
      );
      return hit === frame;
    });
    expect(topContentOwnsPointer).toBe(true);
    await expect(activeArtboard.locator('.canvas-artboard__drag-handle')).toHaveAttribute(
      'title',
      'Drag artboard'
    );
    const initialMultiArtboardGeometry = testInfo.outputPath(
      'canvas-initial-multi-artboard-fit.json'
    );
    await writeFile(initialMultiArtboardGeometry, JSON.stringify(await startupGeometry(), null, 2));
    await testInfo.attach('canvas-initial-multi-artboard-fit.json', {
      path: initialMultiArtboardGeometry,
      contentType: 'application/json'
    });
    const initialMultiArtboardScreenshot = testInfo.outputPath('canvas-initial-multi-artboard.png');
    await window.screenshot({ path: initialMultiArtboardScreenshot, fullPage: true });
    await testInfo.attach('canvas-initial-multi-artboard.png', {
      path: initialMultiArtboardScreenshot,
      contentType: 'image/png'
    });

    await canvas.getByRole('button', { name: 'Pages', exact: true }).click();
    await expect(canvas.getByLabel('Artboards')).toBeVisible();
    await expect(canvas.getByRole('group', { name: 'Canvas library' })).toBeVisible();
    await canvas.getByRole('button', { name: 'Close pages and assets' }).click();
    await expect(canvas.getByLabel('Artboards')).toBeHidden();

    const dragArtboard = async (
      artboard: ReturnType<typeof canvas.locator>,
      delta: { readonly x: number; readonly y: number },
      expectedToMove = true
    ) => {
      await expect(artboard).toBeVisible();
      await artboard.evaluate((node) => {
        const events: unknown[] = [];
        node.setAttribute('data-selene-drag-events', '[]');
        const record = (event: Event) => {
          const pointer = event as PointerEvent;
          events.push({
            captureTarget: event.currentTarget === window ? 'window' : 'artboard',
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
        for (const type of ['pointerdown', 'mousedown'])
          window.addEventListener(type, record, { capture: true, once: true });
        for (const type of ['pointermove', 'mousemove', 'pointerup', 'mouseup'])
          node.addEventListener(type, record, { capture: true });
      });
      const handle = artboard
        .locator('.canvas-artboard__drag-handle, .canvas-artboard__label')
        .first();
      let previousBounds:
        | {
            readonly x: number;
            readonly y: number;
            readonly width: number;
            readonly height: number;
          }
        | undefined;
      let stableSamples = 0;
      await expect
        .poll(
          async () => {
            const candidate = await handle.boundingBox();
            if (!candidate) return false;
            const settled =
              previousBounds !== undefined &&
              Math.abs(candidate.x - previousBounds.x) < 0.25 &&
              Math.abs(candidate.y - previousBounds.y) < 0.25 &&
              Math.abs(candidate.width - previousBounds.width) < 0.25 &&
              Math.abs(candidate.height - previousBounds.height) < 0.25;
            previousBounds = candidate;
            stableSamples = settled ? stableSamples + 1 : 0;
            return stableSamples >= 2;
          },
          {
            intervals: [80, 80, 80, 80, 120],
            message: 'Artboard drag handle should settle after canvas framing.'
          }
        )
        .toBe(true);
      await expect
        .poll(
          async () => {
            const candidate = await handle.boundingBox();
            if (!candidate) return false;
            const point = {
              x: candidate.x + candidate.width / 2,
              y: candidate.y + candidate.height / 2
            };
            return handle.evaluate((element, center) => {
              const hit = document.elementFromPoint(center.x, center.y);
              return hit !== null && (hit === element || element.contains(hit));
            }, point);
          },
          { message: 'Artboard handle center should own its pointer hit after canvas framing.' }
        )
        .toBe(true);
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
              mode: node.closest('[aria-label="Design canvas"]')?.getAttribute('data-mode'),
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
      const moveAndSample = async (step: number) => {
        await window.mouse.move(start.x + (delta.x * step) / 4, start.y + (delta.y * step) / 4);
        await sample(`held move ${step}`);
      };
      await moveAndSample(1);
      await moveAndSample(2);
      await moveAndSample(3);
      await moveAndSample(4);
      await window.mouse.up();
      await sample('pointer released');
      const evidence = JSON.stringify({ hitOwnership, samples }, null, 2);
      await testInfo.attach(`canvas-drag-${await artboard.getAttribute('data-id')}.json`, {
        body: evidence,
        contentType: 'application/json'
      });
      expect(evidence, evidence).toContain('"type": "pointermove"');
      if (expectedToMove) {
        expect(evidence, evidence).toContain('"type": "pointerdown"');
        expect(evidence, evidence).toContain('"type": "mousedown"');
        expect(evidence, evidence).toContain('"type": "mousemove"');
        expect(await artboard.getAttribute('class'), evidence).toContain('draggable');
        expect(evidence, evidence).toContain('dragging');
      } else {
        expect(await artboard.getAttribute('class'), evidence).not.toContain('draggable');
        expect(evidence, evidence).not.toContain('dragging');
      }
      // React Flow clears its transient drag class in its post-pointer-up
      // reconciliation frame. Assert the settled interaction contract rather
      // than sampling that implementation detail synchronously.
      await expect(artboard, evidence).not.toHaveClass(/dragging/);
      return evidence;
    };
    const expectPresentationFillsViewport = async (viewportName: string) => {
      const presentation = window.getByLabel('Prototype presentation');
      const artifact = presentation.getByLabel('Compiled React artboard');
      const readGeometry = async () => {
        const [presentationBounds, artifactBounds, viewport, wrappers] = await Promise.all([
          presentation.boundingBox(),
          artifact.boundingBox(),
          window.evaluate(() => ({ height: innerHeight, width: innerWidth })),
          artifact.evaluate((node) => {
            const presentationRoot = node.closest('.canvas-presentation');
            const result: unknown[] = [];
            let current: Element | null = node;
            while (current && current !== presentationRoot) {
              const bounds = current.getBoundingClientRect();
              const style = getComputedStyle(current);
              result.push({
                tag: current.tagName,
                className: current.getAttribute('class'),
                bounds: bounds.toJSON(),
                display: style.display,
                height: style.height,
                padding: style.padding,
                position: style.position,
                width: style.width
              });
              current = current.parentElement;
            }
            return result;
          })
        ]);
        return { presentationBounds, artifactBounds, viewport, wrappers };
      };
      let latestGeometry: Awaited<ReturnType<typeof readGeometry>> | undefined;
      try {
        await expect
          .poll(
            async () => {
              latestGeometry = await readGeometry();
              const { presentationBounds, artifactBounds, viewport } = latestGeometry;
              if (!presentationBounds || !artifactBounds) return false;
              const tolerance = 2;
              return (
                presentationBounds.x <= tolerance &&
                presentationBounds.y <= tolerance &&
                presentationBounds.width >= viewport.width - tolerance &&
                presentationBounds.height >= viewport.height - tolerance &&
                artifactBounds.width >= presentationBounds.width - tolerance &&
                artifactBounds.height >= presentationBounds.height - tolerance
              );
            },
            {
              intervals: [80, 120, 160],
              message: `${viewportName} presentation should fill the renderer with the live React artifact.`
            }
          )
          .toBe(true);
      } finally {
        latestGeometry ??= await readGeometry();
        await testInfo.attach(
          `prototype-presentation-${viewportName.toLowerCase()}-geometry.json`,
          {
            body: JSON.stringify(latestGeometry, null, 2),
            contentType: 'application/json'
          }
        );
      }
    };
    await expect(activeArtboard).toBeVisible();
    await expect(ordersArtboard).toBeVisible();
    // The unified canvas keeps both real compiled screens in view. The inactive
    // frame is intentionally non-interactive: only the promoted artboard owns
    // the runtime bridge and receives prototype navigation.
    const ordersReferenceFrame = ordersArtboard.locator('iframe[title="Orders screen preview"]');
    await expect(ordersReferenceFrame).toBeVisible({ timeout: 5_000 });
    await expect(
      ordersArtboard
        .frameLocator('iframe[title="Orders screen preview"]')
        .getByRole('heading', { name: 'Orders' })
    ).toBeVisible({ timeout: 5_000 });
    await expect(ordersReferenceFrame).toHaveAttribute('tabindex', '-1');
    await expect(ordersReferenceFrame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin'
    );
    const dashboardToOrdersEdge = canvas.locator('.react-flow__edge[data-id="dashboard-orders"]');
    const dashboardOpenOrdersPort = activeArtboard.locator(
      '.canvas-artboard__source-handle[data-handleid="open-orders"]'
    );
    await expect(dashboardToOrdersEdge).toBeVisible();
    await expect(dashboardOpenOrdersPort).toBeVisible();
    await dashboardToOrdersEdge.focus();
    await dashboardToOrdersEdge.press('Enter');
    await expect(dashboardToOrdersEdge).toHaveClass(/selected/);
    const inactiveFrameInput = await ordersReferenceFrame.evaluate((frame) => {
      const bounds = frame.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 8);
      return {
        ariaHidden: frame.getAttribute('aria-hidden'),
        tabIndex: frame.tabIndex,
        pointerEvents: getComputedStyle(frame).pointerEvents,
        receivesPointer: hit === frame
      };
    });
    expect(inactiveFrameInput).toEqual({
      ariaHidden: 'true',
      pointerEvents: 'none',
      receivesPointer: false,
      tabIndex: -1
    });
    const openOrders = ordersArtboard.getByRole('button', { name: 'Open Orders', exact: true });
    await expect(openOrders).toBeVisible({ timeout: 5_000 });
    const openOrdersPhysical = await openOrders.evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const canvasNode = button.closest<HTMLElement>('.react-flow');
      const canvasRect = canvasNode?.getBoundingClientRect();
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      const hit = document.elementFromPoint(center.x, center.y);
      return {
        center,
        hit: hit?.tagName,
        rect: rect.toJSON(),
        viewport: { height: window.innerHeight, width: window.innerWidth },
        withinCanvas:
          canvasRect !== undefined &&
          rect.left >= canvasRect.left &&
          rect.top >= canvasRect.top &&
          rect.right <= canvasRect.right &&
          rect.bottom <= canvasRect.bottom
      };
    });
    await testInfo.attach('canvas-promote-orders.json', {
      body: JSON.stringify(openOrdersPhysical, null, 2),
      contentType: 'application/json'
    });
    expect(openOrdersPhysical.hit).toBe('BUTTON');
    expect(openOrdersPhysical.withinCanvas).toBe(true);
    await window.mouse.click(openOrdersPhysical.center.x, openOrdersPhysical.center.y);
    await expect(canvas.locator('.canvas-workspace__toolbar output')).toContainText(
      'Opened saved scenario orders-default on the canvas (active: orders).',
      { timeout: 5_000 }
    );
    await expect(ordersArtboard.locator('.canvas-artboard--active')).toBeVisible({
      timeout: 5_000
    });
    await expect(
      ordersArtboard
        .frameLocator('iframe[title="Generated React preview frame"]')
        .getByRole('heading', { name: 'Orders' })
    ).toBeVisible({ timeout: 5_000 });
    const dashboardReference = canvas.locator('.react-flow__node[data-id="dashboard"]');
    await expect(dashboardReference.getByRole('button', { name: 'Open Dashboard' })).toBeVisible();
    await dashboardReference.getByRole('button', { name: 'Open Dashboard' }).focus();
    await window.keyboard.press('Enter');
    await expect(
      activeArtboard
        .frameLocator('iframe[title="Generated React preview frame"]')
        .getByRole('heading', { name: 'Dashboard' })
    ).toBeVisible({ timeout: 5_000 });
    const activePositionBefore = await activeArtboard.getAttribute('style');
    const ordersPositionBefore = await ordersArtboard.getAttribute('style');
    const activeDragEvidence = await dragArtboard(activeArtboard, { x: -50, y: 30 });
    await expect
      .poll(() => activeArtboard.getAttribute('style'), { message: activeDragEvidence })
      .not.toBe(activePositionBefore);
    const ordersDragEvidence = await dragArtboard(ordersArtboard, { x: 60, y: 44 });
    await expect
      .poll(() => ordersArtboard.getAttribute('style'), { message: ordersDragEvidence })
      .not.toBe(ordersPositionBefore);
    await expect(canvas.locator('.canvas-workspace__toolbar output')).toContainText(
      /Saved graph revision \d+\./
    );
    const persistedActivePosition = await activeArtboard.getAttribute('style');
    const persistedOrdersPosition = await ordersArtboard.getAttribute('style');

    await window.reload();
    const reloadedCanvas = window.getByLabel('Design canvas');
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

    await expect(canvas).toHaveAttribute('data-mode', 'design');
    await expect(canvasTools.getByRole('button', { name: 'Design' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(canvas.locator('.canvas-prototype-edge')).not.toHaveCount(0);
    await expect(canvas.locator('.canvas-artboard__source-handle')).not.toHaveCount(0);
    await expect(compiledArtboard).toBeVisible();
    await canvas.getByRole('button', { name: 'Pages', exact: true }).click();
    const ordersLayerItem = canvas
      .getByLabel('Artboards')
      .locator('button:not(.canvas-workspace__layer-run)')
      .filter({ hasText: 'Orders' });
    await ordersLayerItem.click();
    await expect(ordersLayerItem).toHaveAttribute('aria-pressed', 'true');
    await expect(ordersArtboard).toBeVisible();
    await expect(ordersArtboard).toHaveClass(/selected/);
    await window.keyboard.press('Delete');
    await expect(canvas.locator('.react-flow__node[data-id="orders"]')).toHaveCount(1);

    const edge = prototypeEdge;
    await expect(edge).toBeVisible();
    await edge.focus();
    await expect(edge).toBeFocused();
    await edge.press('Enter');
    await expect(edge).toHaveClass(/selected/);
    await expect(window.getByText('Prototype connection', { exact: true })).toBeVisible();
    await expect(window.getByText('Frame-level binding.', { exact: false })).toBeVisible();
    const activeLayerItem = canvas
      .getByLabel('Artboards')
      .locator('button:not(.canvas-workspace__layer-run)')
      .filter({ hasText: 'Dashboard' });
    await activeLayerItem.click();
    await expect(activeLayerItem).toHaveAttribute('aria-pressed', 'true');
    await canvas.getByRole('button', { name: 'Close pages and assets' }).click();
    await canvasTools.getByRole('button', { name: 'Selection', exact: true }).click();
    await expect
      .poll(async () => (await startupGeometry())?.fullyVisible.dashboard ?? false)
      .toBe(true);

    const handTool = canvasTools.getByRole('button', { name: /Hand/ });
    await handTool.click();
    await expect(handTool).toHaveAttribute('aria-pressed', 'true');
    const handPosition = await activeArtboard.evaluate((artboard) => artboard.style.transform);
    const viewport = canvas.locator('.react-flow__viewport');
    const viewportBeforeHandPan = await viewport.getAttribute('style');
    const navigationShield = activeArtboard.locator('.canvas-artboard__navigation-shield');
    const shieldBounds = await navigationShield.boundingBox();
    expect(shieldBounds).not.toBeNull();
    if (!shieldBounds) throw new Error('Hand tool must expose a physical canvas pan surface.');
    const handStart = {
      x: shieldBounds.x + shieldBounds.width / 2,
      y: shieldBounds.y + shieldBounds.height / 2
    };
    const shieldHit = await navigationShield.evaluate((shield, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        hitClass: hit instanceof HTMLElement ? hit.className : null,
        ownedByShield: hit !== null && (hit === shield || shield.contains(hit))
      };
    }, handStart);
    expect(shieldHit.ownedByShield, JSON.stringify(shieldHit)).toBe(true);
    await window.mouse.move(handStart.x, handStart.y);
    await window.mouse.down();
    await window.mouse.move(handStart.x + 35, handStart.y + 18);
    await window.mouse.move(handStart.x + 70, handStart.y + 35);
    await window.mouse.up();
    await expect
      .poll(() => viewport.getAttribute('style'), {
        message: 'Hand drag should pan the canvas viewport without moving the artboard node.'
      })
      .not.toBe(viewportBeforeHandPan);
    await expect
      .poll(() => activeArtboard.evaluate((artboard) => artboard.style.transform))
      .toBe(handPosition);
    await testInfo.attach('canvas-hand-pan.json', {
      body: JSON.stringify(
        {
          nodePosition: handPosition,
          shieldHit,
          viewportAfter: await viewport.getAttribute('style'),
          viewportBefore: viewportBeforeHandPan
        },
        null,
        2
      ),
      contentType: 'application/json'
    });

    // Comment threads are artifact-native pins, launched from a screen-space
    // canvas action rather than a graph-scaled artboard control or a mode.
    const addComment = canvasTools.getByRole('button', {
      name: 'Add a comment anywhere on the artifact',
      exact: true
    });
    await expect(addComment).toBeVisible();
    await addComment.click();
    await expect(handTool).toHaveAttribute('aria-pressed', 'false');
    const reviewTarget = compiledArtboard.getByRole('button', {
      name: 'Select a stakeholder review location in the rendered artifact',
      exact: true
    });
    await expect(reviewTarget).toBeVisible();
    const reviewTargetBounds = await reviewTarget.boundingBox();
    if (!reviewTargetBounds)
      throw new Error('The review target layer must expose an artifact-sized hit surface.');
    await window.mouse.click(
      reviewTargetBounds.x + reviewTargetBounds.width * 0.12,
      reviewTargetBounds.y + reviewTargetBounds.height * 0.12
    );
    const reviewBody = 'Keep this workflow ready for the next review.';
    const reviewComposer = window.getByLabel('Stakeholder review thread body');
    await expect(reviewComposer).toBeVisible();
    await reviewComposer.fill(reviewBody);
    await window.getByRole('button', { name: 'Start stakeholder thread', exact: true }).click();
    const screenSpaceThread = window.getByRole('dialog', { name: /Review thread from/ });
    await expect(screenSpaceThread).toContainText(reviewBody);
    const screenSpaceThreadEvidence = await screenSpaceThread.evaluate((card) => {
      const workspace = card.closest<HTMLElement>('.canvas-workspace');
      const artifact = workspace?.querySelector<HTMLElement>('.canvas-artboard__compiled');
      if (!workspace || !artifact)
        throw new Error('Selected review thread must remain owned by the design canvas artifact.');
      const bounds = card.getBoundingClientRect();
      const canvasBounds = workspace.getBoundingClientRect();
      return {
        artifactOverflow: getComputedStyle(artifact).overflow,
        canvas: canvasBounds.toJSON(),
        card: bounds.toJSON(),
        transform: getComputedStyle(card).transform,
        withinCanvas:
          bounds.left >= canvasBounds.left &&
          bounds.right <= canvasBounds.right &&
          bounds.top >= canvasBounds.top &&
          bounds.bottom <= canvasBounds.bottom
      };
    });
    expect(screenSpaceThreadEvidence.card.width).toBeGreaterThanOrEqual(280);
    expect(screenSpaceThreadEvidence.card.width).toBeLessThanOrEqual(340);
    expect(screenSpaceThreadEvidence.artifactOverflow).toBe('visible');
    expect(screenSpaceThreadEvidence.withinCanvas).toBe(true);
    await testInfo.attach('screen-space-review-thread.json', {
      body: JSON.stringify(screenSpaceThreadEvidence, null, 2),
      contentType: 'application/json'
    });
    await testInfo.attach('screen-space-review-thread.png', {
      body: await window.screenshot(),
      contentType: 'image/png'
    });
    const selectedReviewPin = compiledArtboard.locator('.preview-pin').first();
    await expect(selectedReviewPin).toHaveCount(1);
    await expect(selectedReviewPin).toHaveAttribute('aria-pressed', 'true');
    await window.keyboard.press('Shift+1');
    await expect(screenSpaceThread).toHaveCount(0);
    await expect(selectedReviewPin).toHaveAttribute('aria-pressed', 'false');
    await handTool.click();
    await expect(handTool).toHaveAttribute('aria-pressed', 'false');
    await canvasTools.getByRole('button', { name: 'Selection', exact: true }).click();
    await expect
      .poll(async () => (await startupGeometry())?.fullyVisible.dashboard ?? false)
      .toBe(true);
    await window.screenshot({
      path: '../../test-results/prototype-flow-unified-wide.png',
      fullPage: true
    });

    await canvasTools.getByRole('button', { name: 'Present' }).click();
    const presentation = window.getByLabel('Prototype presentation');
    const presentedArtifact = presentation.getByLabel('Compiled React artboard');
    await expect(presentation).toBeVisible({ timeout: 5_000 });
    await expect(presentedArtifact).toBeVisible({ timeout: 5_000 });
    await expect(
      presentedArtifact
        .frameLocator('iframe[title="Generated React preview frame"]')
        .getByRole('heading', { name: 'Dashboard' })
    ).toBeVisible({ timeout: 5_000 });
    await expect(presentedArtifact).toHaveAttribute('data-preview-state', 'ready');
    await expect(window.locator('.react-flow')).toHaveCount(0);
    await expect(window.locator('iframe[title$="screen preview"]')).toHaveCount(0);
    await expect(window.getByLabel('AI conversation', { exact: true })).toBeHidden();
    await expect(window.getByLabel('Progressive inspector', { exact: true })).toBeHidden();
    await expectPresentationFillsViewport('Wide');
    await expect(
      canvas.getByRole('button', { name: 'Add a comment anywhere on the artifact' })
    ).toHaveCount(0);
    await expect(window.locator('.preview-pin, .spatial-thread-card')).toHaveCount(0);
    const presentedFrame = presentedArtifact.locator(
      'iframe[title="Generated React preview frame"]'
    );
    const presentedPrototype = presentedFrame.contentFrame();
    const clickPresentedAction = async (action: {
      readonly label: string;
      readonly nodeId: string;
      readonly portId: string;
    }) => {
      const control = presentedPrototype.getByRole('button', { name: action.label, exact: true });
      await expect(control).toBeVisible({ timeout: 5_000 });
      const [frameBounds, controlBounds] = await Promise.all([
        presentedFrame.boundingBox(),
        control.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          return {
            actionPort: button.getAttribute('data-selene-action-port'),
            center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
            nodeId: button.getAttribute('data-selene-flow-node'),
            viewport: { height: innerHeight, width: innerWidth }
          };
        })
      ]);
      if (!frameBounds || controlBounds.viewport.width <= 0 || controlBounds.viewport.height <= 0)
        throw new Error('Presentation action must have a physical preview frame and viewport.');
      const physical = {
        x:
          frameBounds.x +
          (controlBounds.center.x / controlBounds.viewport.width) * frameBounds.width,
        y:
          frameBounds.y +
          (controlBounds.center.y / controlBounds.viewport.height) * frameBounds.height
      };
      const hit = await window.evaluate(
        (point) => document.elementFromPoint(point.x, point.y)?.tagName,
        physical
      );
      expect(
        { ...controlBounds, frameBounds, hit, physical },
        `Presentation action ${action.label} must be a physical button owned by the live iframe.`
      ).toMatchObject({
        actionPort: action.portId,
        hit: 'IFRAME',
        nodeId: action.nodeId
      });
      await testInfo.attach(`presentation-action-${action.portId}.json`, {
        body: JSON.stringify({ ...controlBounds, frameBounds, hit, physical }, null, 2),
        contentType: 'application/json'
      });
      await window.mouse.click(physical.x, physical.y);
    };
    // Presentation is the only live runtime surface. Its action traverses the
    // compiled Dashboard → Orders transition; reference frames were removed
    // with the canvas and never receive a MessageChannel.
    await clickPresentedAction({
      label: 'Open orders',
      nodeId: 'dashboard',
      portId: 'open-orders'
    });
    await expect(presentedPrototype.getByRole('heading', { name: 'Orders' })).toBeVisible({
      timeout: 5_000
    });
    await clickPresentedAction({ label: 'Back', nodeId: 'orders', portId: 'back' });
    await expect(presentedPrototype.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
      timeout: 5_000
    });
    await window.screenshot({
      path: '../../test-results/prototype-flow-unified-present.png',
      fullPage: true
    });
    await window.setViewportSize({ width: 620, height: 760 });
    await expect(presentation).toBeVisible();
    await expect(presentedArtifact).toBeVisible();
    await expectPresentationFillsViewport('Compact');
    const exitPresentation = presentation.getByRole('button', { name: /Exit/ });
    await expect(exitPresentation).toBeVisible();
    await expect(exitPresentation).toBeInViewport();
    await window.screenshot({
      path: '../../test-results/prototype-flow-unified-compact.png',
      fullPage: true
    });
    await window.keyboard.press('Escape');
    await expect(window.getByLabel('Design canvas')).toBeVisible({ timeout: 5_000 });
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
