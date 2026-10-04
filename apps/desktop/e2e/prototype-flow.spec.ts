import {
  _electron as electron,
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo
} from '@playwright/test';
import { type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

import { assertNativeElectronTestAllowed } from '../../../scripts/playwright-harness.mjs';

test.beforeAll(() => assertNativeElectronTestAllowed());

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const harnessMain = fileURLToPath(new URL('./prototype-flow-harness-main.cjs', import.meta.url));
const workspaceToolbarHarnessMain = fileURLToPath(
  new URL('./workspace-toolbar-diagnostics-harness-main.cjs', import.meta.url)
);
const require = createRequire(import.meta.url);
const startupOutputLimit = 16_384;

interface PresentationPaintEvidence {
  readonly columnSpan: number;
  readonly height: number;
  readonly nonWhitePixels: number;
  readonly nonWhiteRatio: number;
  readonly paintedColumns: number;
  readonly paintedRows: number;
  readonly rowSpan: number;
  readonly topLeftNonWhitePixels: number;
  readonly width: number;
}

/**
 * Read the raster owned by the compiled artifact. Edge strips and the fixed
 * Exit control's equivalent corner cannot count as proof of live content.
 */
function presentationPaintEvidence(png: Uint8Array): PresentationPaintEvidence {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => png[index] !== value))
    throw new Error('Presentation evidence must be a PNG screenshot.');
  let cursor = signature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (cursor + 12 <= png.length) {
    const length =
      (png[cursor] << 24) | (png[cursor + 1] << 16) | (png[cursor + 2] << 8) | png[cursor + 3];
    const type = String.fromCharCode(
      png[cursor + 4],
      png[cursor + 5],
      png[cursor + 6],
      png[cursor + 7]
    );
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > png.length || length < 0) throw new Error('Presentation PNG is truncated.');
    if (type === 'IHDR') {
      width =
        (png[dataStart] << 24) |
        (png[dataStart + 1] << 16) |
        (png[dataStart + 2] << 8) |
        png[dataStart + 3];
      height =
        (png[dataStart + 4] << 24) |
        (png[dataStart + 5] << 16) |
        (png[dataStart + 6] << 8) |
        png[dataStart + 7];
      bitDepth = png[dataStart + 8];
      colorType = png[dataStart + 9];
    }
    if (type === 'IDAT') idat.push(Buffer.from(png.subarray(dataStart, dataEnd)));
    cursor = dataEnd + 4;
    if (type === 'IEND') break;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  if (width <= 0 || height <= 0 || bitDepth !== 8 || ![0, 2, 4, 6].includes(colorType))
    throw new Error('Presentation PNG must use an 8-bit RGB-compatible color format.');
  const rowBytes = width * channels;
  const data = inflateSync(Buffer.concat(idat));
  if (data.length < height * (rowBytes + 1))
    throw new Error('Presentation PNG rows are incomplete.');
  const previous = new Uint8Array(rowBytes);
  const current = new Uint8Array(rowBytes);
  const insetX = Math.max(24, Math.floor(width * 0.02));
  const insetTop = Math.max(24, Math.floor(height * 0.03));
  const insetBottom = Math.max(32, Math.floor(height * 0.04));
  let nonWhitePixels = 0;
  let eligiblePixels = 0;
  let topLeftNonWhitePixels = 0;
  let firstPaintedColumn = width;
  let lastPaintedColumn = -1;
  let firstPaintedRow = height;
  let lastPaintedRow = -1;
  const paintedColumns = new Set<number>();
  const paintedRows = new Set<number>();
  let offset = 0;
  const paeth = (left: number, up: number, upLeft: number) => {
    const prediction = left + up - upLeft;
    const leftDistance = Math.abs(prediction - left);
    const upDistance = Math.abs(prediction - up);
    const upLeftDistance = Math.abs(prediction - upLeft);
    return leftDistance <= upDistance && leftDistance <= upLeftDistance
      ? left
      : upDistance <= upLeftDistance
        ? up
        : upLeft;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = data[offset++];
    for (let index = 0; index < rowBytes; index += 1) {
      const encoded = data[offset++];
      const left = index >= channels ? current[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      current[index] =
        filter === 0
          ? encoded
          : filter === 1
            ? (encoded + left) & 255
            : filter === 2
              ? (encoded + up) & 255
              : filter === 3
                ? (encoded + Math.floor((left + up) / 2)) & 255
                : filter === 4
                  ? (encoded + paeth(left, up, upLeft)) & 255
                  : (() => {
                      throw new Error('Presentation PNG uses an unsupported row filter.');
                    })();
    }
    for (let x = 0; x < width; x += 1) {
      const withinArtifactInterior =
        x >= insetX && x < width - insetX && y >= insetTop && y < height - insetBottom;
      const isExitControl = x >= width - 240 && y < 100;
      if (!withinArtifactInterior || isExitControl) continue;
      const pixel = x * channels;
      const gray = current[pixel];
      const red = colorType === 0 || colorType === 4 ? gray : current[pixel];
      const green = colorType === 0 || colorType === 4 ? gray : current[pixel + 1];
      const blue = colorType === 0 || colorType === 4 ? gray : current[pixel + 2];
      const alpha =
        colorType === 6 ? current[pixel + 3] : colorType === 4 ? current[pixel + 1] : 255;
      eligiblePixels += 1;
      if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) {
        nonWhitePixels += 1;
        firstPaintedColumn = Math.min(firstPaintedColumn, x);
        lastPaintedColumn = Math.max(lastPaintedColumn, x);
        firstPaintedRow = Math.min(firstPaintedRow, y);
        lastPaintedRow = Math.max(lastPaintedRow, y);
        paintedColumns.add(x);
        paintedRows.add(y);
        if (x < width * 0.6 && y < height * 0.6) topLeftNonWhitePixels += 1;
      }
    }
    previous.set(current);
  }
  return {
    columnSpan: Math.max(0, lastPaintedColumn - firstPaintedColumn + 1),
    height,
    nonWhitePixels,
    nonWhiteRatio: eligiblePixels === 0 ? 0 : nonWhitePixels / eligiblePixels,
    paintedColumns: paintedColumns.size,
    paintedRows: paintedRows.size,
    rowSpan: Math.max(0, lastPaintedRow - firstPaintedRow + 1),
    topLeftNonWhitePixels,
    width
  };
}

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
  assertNativeElectronTestAllowed();
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

interface ArtboardDragEventEvidence {
  readonly captureTarget: 'window' | 'artboard';
  readonly type: string;
  readonly target: string | null;
  readonly isTrusted: boolean;
  readonly ownedByHandle: boolean;
  readonly button: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly defaultPrevented: boolean;
}

interface ArtboardDragSample {
  readonly checkpoint: string;
  readonly className: string;
  readonly handleBounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
  readonly style: string | null;
  readonly transform: string;
  readonly viewportTransform: string | null;
  readonly mode: string | null | undefined;
  readonly events: readonly ArtboardDragEventEvidence[];
}

/** One native gesture, with evidence that input reached the handle and moved the node. */
async function dragArtboard(
  page: Page,
  artboard: Locator,
  delta: { readonly x: number; readonly y: number },
  testInfo: TestInfo,
  expectedToMove = true
): Promise<string> {
  await expect(artboard).toBeVisible();
  if (expectedToMove) await expect(artboard).toHaveClass(/\bdraggable\b/);
  else await expect(artboard).not.toHaveClass(/\bdraggable\b/);
  const handle = artboard.locator('.canvas-artboard__drag-handle, .canvas-artboard__label').first();
  await expect(handle).toBeVisible();
  let previousBounds: Awaited<ReturnType<typeof handle.boundingBox>>;
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        // fitView queues measured nodes and advances its animation on paint
        // frames. Wall-clock polls can repeatedly read unchanged geometry while
        // those frames are stalled on a hosted native display.
        const candidate = await handle.evaluate(async (element) => {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const bounds = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2
          );
          return {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            ownsCenter: hit !== null && (hit === element || element.contains(hit))
          };
        });
        const settled =
          previousBounds !== undefined &&
          previousBounds !== null &&
          Math.abs(candidate.x - previousBounds.x) < 0.25 &&
          Math.abs(candidate.y - previousBounds.y) < 0.25 &&
          Math.abs(candidate.width - previousBounds.width) < 0.25 &&
          Math.abs(candidate.height - previousBounds.height) < 0.25;
        previousBounds = candidate;
        stableSamples = settled ? stableSamples + 1 : 0;
        return stableSamples >= 3 && candidate.ownsCenter;
      },
      {
        intervals: [80],
        timeout: 5_000,
        message: 'Artboard drag handle should settle and own its pointer hit after canvas framing.'
      }
    )
    .toBe(true);
  const bounds = await handle.boundingBox();
  if (!bounds) throw new Error('Artboard drag handle has no physical bounds.');
  let start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const hitOwnership = () =>
    handle.evaluate((element, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        hitClass: hit instanceof HTMLElement ? hit.className : null,
        hitTag: hit?.tagName ?? null,
        ownedByHandle: hit !== null && (hit === element || element.contains(hit)),
        hovered: element.matches(':hover')
      };
    }, start);
  const beforeHitOwnership = await hitOwnership();
  expect(beforeHitOwnership.ownedByHandle, JSON.stringify(beforeHitOwnership)).toBe(true);
  await artboard.evaluate((node) => {
    const events: ArtboardDragEventEvidence[] = [];
    const controller = new AbortController();
    node.setAttribute('data-selene-drag-events', '[]');
    const record = (event: Event) => {
      const pointer = event as PointerEvent;
      const target = event.target instanceof Element ? event.target : null;
      const targetHandle = target?.closest(
        '.canvas-artboard__drag-handle, .canvas-artboard__label'
      );
      events.push({
        captureTarget: event.currentTarget === window ? 'window' : 'artboard',
        type: event.type,
        target: target instanceof HTMLElement ? `${target.tagName}.${target.className}` : null,
        isTrusted: event.isTrusted,
        ownedByHandle:
          targetHandle !== undefined && targetHandle !== null && node.contains(targetHandle),
        button: pointer.button,
        buttons: pointer.buttons,
        clientX: pointer.clientX,
        clientY: pointer.clientY,
        defaultPrevented: event.defaultPrevented
      });
      node.setAttribute('data-selene-drag-events', JSON.stringify(events));
    };
    // d3 captures held mousemove at window and can stop delivery to the node.
    // Observe there before the gesture as well as on the artboard itself.
    for (const type of [
      'pointerdown',
      'mousedown',
      'pointermove',
      'mousemove',
      'pointerup',
      'mouseup'
    ])
      window.addEventListener(type, record, { capture: true, signal: controller.signal });
    for (const type of ['pointermove', 'mousemove', 'pointerup', 'mouseup'])
      node.addEventListener(type, record, { capture: true, signal: controller.signal });
    node.addEventListener('selene-e2e-drag-cleanup', () => controller.abort(), { once: true });
  });
  const samples: ArtboardDragSample[] = [];
  const sample = async (checkpoint: string) => {
    const result = await artboard.evaluate((node, name) => {
      const sampledHandle = node.querySelector(
        '.canvas-artboard__drag-handle, .canvas-artboard__label'
      );
      const sampledBounds = sampledHandle?.getBoundingClientRect();
      return {
        checkpoint: name,
        className: node.getAttribute('class') ?? '',
        handleBounds: sampledBounds
          ? {
              x: sampledBounds.x,
              y: sampledBounds.y,
              width: sampledBounds.width,
              height: sampledBounds.height
            }
          : null,
        style: node.getAttribute('style'),
        transform: (node as HTMLElement).style.transform,
        viewportTransform: node.closest('.react-flow__viewport')?.getAttribute('style') ?? null,
        mode: node.closest('[aria-label="Design canvas"]')?.getAttribute('data-mode'),
        events: JSON.parse(
          node.getAttribute('data-selene-drag-events') ?? '[]'
        ) as ArtboardDragEventEvidence[]
      };
    }, checkpoint);
    samples.push(result);
    return result;
  };
  const settlePaint = () =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        })
    );
  let hoveredHitOwnership: Awaited<ReturnType<typeof hitOwnership>> | undefined;
  let pointerHeld = false;
  let evidence = '';
  try {
    const before = await sample('before pointer delivery');
    // Native locator hover waits for painted stability and resolves the current
    // handle, rather than delivering a pointer to an earlier viewport center.
    await handle.hover({ timeout: 5_000 });
    // The native iframe compositor workaround is activated by header hover.
    // Geometry can already be stable before that hover state has been painted.
    await settlePaint();
    const hoverDelivery = await sample('native handle hover delivered');
    const nativeHover = [...hoverDelivery.events]
      .reverse()
      .find(
        (event) =>
          event.captureTarget === 'window' &&
          event.type === 'pointermove' &&
          event.isTrusted &&
          event.ownedByHandle &&
          event.buttons === 0
      );
    if (!nativeHover)
      throw new Error(
        `Native hover must reach this artboard handle: ${JSON.stringify(hoverDelivery)}`
      );
    // Continue from the point that actually received native input, including
    // any framing that completed during the locator's actionability wait.
    start = { x: nativeHover.clientX, y: nativeHover.clientY };
    hoveredHitOwnership = await hitOwnership();
    expect(hoveredHitOwnership.ownedByHandle, JSON.stringify(hoveredHitOwnership)).toBe(true);
    expect(hoveredHitOwnership.hovered, JSON.stringify(hoveredHitOwnership)).toBe(true);
    await sample('handle hovered');
    await page.mouse.down();
    pointerHeld = true;
    const held = await sample('pointer held');
    if (expectedToMove) {
      for (const type of ['pointerdown', 'mousedown']) {
        expect(
          held.events.some(
            (event) =>
              event.type === type &&
              event.isTrusted &&
              event.ownedByHandle &&
              event.button === 0 &&
              event.buttons === 1
          ),
          `${type} must reach this artboard handle: ${JSON.stringify(held)}`
        ).toBe(true);
      }
    }
    const moveAndSample = async (step: number) => {
      await page.mouse.move(start.x + (delta.x * step) / 4, start.y + (delta.y * step) / 4);
      await sample(`held move ${step}`);
    };
    await moveAndSample(1);
    await moveAndSample(2);
    await moveAndSample(3);
    await moveAndSample(4);
    await settlePaint();
    const moved = await sample('held movement settled');
    const heldMovement = moved.events.some(
      (event) => event.type === 'mousemove' && event.isTrusted && event.buttons === 1
    );
    expect(heldMovement, JSON.stringify(moved)).toBe(true);
    if (expectedToMove) {
      expect(moved.className, JSON.stringify(moved)).toMatch(/\bdragging\b/);
      expect(moved.transform, JSON.stringify(samples)).not.toBe(before.transform);
    } else {
      expect(moved.className, JSON.stringify(moved)).not.toMatch(/\bdragging\b/);
      expect(moved.transform, JSON.stringify(samples)).toBe(before.transform);
    }
  } finally {
    if (pointerHeld) await page.mouse.up();
    await sample('pointer released');
    evidence = JSON.stringify({ beforeHitOwnership, hoveredHitOwnership, samples }, null, 2);
    await testInfo.attach(`canvas-drag-${await artboard.getAttribute('data-id')}.json`, {
      body: evidence,
      contentType: 'application/json'
    });
    // This event only removes test-owned diagnostic listeners.
    await artboard.evaluate((node) => node.dispatchEvent(new Event('selene-e2e-drag-cleanup')));
  }
  // React Flow clears its transient drag class in its post-pointer-up frame.
  await expect(artboard, evidence).not.toHaveClass(/\bdragging\b/);
  return evidence;
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
      'Components',
      'Present',
      'Undo',
      'Redo',
      'Connections',
      'Hand H',
      'Fit all ⇧1',
      'Reset ⇧0',
      'Fit ⇧2',
      'V',
      '@ Ask AI'
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
      canvasTools.getByRole('button', { name: 'Fit selection', exact: true })
    ).toHaveAttribute('aria-keyshortcuts', 'Shift+2');
    await expect(
      canvasTools.getByRole('button', { name: 'Selection', exact: true })
    ).toHaveAttribute('aria-keyshortcuts', 'V');
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
    const previewBridgeOwnsPointer = await compiledArtboard.evaluate((artboard) => {
      const frame = artboard.querySelector<HTMLIFrameElement>('iframe');
      const bounds = frame?.getBoundingClientRect();
      if (!bounds) throw new Error('Idle compiled artboard has no live React frame.');
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + Math.min(12, bounds.height / 2)
      );
      return {
        bridge: hit?.hasAttribute('data-selene-native-input-bridge') ?? false,
        pointerEvents: hit ? getComputedStyle(hit).pointerEvents : null,
        topTagName: hit?.tagName
      };
    });
    expect(previewBridgeOwnsPointer).toEqual({
      bridge: true,
      pointerEvents: 'auto',
      topTagName: 'DIV'
    });
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
    ).toBeVisible({ timeout: 15_000 });
    const dashboardReference = canvas.locator('.react-flow__node[data-id="dashboard"]');
    await expect(dashboardReference.getByRole('button', { name: 'Open Dashboard' })).toBeVisible();
    await dashboardReference.getByRole('button', { name: 'Open Dashboard' }).focus();
    await window.keyboard.press('Enter');
    await expect(
      activeArtboard
        .frameLocator('iframe[title="Generated React preview frame"]')
        .getByRole('heading', { name: 'Dashboard' })
    ).toBeVisible({ timeout: 15_000 });
    const readArtboardGeometry = (artboard: Locator) =>
      artboard.evaluate((node) => {
        const style = (node as HTMLElement).style;
        // React Flow's focus/selection elevation is transient UI state. The
        // host persists positions and authored dimensions, not selected z-index.
        return {
          position: style.position,
          transform: style.transform,
          width: style.width,
          height: style.height
        };
      });
    const readSavedScreenPositions = () =>
      window.evaluate(async () => {
        const graph = (await window.selene.designer.snapshot()).editablePrototype.graph;
        const dashboard = graph.nodes.find((node) => node.id === 'dashboard')?.position;
        const orders = graph.nodes.find((node) => node.id === 'orders')?.position;
        if (!dashboard || !orders) throw new Error('Authored screen positions are unavailable.');
        return { dashboard, orders };
      });
    const activePositionBefore = await readArtboardGeometry(activeArtboard);
    const ordersPositionBefore = await readArtboardGeometry(ordersArtboard);
    const savedPositionsBefore = await readSavedScreenPositions();
    const activeDragEvidence = await dragArtboard(
      window,
      activeArtboard,
      { x: -50, y: 30 },
      testInfo
    );
    await expect
      .poll(() => readArtboardGeometry(activeArtboard), { message: activeDragEvidence })
      .not.toEqual(activePositionBefore);
    await expect
      .poll(async () => (await readSavedScreenPositions()).dashboard)
      .not.toEqual(savedPositionsBefore.dashboard);
    const ordersDragEvidence = await dragArtboard(
      window,
      ordersArtboard,
      { x: 60, y: 44 },
      testInfo
    );
    await expect
      .poll(() => readArtboardGeometry(ordersArtboard), { message: ordersDragEvidence })
      .not.toEqual(ordersPositionBefore);
    await expect
      .poll(async () => (await readSavedScreenPositions()).orders)
      .not.toEqual(savedPositionsBefore.orders);
    await expect(canvas.locator('.canvas-workspace__toolbar output')).toContainText(
      /Saved graph revision \d+\./
    );
    const persistedActivePosition = await readArtboardGeometry(activeArtboard);
    const persistedOrdersPosition = await readArtboardGeometry(ordersArtboard);
    const persistedScreenPositions = await readSavedScreenPositions();

    await window.reload();
    const reloadedCanvas = window.getByLabel('Design canvas');
    await expect(reloadedCanvas).toBeVisible({ timeout: 5_000 });
    await expect(reloadedCanvas.getByLabel('Compiled React artboard')).toBeVisible({
      timeout: 5_000
    });
    await expect
      .poll(() =>
        readArtboardGeometry(reloadedCanvas.locator('.react-flow__node[data-id="dashboard"]'))
      )
      .toEqual(persistedActivePosition);
    await expect
      .poll(() =>
        readArtboardGeometry(reloadedCanvas.locator('.react-flow__node[data-id="orders"]'))
      )
      .toEqual(persistedOrdersPosition);
    await expect.poll(readSavedScreenPositions).toEqual(persistedScreenPositions);

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
    await canvas.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    await expect(window.getByText('Prototype connection', { exact: true })).toBeVisible();
    await expect(window.getByText('Frame-level binding.', { exact: false })).toBeVisible();
    const activeLayerItem = canvas
      .getByLabel('Artboards')
      .locator('button:not(.canvas-workspace__layer-run)')
      .filter({ hasText: 'Dashboard' });
    await activeLayerItem.click();
    await expect(activeLayerItem).toHaveAttribute('aria-pressed', 'true');
    await canvas.getByRole('button', { name: 'Close pages and assets' }).click();
    await canvasTools.getByRole('button', { name: 'Fit selection', exact: true }).click();
    await expect
      .poll(async () => (await startupGeometry())?.fullyVisible.dashboard ?? false)
      .toBe(true);
    await canvasTools.getByRole('button', { name: 'Selection', exact: true }).click();

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

    // Hand pan stays armed until it is toggled off. Restore the Design surface
    // and the selection tool before a live React click becomes compiler-mapped.
    await canvasTools.getByRole('button', { name: 'Hand', exact: true }).click();
    await expect(canvasTools.getByRole('button', { name: 'Hand', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await canvasTools.getByRole('button', { name: 'Design', exact: true }).click();
    await expect(canvas).toHaveAttribute('data-mode', 'design');
    await expect(canvasTools.getByRole('button', { name: 'Design', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // Threads begin only from a compiler-mapped element in the live artifact.
    const mappedCommentTarget = compiledArtboard
      .frameLocator('iframe[title="Generated React preview frame"]')
      .getByRole('button', { name: 'Open orders', exact: true });
    const mappedCommentBounds = await mappedCommentTarget.boundingBox();
    if (!mappedCommentBounds)
      throw new Error('The mapped artifact action must expose physical click bounds.');
    await window.mouse.click(
      mappedCommentBounds.x + mappedCommentBounds.width / 2,
      mappedCommentBounds.y + mappedCommentBounds.height / 2
    );
    const selectedElementActions = window.getByRole('toolbar', {
      name: 'Selected React element actions'
    });
    await expect
      .poll(async () => {
        const workspace = window.locator('main[aria-label="Selene desktop designer"]');
        return {
          bridgeState: await window
            .locator('[data-selene-native-input-bridge]')
            .getAttribute('data-selene-native-input-state'),
          selectionStage: await workspace.getAttribute('data-selene-preview-selection-stage'),
          toolbarCount: await selectedElementActions.count()
        };
      })
      .toEqual({ bridgeState: 'posted', selectionStage: 'authorized', toolbarCount: 1 });
    await selectedElementActions.getByRole('button', { name: 'Comment', exact: true }).click();
    const reviewBody = 'Keep this workflow ready for the next review.';
    const reviewComposer = window.getByLabel('Stakeholder review thread body');
    await expect(reviewComposer).toBeVisible();
    await reviewComposer.fill(reviewBody);
    await window.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(async () =>
        window.evaluate(async (threadBody) => {
          const snapshot = await window.selene.designer.snapshot();
          const thread = snapshot.reviewThreads.find((item) => item.body === threadBody);
          return thread !== undefined && snapshot.artifactPins.some((pin) => pin.id === thread.id);
        }, reviewBody)
      )
      .toBe(true);
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
    await testInfo.attach('screen-space-review-thread.json', {
      body: JSON.stringify(screenSpaceThreadEvidence, null, 2),
      contentType: 'application/json'
    });
    await testInfo.attach('screen-space-review-thread.png', {
      body: await window.screenshot(),
      contentType: 'image/png'
    });
    expect(screenSpaceThreadEvidence.card.width).toBeGreaterThanOrEqual(280);
    expect(screenSpaceThreadEvidence.card.width).toBeLessThanOrEqual(340);
    expect(screenSpaceThreadEvidence.artifactOverflow).toBe('visible');
    expect(screenSpaceThreadEvidence.withinCanvas).toBe(true);
    const selectedReviewPin = compiledArtboard.locator('.preview-pin').first();
    await expect(selectedReviewPin).toHaveCount(1);
    await expect(selectedReviewPin).toHaveAttribute('aria-pressed', 'true');
    await window.keyboard.press('Shift+1');
    await expect(screenSpaceThread).toHaveCount(0);
    await expect(selectedReviewPin).toHaveAttribute('aria-pressed', 'false');
    await handTool.click();
    await expect(handTool).toHaveAttribute('aria-pressed', 'true');
    await canvasTools.getByRole('button', { name: 'Selection', exact: true }).click();
    await expect(handTool).toHaveAttribute('aria-pressed', 'false');
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
    ).toBeVisible({ timeout: 15_000 });
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
    const capturePaintedPresentation = async (
      presentationViewport: 'Wide' | 'Compact',
      path: string
    ) => {
      const exit = presentation.getByRole('button', { name: /Exit/ });
      await expect(exit).toBeVisible();
      await expect(exit).toBeInViewport();
      const [artifactGeometry, exitGeometry, presentationViewportGeometry] = await Promise.all([
        presentedArtifact.evaluate((artifact) => artifact.getBoundingClientRect().toJSON()),
        exit.evaluate((control) => control.getBoundingClientRect().toJSON()),
        window.evaluate(() => ({ height: innerHeight, width: innerWidth }))
      ]);
      expect(artifactGeometry.width).toBeGreaterThanOrEqual(presentationViewportGeometry.width - 2);
      expect(artifactGeometry.height).toBeGreaterThanOrEqual(
        presentationViewportGeometry.height - 2
      );
      expect(exitGeometry.width).toBeGreaterThan(0);
      expect(exitGeometry.height).toBeGreaterThan(0);
      await testInfo.attach(
        `prototype-presentation-${presentationViewport.toLowerCase()}-exit-geometry.json`,
        {
          body: JSON.stringify(
            {
              artifact: artifactGeometry,
              exit: exitGeometry,
              viewport: presentationViewportGeometry
            },
            null,
            2
          ),
          contentType: 'application/json'
        }
      );
      let consecutiveVisibleArtifactFrames = 0;
      const frames: PresentationPaintEvidence[] = [];
      let captured: Buffer | undefined;
      await expect
        .poll(
          async () => {
            const raster = await presentedArtifact.screenshot({
              animations: 'disabled',
              caret: 'hide'
            });
            const evidence = presentationPaintEvidence(raster);
            frames.push(evidence);
            const visiblyPainted =
              evidence.nonWhitePixels >= 2_048 &&
              evidence.nonWhiteRatio >= 0.005 &&
              evidence.topLeftNonWhitePixels >= 512 &&
              evidence.paintedRows >= 48 &&
              evidence.paintedColumns >= 80 &&
              evidence.rowSpan >= 96 &&
              evidence.columnSpan >= 160;
            consecutiveVisibleArtifactFrames = visiblyPainted
              ? consecutiveVisibleArtifactFrames + 1
              : 0;
            if (consecutiveVisibleArtifactFrames >= 2) captured = raster;
            return Math.min(2, consecutiveVisibleArtifactFrames);
          },
          {
            message: `${presentationViewport} presentation must paint two visibly nonblank artifact frames before evidence capture.`,
            timeout: 5_000
          }
        )
        .toBe(2);
      if (captured === undefined)
        throw new Error(
          `${presentationViewport} presentation produced no stable screenshot evidence.`
        );
      await writeFile(path, captured);
      await testInfo.attach(
        `prototype-presentation-${presentationViewport.toLowerCase()}-paint.json`,
        {
          body: JSON.stringify(
            {
              frames,
              threshold: {
                minimumColumnSpan: 160,
                minimumNonWhitePixels: 2_048,
                minimumNonWhiteRatio: 0.005,
                minimumPaintedColumns: 80,
                minimumPaintedRows: 48,
                minimumRowSpan: 96,
                minimumTopLeftNonWhitePixels: 512
              }
            },
            null,
            2
          ),
          contentType: 'application/json'
        }
      );
    };
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
    await capturePaintedPresentation(
      'Wide',
      '../../test-results/prototype-flow-unified-present.png'
    );
    await window.setViewportSize({ width: 620, height: 760 });
    await expect(presentation).toBeVisible();
    await expect(presentedArtifact).toBeVisible();
    await expectPresentationFillsViewport('Compact');
    await expect(presentedPrototype.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
      timeout: 5_000
    });
    const compactPresentationGeometry = await Promise.all([
      presentedFrame.evaluate((frame) => {
        const bounds = frame.getBoundingClientRect();
        return {
          bounds: bounds.toJSON(),
          client: { height: frame.clientHeight, width: frame.clientWidth }
        };
      }),
      presentedPrototype.locator('html').evaluate(() => ({
        body: { height: document.body.clientHeight, width: document.body.clientWidth },
        document: {
          height: document.documentElement.clientHeight,
          width: document.documentElement.clientWidth
        },
        viewport: { height: innerHeight, width: innerWidth }
      })),
      window.evaluate(() => ({ height: innerHeight, width: innerWidth })),
      presentation
        .locator(
          '.preview-toolbar, .preview-device__chrome, .canvas-tool-palette, .preview-pin, .spatial-thread-card'
        )
        .evaluateAll((elements) =>
          elements.map((element) => ({
            className: element.getAttribute('class'),
            display: getComputedStyle(element).display,
            visibility: getComputedStyle(element).visibility
          }))
        )
    ]);
    const [compactFrameGeometry, compactInnerGeometry, compactViewport, compactAuthoringChrome] =
      compactPresentationGeometry;
    await testInfo.attach('prototype-presentation-compact-live-artifact.json', {
      body: JSON.stringify(
        {
          authoringChrome: compactAuthoringChrome,
          frame: compactFrameGeometry,
          inner: compactInnerGeometry,
          viewport: compactViewport
        },
        null,
        2
      ),
      contentType: 'application/json'
    });
    expect(compactFrameGeometry.bounds.width).toBeGreaterThanOrEqual(compactViewport.width - 2);
    expect(compactFrameGeometry.bounds.height).toBeGreaterThanOrEqual(compactViewport.height - 2);
    expect(compactFrameGeometry.client).toMatchObject({
      height: expect.any(Number),
      width: expect.any(Number)
    });
    expect(compactFrameGeometry.client.width).toBeGreaterThanOrEqual(compactViewport.width - 2);
    expect(compactFrameGeometry.client.height).toBeGreaterThanOrEqual(compactViewport.height - 2);
    expect(compactInnerGeometry.viewport.width).toBeGreaterThanOrEqual(compactViewport.width - 2);
    expect(compactInnerGeometry.viewport.height).toBeGreaterThanOrEqual(compactViewport.height - 2);
    expect(
      compactAuthoringChrome.every((entry) => entry.display === 'none'),
      'Presentation must either remove every editor toolbar/device/targeting overlay or hide it.'
    ).toBe(true);
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
    const exitPresentation = presentation.getByRole('button', { name: /Exit/ });
    await expect(exitPresentation).toBeVisible();
    await expect(exitPresentation).toBeInViewport();
    await capturePaintedPresentation(
      'Compact',
      '../../test-results/prototype-flow-unified-compact.png'
    );
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

test('persists integrated flow undo, redo, keyboard edits and pointer reconnection', async ({
  browserName: _browserName
}, testInfo) => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), 'selene-canvas-flow-history-'));
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    await window.setViewportSize({ width: 1280, height: 900 });
    await window.bringToFront();
    await window.getByLabel('Project name').fill('Flow history journey');
    await window.getByRole('button', { name: 'Create project' }).click();
    await expect
      .poll(() =>
        window.evaluate(async () => (await window.selene.designer.snapshot()).source.revision.id)
      )
      .toMatch(/^flow-history-journey-/);
    const canvas = window.getByLabel('Design canvas');
    const tools = canvas.getByRole('toolbar', { name: 'Canvas tools' });
    const undo = tools.getByRole('button', { name: 'Undo flow change', exact: true });
    const redo = tools.getByRole('button', { name: 'Redo flow change', exact: true });
    const readGraph = () =>
      window.evaluate(async () => (await window.selene.designer.snapshot()).editablePrototype);
    const before = await readGraph();
    const originalSourceRevision = await window.evaluate(
      async () => (await window.selene.designer.snapshot()).source.revision.id
    );
    const originalPosition = before.graph.nodes.find((node) => node.id === 'dashboard')?.position;
    const originalConnection = before.graph.transitions.find(
      (transition) => transition.from.nodeId === 'dashboard' && transition.kind === 'navigate'
    );
    if (!originalPosition || !originalConnection || !('to' in originalConnection))
      throw new Error('The desktop fixture must contain Dashboard navigation.');
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    const compiledArtboard = canvas.getByLabel('Compiled React artboard');
    await expect(compiledArtboard).toHaveAttribute('data-preview-state', 'ready');
    const dashboardFrame = compiledArtboard.frameLocator(
      'iframe[title="Generated React preview frame"]'
    );
    await expect(dashboardFrame.locator('html')).toHaveAttribute(
      'data-preview-revision-id',
      originalSourceRevision
    );
    await expect(
      dashboardFrame.getByRole('heading', { name: /^Dashboard(?: workspace)?$/ })
    ).toBeVisible();
    await expect(canvas).toHaveAttribute('data-mode', 'design');
    await tools.getByRole('button', { name: 'Fit all', exact: true }).click();
    const dashboard = canvas.locator('.react-flow__node[data-id="dashboard"]');
    const dragEvidence = await dragArtboard(window, dashboard, { x: 45, y: 30 }, testInfo);
    await expect
      .poll(
        async () =>
          (await readGraph()).graph.nodes.find((node) => node.id === 'dashboard')?.position,
        { message: dragEvidence }
      )
      .not.toEqual(originalPosition);
    const movedPosition = (await readGraph()).graph.nodes.find(
      (node) => node.id === 'dashboard'
    )?.position;
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect
      .poll(
        async () =>
          (await readGraph()).graph.nodes.find((node) => node.id === 'dashboard')?.position
      )
      .toEqual(originalPosition);
    await expect(redo).toBeEnabled();
    await redo.click();
    await expect
      .poll(
        async () =>
          (await readGraph()).graph.nodes.find((node) => node.id === 'dashboard')?.position
      )
      .toEqual(movedPosition);

    await tools.getByRole('button', { name: 'Connections', exact: true }).click();
    const editor = canvas.getByRole('form', { name: 'Prototype connection editor' });
    await editor.getByLabel('Connection', { exact: true }).selectOption(originalConnection.id);
    const destination = editor.getByLabel('Connection destination', { exact: true });
    const beforeInvalid = await readGraph();
    await destination.selectOption('');
    await editor.getByRole('button', { name: 'Save connection', exact: true }).click();
    await expect(editor.getByRole('alert')).toContainText(
      'Navigation needs a screen or page destination.'
    );
    expect(await readGraph()).toEqual(beforeInvalid);
    await expect(undo).toBeEnabled();
    await destination.selectOption('orders');
    await window.bringToFront();
    await destination.focus();
    await expect(destination).toBeFocused();
    await window.keyboard.press('d');
    await expect(destination).toHaveValue('dashboard');
    const saveConnection = editor.getByRole('button', { name: 'Save connection', exact: true });
    await saveConnection.focus();
    await window.keyboard.press('Enter');
    const target = async () => {
      const transition = (await readGraph()).graph.transitions.find(
        (item) => item.id === originalConnection.id
      );
      return transition && 'to' in transition ? transition.to.nodeId : undefined;
    };
    await expect.poll(target).toBe('dashboard');
    await expect(undo).toBeEnabled();
    await undo.focus();
    await window.keyboard.press('Meta+z');
    await expect.poll(target).toBe('orders');
    await expect(redo).toBeEnabled();
    await redo.focus();
    await window.keyboard.press('Meta+Shift+z');
    await expect.poll(target).toBe('dashboard');
    await editor.getByRole('button', { name: 'Close connection editor', exact: true }).click();
    await tools.getByRole('button', { name: 'Fit all', exact: true }).click();
    const edge = canvas.locator(`.react-flow__edge[data-id="${originalConnection.id}"]`);
    await edge.focus();
    await window.keyboard.press('Enter');
    await expect(edge).toHaveClass(/selected/);
    await editor.getByRole('button', { name: 'Close connection editor', exact: true }).click();
    const reconnectAnchor = edge.locator('.react-flow__edgeupdater-target');
    const ordersTarget = canvas.locator(
      '.react-flow__node[data-id="orders"] .canvas-artboard__target-handle'
    );
    await expect(reconnectAnchor).toBeVisible();
    await expect(ordersTarget).toBeVisible();
    await expect(reconnectAnchor).toBeInViewport();
    await expect(ordersTarget).toBeInViewport();
    let previousReconnectBounds: Awaited<ReturnType<typeof reconnectAnchor.boundingBox>>;
    let stableReconnectFrames = 0;
    await expect
      .poll(
        async () => {
          const bounds = await reconnectAnchor.boundingBox();
          if (!bounds) return false;
          const stable =
            previousReconnectBounds &&
            Math.abs(bounds.x - previousReconnectBounds.x) < 0.5 &&
            Math.abs(bounds.y - previousReconnectBounds.y) < 0.5;
          stableReconnectFrames = stable ? stableReconnectFrames + 1 : 0;
          previousReconnectBounds = bounds;
          return stableReconnectFrames >= 3;
        },
        { intervals: [80] }
      )
      .toBe(true);
    const reconnectBounds = await reconnectAnchor.boundingBox();
    const targetBounds = await ordersTarget.boundingBox();
    if (!reconnectBounds || !targetBounds)
      throw new Error('Connection handles need physical bounds.');
    await testInfo.attach('integrated-flow-reconnection-geometry.json', {
      body: JSON.stringify(
        await window.evaluate(
          ({ reconnectBounds: anchorRect, targetBounds: destinationRect }) =>
            [anchorRect, destinationRect].map((bounds) => {
              const hit = document.elementFromPoint(
                bounds.x + bounds.width / 2,
                bounds.y + bounds.height / 2
              );
              return { bounds, hit: hit?.outerHTML.slice(0, 500) };
            }),
          { reconnectBounds, targetBounds }
        ),
        null,
        2
      ),
      contentType: 'application/json'
    });
    await window.mouse.move(
      reconnectBounds.x + reconnectBounds.width / 2,
      reconnectBounds.y + reconnectBounds.height / 2
    );
    await window.mouse.down();
    await window.mouse.move(
      targetBounds.x + targetBounds.width / 2,
      targetBounds.y + targetBounds.height / 2,
      { steps: 8 }
    );
    await window.mouse.up();
    await expect.poll(target).toBe('orders');
    await canvas.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    const inspectConnection = window.locator('.contextual-inspector details').filter({
      has: window.locator('summary').filter({ hasText: /^Prototype connection$/ })
    });
    const inspectDestination = inspectConnection
      .locator('.review-thread-row')
      .filter({ has: window.locator('dt').filter({ hasText: /^Destination$/ }) })
      .locator('dd');
    await expect(inspectDestination).toHaveText('Orders');
    await expect(editor).toBeHidden();
    await undo.click();
    await expect.poll(target).toBe('dashboard');
    await expect(inspectDestination).toHaveText('Dashboard');
    await expect(editor).toBeHidden();
    await redo.click();
    await expect.poll(target).toBe('orders');
    await expect(inspectDestination).toHaveText('Orders');
    await expect(editor).toBeHidden();

    const connections = tools.getByRole('button', { name: 'Connections', exact: true });
    await connections.click();
    await expect(editor).toBeVisible();
    await editor.getByRole('button', { name: 'Close connection editor', exact: true }).click();
    await expect(connections).toBeFocused();
    await window.keyboard.press('Escape');
    await expect(edge).not.toHaveClass(/selected/);
    await expect(inspectConnection).toHaveCount(0);
    await edge.focus();
    await window.keyboard.press('Enter');
    await expect(edge).toHaveClass(/selected/);
    await expect(inspectDestination).toHaveText('Orders');
    await expect(editor).toBeVisible();
    await editor.getByLabel('Connection', { exact: true }).selectOption(originalConnection.id);
    await editor.getByRole('button', { name: 'Delete connection', exact: true }).click();
    await expect.poll(target).toBeUndefined();
    await undo.click();
    await expect.poll(target).toBe('orders');
    await redo.click();
    await expect.poll(target).toBeUndefined();
    await undo.click();
    await expect.poll(target).toBe('orders');
    const saved = await readGraph();
    expect(saved.revision).toBeGreaterThan(before.revision);
    expect(
      await window.evaluate(
        async () => (await window.selene.designer.snapshot()).source.revision.id
      )
    ).toBe(originalSourceRevision);
    const historyEvidence = testInfo.outputPath('integrated-flow-history.json');
    await writeFile(
      historyEvidence,
      JSON.stringify(
        { before, saved, originalSourceRevision, originalPosition, movedPosition },
        null,
        2
      )
    );
    await testInfo.attach('integrated-flow-history.json', {
      path: historyEvidence,
      contentType: 'application/json'
    });
    const wideScreenshot = testInfo.outputPath('integrated-flow-history-wide.png');
    await window.screenshot({ path: wideScreenshot });
    await testInfo.attach('integrated-flow-history-wide.png', {
      path: wideScreenshot,
      contentType: 'image/png'
    });
    await window.reload();
    await expect(canvas).toBeVisible();
    const reloaded = await readGraph();
    expect(reloaded.graph).toEqual(saved.graph);
    expect(reloaded.revision).toBe(saved.revision);
    await expect(undo).toBeDisabled();
    await expect(redo).toBeDisabled();
    await window.setViewportSize({ width: 620, height: 760 });
    await tools.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(editor).toBeVisible();
    await expect(editor).toBeInViewport();
    const compactScreenshot = testInfo.outputPath('integrated-flow-history-compact.png');
    await window.screenshot({ path: compactScreenshot });
    await testInfo.attach('integrated-flow-history-compact.png', {
      path: compactScreenshot,
      contentType: 'image/png'
    });
  } finally {
    await closeElectron(application);
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
