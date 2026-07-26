import { _electron as electron, expect, test, type Locator } from '@playwright/test';
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
      resolveInitialRefresh(): void;
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

type VisualViewportEndpoint = {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly x: number;
  readonly y: number;
};

async function visualViewportEndpoint(
  locator: Locator,
  description: string
): Promise<VisualViewportEndpoint> {
  await locator.scrollIntoViewIfNeeded();
  const endpoint = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const visualViewport = window.visualViewport;
    const left = visualViewport?.offsetLeft ?? 0;
    const top = visualViewport?.offsetTop ?? 0;
    const right = left + (visualViewport?.width ?? document.documentElement.clientWidth);
    const bottom = top + (visualViewport?.height ?? document.documentElement.clientHeight);
    const visibleLeft = Math.max(left, rect.left);
    const visibleRight = Math.min(right, rect.right);
    const visibleTop = Math.max(top, rect.top);
    const visibleBottom = Math.min(bottom, rect.bottom);
    const inset = 8;
    return {
      bottom,
      left,
      right,
      top,
      x: Math.max(visibleLeft + inset, Math.min(visibleRight - inset, rect.left + rect.width / 2)),
      y: Math.max(visibleTop + inset, Math.min(visibleBottom - inset, rect.top + rect.height / 2)),
      visibleHeight: visibleBottom - visibleTop,
      visibleWidth: visibleRight - visibleLeft
    };
  });
  expect(
    endpoint.visibleWidth,
    `${description} must expose a usable visual-viewport width`
  ).toBeGreaterThanOrEqual(16);
  expect(
    endpoint.visibleHeight,
    `${description} must expose a usable visual-viewport height`
  ).toBeGreaterThanOrEqual(16);
  expect(
    endpoint.x,
    `${description} endpoint must remain inside the visual viewport`
  ).toBeGreaterThan(endpoint.left);
  expect(endpoint.x, `${description} endpoint must remain inside the visual viewport`).toBeLessThan(
    endpoint.right
  );
  expect(
    endpoint.y,
    `${description} endpoint must remain inside the visual viewport`
  ).toBeGreaterThan(endpoint.top);
  expect(endpoint.y, `${description} endpoint must remain inside the visual viewport`).toBeLessThan(
    endpoint.bottom
  );
  return endpoint;
}

function clampedViewportEndpoint(
  endpoint: VisualViewportEndpoint,
  offset: { readonly x: number; readonly y: number }
): { readonly x: number; readonly y: number } {
  const inset = 12;
  return {
    x: Math.max(endpoint.left + inset, Math.min(endpoint.right - inset, endpoint.x + offset.x)),
    y: Math.max(endpoint.top + inset, Math.min(endpoint.bottom - inset, endpoint.y + offset.y))
  };
}

test('renders truthful prototype flow interactions through the desktop callback boundary', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-prototype-flow-'));
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  let startupOutput: (() => string) | undefined;
  try {
    const launchedApplication =
      await test.step('checkpoint: launch the packaged desktop workspace', async () =>
        electron.launch({
          executablePath: await electronExecutable(),
          args: desktopArgs(userData)
        }));
    application = launchedApplication;
    startupOutput = captureStartupOutput(launchedApplication.process());
    const { flow, window } =
      await test.step('checkpoint: create a real project and open its Flow workspace', async () => {
        const page = await launchedApplication.firstWindow({ timeout: 5_000 });
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.getByLabel('Project name').fill('Prototype flow test', { timeout: 5_000 });
        await page.getByRole('button', { name: 'Create project' }).click({ timeout: 5_000 });
        await page
          .getByRole('button', { name: 'Flow', exact: true })
          .first()
          .click({ timeout: 5_000 });
        const canvas = page.getByLabel('Prototype flow canvas');
        await expect(canvas).toBeVisible({ timeout: 5_000 });
        return { flow: canvas, window: page };
      });
    let compactPersistedNodeStyles: Record<string, string> = {};
    await test.step('checkpoint: prove wide grid geometry and retain the review capture', async () => {
      const wideLayout = await flow.evaluate((element) => {
        const content = element.querySelector('.prototype-flow__content');
        const stage = element.querySelector('.prototype-flow__viewport');
        const panel = element.querySelector('.prototype-flow__side-panel');
        const plane = element.querySelector('.prototype-flow__plane');
        const overview = element.querySelector<HTMLElement>('.prototype-flow__overview');
        const overviewViewport = element.querySelector<HTMLElement>(
          '.prototype-flow__overview-viewport'
        );
        const inspector = element.querySelector<HTMLDetailsElement>('.prototype-flow__inspector');
        const toolbar = element.querySelector<HTMLElement>('.prototype-flow__actions');
        const workspace = element.closest<HTMLElement>('.workspace-layout');
        const centerStage = element.closest<HTMLElement>('.workspace-center-stage');
        if (!(
          content instanceof HTMLElement &&
          stage instanceof HTMLElement &&
          plane instanceof HTMLElement &&
          overview instanceof HTMLElement &&
          overviewViewport instanceof HTMLElement &&
          inspector instanceof HTMLDetailsElement &&
          toolbar instanceof HTMLElement &&
          workspace instanceof HTMLElement &&
          centerStage instanceof HTMLElement
        ))
          throw new Error(
            'Flow workspace must expose its full stage, visual map, inspector controls, and grouped toolbar.'
          );
        const stageRect = stage.getBoundingClientRect();
        const planeRect = plane.getBoundingClientRect();
        const flowRect = element.getBoundingClientRect();
        const overviewRect = overview.getBoundingClientRect();
        const overviewViewportRect = overviewViewport.getBoundingClientRect();
        const panelStyle = panel instanceof HTMLElement ? getComputedStyle(panel) : undefined;
        const overviewNodes = [
          ...element.querySelectorAll<HTMLElement>('.prototype-flow__overview-node')
        ];
        const labelAttachments = [
          ...element.querySelectorAll<SVGTextElement>('[data-prototype-wire-label]')
        ].map((label) => {
          const group = label.closest<SVGGElement>('[data-prototype-wire]');
          const wire = group?.querySelector<SVGPathElement>('.prototype-flow__wire');
          const tether = group?.querySelector('[data-prototype-wire-label-tether]');
          const labelRect = label.getBoundingClientRect();
          const wireRect = wire?.getBoundingClientRect();
          const horizontalGap = wireRect
            ? Math.max(wireRect.left - labelRect.right, labelRect.left - wireRect.right, 0)
            : Number.POSITIVE_INFINITY;
          const verticalGap = wireRect
            ? Math.max(wireRect.top - labelRect.bottom, labelRect.top - wireRect.bottom, 0)
            : Number.POSITIVE_INFINITY;
          return {
            attached: Boolean(tether) || Math.hypot(horizontalGap, verticalGap) <= 36,
            height: labelRect.height,
            width: labelRect.width
          };
        });
        return {
          display: getComputedStyle(content).display,
          flowWidth: flowRect.width,
          gridTemplateColumns: getComputedStyle(content).gridTemplateColumns,
          inspectorToggleExpanded: element
            .querySelector<HTMLButtonElement>('.prototype-flow__inspector-toggle')
            ?.getAttribute('aria-expanded'),
          inspectorCollapsed: !inspector.open,
          panelAriaHidden: panel?.getAttribute('aria-hidden'),
          panelDisplay: panelStyle?.display,
          panelInert: panel?.hasAttribute('inert') ?? false,
          panelHidden: panel?.hidden ?? false,
          panelPainted: panel instanceof HTMLElement ? panel.getClientRects().length > 0 : false,
          panelFocused: panel?.contains(document.activeElement) ?? false,
          fitFill: Math.max(
            planeRect.width / stage.clientWidth,
            planeRect.height / stage.clientHeight
          ),
          labelAttachments,
          overviewNodeRects: overviewNodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return { height: rect.height, width: rect.width };
          }),
          overviewViewportHeight: overviewViewportRect.height,
          overviewViewportWidth: overviewViewportRect.width,
          overviewWidth: overviewRect.width,
          workspace: {
            centerStageColumn: getComputedStyle(centerStage).gridColumnStart,
            centerStageWidth: centerStage.getBoundingClientRect().width,
            gridTemplateColumns: getComputedStyle(workspace).gridTemplateColumns,
            hiddenSiblings: [
              ...workspace.querySelectorAll<HTMLElement>(
                ':scope > .conversation-rail, :scope > .workspace-pane-resizer, :scope > .inspector'
              )
            ].map((sibling) => getComputedStyle(sibling).display),
            width: workspace.getBoundingClientRect().width
          },
          stageTop: stageRect.top,
          stageRight: stageRect.right,
          stageWidth: stageRect.width,
          toolbarGroups: toolbar.querySelectorAll('.prototype-flow__action-group').length
        };
      });
      const wideGeometryPath = test.info().outputPath('prototype-flow-wide-geometry.json');
      await writeFile(wideGeometryPath, `${JSON.stringify(wideLayout, null, 2)}\n`);
      await test.info().attach('prototype-flow-wide-geometry', {
        path: wideGeometryPath,
        contentType: 'application/json'
      });
      await flow.screenshot({ path: '../../test-results/prototype-flow-wide.png' });
      expect(wideLayout.display).toBe('grid');
      expect(wideLayout.flowWidth).toBeGreaterThanOrEqual(1024);
      expect(wideLayout.stageWidth).toBeGreaterThanOrEqual(wideLayout.flowWidth * 0.8);
      expect(wideLayout.workspace.width).toBeGreaterThanOrEqual(1024);
      expect(wideLayout.workspace.gridTemplateColumns.split(' ')).toHaveLength(1);
      expect(wideLayout.workspace.centerStageColumn).toBe('1');
      expect(wideLayout.workspace.centerStageWidth).toBeGreaterThanOrEqual(
        wideLayout.workspace.width * 0.8
      );
      expect(wideLayout.workspace.hiddenSiblings.every((display) => display === 'none')).toBe(true);
      expect(wideLayout.toolbarGroups).toBe(2);
      expect(wideLayout.inspectorCollapsed).toBe(true);
      expect(wideLayout.inspectorToggleExpanded).toBe('false');
      expect(wideLayout.panelHidden).toBe(true);
      expect(wideLayout.panelDisplay).toBe('none');
      expect(wideLayout.panelPainted).toBe(false);
      expect(wideLayout.panelFocused).toBe(false);
      expect(wideLayout.panelInert).toBe(true);
      expect(wideLayout.panelAriaHidden).toBe('true');
      expect(wideLayout.gridTemplateColumns.split(' ')).toHaveLength(1);
      expect(wideLayout.fitFill).toBeGreaterThanOrEqual(0.9);
      expect(wideLayout.labelAttachments.length).toBeGreaterThan(0);
      expect(
        wideLayout.labelAttachments.every((label) => label.width > 0 && label.height > 0)
      ).toBe(true);
      expect(wideLayout.labelAttachments.every((label) => label.attached)).toBe(true);
      expect(wideLayout.overviewNodeRects.length).toBeGreaterThanOrEqual(4);
      expect(
        wideLayout.overviewNodeRects.every((node) => node.width >= 4 && node.height >= 4)
      ).toBe(true);
      expect(wideLayout.overviewWidth).toBeGreaterThanOrEqual(120);
      expect(wideLayout.overviewViewportWidth).toBeGreaterThan(2);
      expect(wideLayout.overviewViewportHeight).toBeGreaterThan(2);
    });
    await test.step('checkpoint: toggle the editable inspector without restoring a hidden rail', async () => {
      const panel = flow.locator('.prototype-flow__side-panel');
      const toggle = flow.getByRole('button', { name: 'Show Inspector', exact: true });
      await toggle.click();
      await expect(panel).toBeVisible();
      await expect(panel).not.toHaveAttribute('aria-hidden');
      await expect(panel).not.toHaveAttribute('inert');
      await flow.getByRole('button', { name: 'Hide Inspector', exact: true }).click();
      await expect(panel).toBeHidden();
      await expect(panel).toHaveAttribute('aria-hidden', 'true');
      await expect(panel).toHaveAttribute('inert', '');
    });
    await window.setViewportSize({ width: 620, height: 760 });
    await test.step('checkpoint: prove compact grid geometry and retain the review capture', async () => {
      await expect
        .poll(() =>
          flow.locator('.prototype-flow__plane').getAttribute('data-prototype-flow-layout')
        )
        .toBe('compact-topology');
      const compactLayout = await flow.evaluate((element) => {
        const content = element.querySelector('.prototype-flow__content');
        const stage = element.querySelector('.prototype-flow__viewport');
        const panel = element.querySelector('.prototype-flow__side-panel');
        if (!(content instanceof HTMLElement && stage instanceof HTMLElement))
          throw new Error('Flow workspace must retain its stage at compact width.');
        const stageRect = stage.getBoundingClientRect();
        const dashboard = element.querySelector<HTMLElement>('[data-prototype-node="dashboard"]');
        const orders = element.querySelector<HTMLElement>('[data-prototype-node="orders"]');
        const overview = element.querySelector<HTMLElement>('.prototype-flow__overview');
        const overviewViewport = element.querySelector<HTMLElement>(
          '.prototype-flow__overview-viewport'
        );
        const overviewNodes = element.querySelectorAll('.prototype-flow__overview-node');
        const plane = element.querySelector<HTMLElement>('.prototype-flow__plane');
        const actionPorts = [...element.querySelectorAll<HTMLElement>('.prototype-flow__port')];
        const cards = [...element.querySelectorAll<HTMLElement>('[data-prototype-node]')];
        const wires = [...element.querySelectorAll<SVGGElement>('[data-prototype-wire]')];
        const semanticPort = element.querySelector<HTMLElement>(
          '[aria-label="Open orders action port"]'
        );
        if (
          !dashboard ||
          !orders ||
          !overview ||
          !overviewViewport ||
          !semanticPort ||
          !plane ||
          actionPorts.length === 0
        )
          throw new Error(
            'Compact Flow must retain its primary cards, overview map, and named action ports.'
          );
        const dashboardRect = dashboard.getBoundingClientRect();
        const ordersRect = orders.getBoundingClientRect();
        const overviewRect = overview.getBoundingClientRect();
        const overviewViewportRect = overviewViewport.getBoundingClientRect();
        const portRect = semanticPort.getBoundingClientRect();
        const portStyle = getComputedStyle(semanticPort);
        const overviewViewportStyle = getComputedStyle(overviewViewport);
        const planeRect = plane.getBoundingClientRect();
        const canvasSpace = element.querySelector<HTMLElement>('.prototype-flow__canvas-space');
        const transform = element.querySelector<HTMLElement>('.prototype-flow__transform');
        if (!canvasSpace || !transform)
          throw new Error(
            'Compact Flow must retain measurable transform and canvas-space geometry.'
          );
        const canvasSpaceRect = canvasSpace.getBoundingClientRect();
        const transformRect = transform.getBoundingClientRect();
        const scale = Number(transform?.getAttribute('style')?.match(/scale\(([^)]+)\)/)?.[1]);
        const transformStyle = transform.getAttribute('style') ?? '';
        const pan = transformStyle.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/);
        const stageStyle = getComputedStyle(stage);
        const stageClient = {
          bottom: stageRect.top + stage.clientTop + stage.clientHeight,
          left: stageRect.left + stage.clientLeft,
          right: stageRect.left + stage.clientLeft + stage.clientWidth,
          top: stageRect.top + stage.clientTop
        };
        const cardMeasurements = cards.map((card) => {
          const rect = card.getBoundingClientRect();
          return {
            bottom: rect.bottom,
            id: card.dataset.prototypeNode,
            left: rect.left,
            right: rect.right,
            top: rect.top
          };
        });
        const portMeasurements = actionPorts.map((port) => {
          const rect = port.getBoundingClientRect();
          const style = getComputedStyle(port);
          const card = port.closest<HTMLElement>('[data-prototype-node]');
          const cardRect = card?.getBoundingClientRect();
          return {
            ariaLabel: port.getAttribute('aria-label'),
            bottom: rect.bottom,
            cardBottom: cardRect?.bottom,
            cardId: card?.dataset.prototypeNode,
            cardLeft: cardRect?.left,
            cardRight: cardRect?.right,
            cardTop: cardRect?.top,
            clientHeight: port.clientHeight,
            clientWidth: port.clientWidth,
            fontSize: Number.parseFloat(style.fontSize),
            height: rect.height,
            left: rect.left,
            right: rect.right,
            scrollHeight: port.scrollHeight,
            scrollWidth: port.scrollWidth,
            text: port.textContent?.trim(),
            textOverflow: style.textOverflow,
            title: port.getAttribute('title'),
            top: rect.top,
            whiteSpace: style.whiteSpace,
            overflowWrap: style.overflowWrap,
            width: rect.width
          };
        });
        const rectanglesOverlap = (
          left: {
            readonly left: number;
            readonly right: number;
            readonly top: number;
            readonly bottom: number;
          },
          right: {
            readonly left: number;
            readonly right: number;
            readonly top: number;
            readonly bottom: number;
          }
        ) =>
          left.left < right.right &&
          left.right > right.left &&
          left.top < right.bottom &&
          left.bottom > right.top;
        const portOverlapPairs = portMeasurements.flatMap((port, index) =>
          portMeasurements
            .slice(index + 1)
            .flatMap((other) =>
              rectanglesOverlap(port, other) ? [[port.ariaLabel, other.ariaLabel]] : []
            )
        );
        const cardOverlapPairs = cardMeasurements.flatMap((card, index) =>
          cardMeasurements
            .slice(index + 1)
            .flatMap((other) => (rectanglesOverlap(card, other) ? [[card.id, other.id]] : []))
        );
        const wireEndpoints = wires.map((wire) => {
          const path = wire.querySelector<SVGPathElement>('.prototype-flow__wire');
          const sourcePort = element.querySelector<HTMLElement>(
            `[data-prototype-node="${wire.dataset.prototypeSourceNode}"] [data-prototype-port="${wire.dataset.prototypeSourcePort}"]`
          );
          const target = wire.dataset.prototypeTargetNode
            ? element.querySelector<HTMLElement>(
                `[data-prototype-node="${wire.dataset.prototypeTargetNode}"]`
              )
            : undefined;
          const matrix = path?.getScreenCTM();
          if (!path || !sourcePort || !matrix)
            throw new Error('Every compact wire must retain measurable source-port geometry.');
          const toScreen = (point: DOMPoint) => ({
            x: point.x * matrix.a + point.y * matrix.c + matrix.e,
            y: point.x * matrix.b + point.y * matrix.d + matrix.f
          });
          const start = toScreen(path.getPointAtLength(0));
          const end = toScreen(path.getPointAtLength(path.getTotalLength()));
          const sourceRect = sourcePort.getBoundingClientRect();
          const targetRect = target?.getBoundingClientRect();
          return {
            endOnTargetEdge:
              targetRect === undefined ||
              (Math.abs(end.x - targetRect.left) <= 2 &&
                end.y >= targetRect.top - 1 &&
                end.y <= targetRect.bottom + 1),
            sourceCenterDistance: Math.hypot(
              start.x - (sourceRect.left + sourceRect.width / 2),
              start.y - (sourceRect.top + sourceRect.height / 2)
            ),
            transition: wire.dataset.prototypeWire
          };
        });
        return {
          display: getComputedStyle(content).display,
          canvasSpaceBottom: canvasSpaceRect.bottom,
          canvasSpaceHeight: canvasSpaceRect.height,
          canvasSpaceRight: canvasSpaceRect.right,
          canvasSpaceWidth: canvasSpaceRect.width,
          actionPorts: portMeasurements,
          cardOverlapPairs,
          cardsWithinStage: cardMeasurements.every(
            (card) =>
              card.left >= stageClient.left &&
              card.right <= stageClient.right &&
              card.top >= stageClient.top &&
              card.bottom <= stageClient.bottom
          ),
          compactLayout: plane.dataset.prototypeFlowLayout,
          panelHidden: panel?.hidden ?? false,
          panX: Number(pan?.[1]),
          panY: Number(pan?.[2]),
          stageBottom: stageRect.bottom,
          stageBorderBottom: Number.parseFloat(stageStyle.borderBottomWidth),
          stageBorderLeft: Number.parseFloat(stageStyle.borderLeftWidth),
          stageBorderRight: Number.parseFloat(stageStyle.borderRightWidth),
          stageBorderTop: Number.parseFloat(stageStyle.borderTopWidth),
          stageClientBottom: stageClient.bottom,
          stageClientHeight: stage.clientHeight,
          stageClientLeft: stageClient.left,
          stageClientRight: stageClient.right,
          stageClientTop: stageClient.top,
          stageClientWidth: stage.clientWidth,
          stageLeft: stageRect.left,
          stageTop: stageRect.top,
          stageHeight: stageRect.height,
          stageOffsetHeight: stage.offsetHeight,
          stageOffsetWidth: stage.offsetWidth,
          stageScrollHeight: stage.scrollHeight,
          stageScrollLeft: stage.scrollLeft,
          stageScrollTop: stage.scrollTop,
          stageScrollWidth: stage.scrollWidth,
          stageWidth: stageRect.width,
          stageRight: stageRect.right,
          dashboardLeft: dashboardRect.left,
          dashboardRight: dashboardRect.right,
          dashboardWidth: dashboardRect.width,
          ordersLeft: ordersRect.left,
          ordersRight: ordersRect.right,
          planeBottom: planeRect.bottom,
          planeHeight: planeRect.height,
          planeLeft: planeRect.left,
          planeMargins: {
            bottom: stageClient.bottom - planeRect.bottom,
            left: planeRect.left - stageClient.left,
            right: stageClient.right - planeRect.right,
            top: planeRect.top - stageClient.top
          },
          planeRight: planeRect.right,
          planeTop: planeRect.top,
          planeWidth: planeRect.width,
          transformBottom: transformRect.bottom,
          transformHeight: transformRect.height,
          transformRight: transformRect.right,
          transformStyle,
          transformWidth: transformRect.width,
          overviewHeight: overviewRect.height,
          overviewNodeCount: overviewNodes.length,
          overviewViewportHeight: overviewViewportRect.height,
          overviewViewportWidth: overviewViewportRect.width,
          overviewWidth: overviewRect.width,
          overviewViewportBackground: overviewViewportStyle.backgroundImage,
          overviewViewportBorderStyle: overviewViewportStyle.borderStyle,
          portHeight: portRect.height,
          portBottom: portRect.bottom,
          portLeft: portRect.left,
          portRight: portRect.right,
          portTop: portRect.top,
          portWidth: portRect.width,
          portFontSize: Number.parseFloat(getComputedStyle(semanticPort).fontSize),
          portScrollHeight: semanticPort.scrollHeight,
          portScrollWidth: semanticPort.scrollWidth,
          portText: semanticPort.textContent,
          portTitle: semanticPort.getAttribute('title'),
          portWhiteSpace: portStyle.whiteSpace,
          portOverlapPairs,
          wireEndpoints,
          scale
        };
      });
      await test.info().attach('prototype-flow-compact-fit-geometry.json', {
        body: JSON.stringify(compactLayout, null, 2),
        contentType: 'application/json'
      });
      await test.info().attach('prototype-flow-compact-fit-before-assertion.png', {
        body: await flow.screenshot(),
        contentType: 'image/png'
      });
      expect(compactLayout.display).toBe('grid');
      expect(compactLayout.compactLayout).toBe('compact-topology');
      expect(compactLayout.stageWidth).toBeGreaterThanOrEqual(500);
      expect(compactLayout.dashboardLeft).toBeGreaterThanOrEqual(compactLayout.stageLeft);
      expect(compactLayout.dashboardRight).toBeLessThanOrEqual(compactLayout.stageRight);
      expect(compactLayout.dashboardWidth).toBeGreaterThanOrEqual(100);
      expect(compactLayout.ordersLeft).toBeGreaterThanOrEqual(compactLayout.stageLeft);
      expect(compactLayout.ordersRight).toBeLessThanOrEqual(compactLayout.stageRight);
      expect(Number.isFinite(compactLayout.scale)).toBe(true);
      expect(compactLayout.scale).toBeGreaterThan(0);
      expect(compactLayout.scale).toBeLessThanOrEqual(3);
      expect(compactLayout.planeLeft).toBeGreaterThanOrEqual(compactLayout.stageLeft);
      expect(compactLayout.planeRight).toBeLessThanOrEqual(compactLayout.stageRight);
      expect(compactLayout.planeTop).toBeGreaterThanOrEqual(compactLayout.stageTop);
      expect(compactLayout.planeBottom).toBeLessThanOrEqual(compactLayout.stageBottom);
      expect(compactLayout.planeLeft).toBeGreaterThanOrEqual(compactLayout.stageClientLeft);
      expect(compactLayout.planeRight).toBeLessThanOrEqual(compactLayout.stageClientRight);
      expect(compactLayout.planeTop).toBeGreaterThanOrEqual(compactLayout.stageClientTop);
      expect(compactLayout.planeBottom).toBeLessThanOrEqual(compactLayout.stageClientBottom);
      expect(compactLayout.canvasSpaceRight).toBeLessThanOrEqual(compactLayout.stageClientRight);
      expect(compactLayout.canvasSpaceBottom).toBeLessThanOrEqual(compactLayout.stageClientBottom);
      expect(compactLayout.stageScrollWidth).toBeLessThanOrEqual(compactLayout.stageClientWidth);
      expect(compactLayout.stageScrollHeight).toBeLessThanOrEqual(compactLayout.stageClientHeight);
      expect(compactLayout.stageScrollLeft).toBe(0);
      expect(compactLayout.stageScrollTop).toBe(0);
      expect(Number.isFinite(compactLayout.panX)).toBe(true);
      expect(Number.isFinite(compactLayout.panY)).toBe(true);
      expect(compactLayout.transformStyle).toContain('translate(');
      expect(compactLayout.transformStyle).toContain('scale(');
      if (compactLayout.scale < 1) {
        expect(
          Math.min(
            Math.abs(compactLayout.planeWidth - (compactLayout.stageClientWidth - 32)),
            Math.abs(compactLayout.planeHeight - (compactLayout.stageClientHeight - 32))
          )
        ).toBeLessThanOrEqual(4);
      } else {
        expect(
          Math.abs(compactLayout.planeMargins.left - compactLayout.planeMargins.right)
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(compactLayout.planeMargins.top - compactLayout.planeMargins.bottom)
        ).toBeLessThanOrEqual(2);
      }
      expect(compactLayout.portWidth).toBeGreaterThanOrEqual(44);
      expect(compactLayout.portHeight).toBeGreaterThanOrEqual(44);
      expect(compactLayout.portFontSize).toBeGreaterThanOrEqual(13);
      expect(compactLayout.portText).toBe('Open orders');
      expect(compactLayout.portTitle).toBe('Open orders');
      expect(compactLayout.portWhiteSpace).toBe('normal');
      expect(compactLayout.portScrollWidth).toBeLessThanOrEqual(compactLayout.portWidth);
      expect(compactLayout.portScrollHeight).toBeLessThanOrEqual(compactLayout.portHeight);
      expect(compactLayout.portLeft).toBeGreaterThanOrEqual(compactLayout.stageLeft);
      expect(compactLayout.portRight).toBeLessThanOrEqual(compactLayout.stageRight);
      expect(compactLayout.portTop).toBeGreaterThanOrEqual(compactLayout.stageTop);
      expect(compactLayout.portBottom).toBeLessThanOrEqual(compactLayout.stageBottom);
      expect(compactLayout.actionPorts.length).toBeGreaterThanOrEqual(2);
      expect(
        compactLayout.actionPorts.every(
          (port) =>
            port.ariaLabel?.endsWith(' action port') === true &&
            port.text !== undefined &&
            port.text.length > 0 &&
            port.title === port.text &&
            port.whiteSpace === 'normal' &&
            port.overflowWrap === 'anywhere' &&
            port.textOverflow === 'clip' &&
            port.width >= 44 &&
            port.height >= 44 &&
            port.fontSize >= 13 &&
            port.scrollWidth <= port.clientWidth &&
            port.scrollHeight <= port.clientHeight &&
            port.cardId !== undefined &&
            port.cardLeft !== undefined &&
            port.cardRight !== undefined &&
            port.cardTop !== undefined &&
            port.cardBottom !== undefined &&
            port.left >= port.cardLeft &&
            port.right <= port.cardRight &&
            port.top >= port.cardTop &&
            port.bottom <= port.cardBottom &&
            port.left >= compactLayout.stageClientLeft &&
            port.right <= compactLayout.stageClientRight &&
            port.top >= compactLayout.stageClientTop &&
            port.bottom <= compactLayout.stageClientBottom
        )
      ).toBe(true);
      expect(compactLayout.portOverlapPairs).toEqual([]);
      expect(compactLayout.cardOverlapPairs).toEqual([]);
      expect(compactLayout.cardsWithinStage).toBe(true);
      expect(compactLayout.wireEndpoints.length).toBeGreaterThanOrEqual(1);
      expect(
        compactLayout.wireEndpoints.every(
          (wire) => wire.sourceCenterDistance <= 2 && wire.endOnTargetEdge
        )
      ).toBe(true);
      expect(compactLayout.overviewNodeCount).toBeGreaterThanOrEqual(4);
      expect(compactLayout.overviewWidth).toBeGreaterThanOrEqual(120);
      expect(compactLayout.overviewHeight).toBeGreaterThanOrEqual(80);
      expect(compactLayout.overviewViewportWidth).toBeGreaterThan(2);
      expect(compactLayout.overviewViewportHeight).toBeGreaterThan(2);
      expect(compactLayout.overviewViewportBorderStyle).toBe('solid');
      expect(compactLayout.overviewViewportBackground).toContain('repeating-linear-gradient');
      expect(compactLayout.panelHidden).toBe(true);

      const openOrdersPort = flow.getByRole('button', { name: 'Open orders action port' });
      await openOrdersPort.hover();
      await openOrdersPort.focus();
      const hoveredAndFocusedPort = await flow.evaluate((element) => {
        const stage = element.querySelector<HTMLElement>('.prototype-flow__viewport');
        const targetPort = element.querySelector<HTMLElement>(
          '[aria-label="Open orders action port"]'
        );
        const card = targetPort?.closest<HTMLElement>('[data-prototype-node]');
        if (!stage || !targetPort || !card)
          throw new Error('Compact Flow must retain the actionable port and its owning card.');
        const stageRect = stage.getBoundingClientRect();
        const stageClient = {
          bottom: stageRect.top + stage.clientTop + stage.clientHeight,
          left: stageRect.left + stage.clientLeft,
          right: stageRect.left + stage.clientLeft + stage.clientWidth,
          top: stageRect.top + stage.clientTop
        };
        const portRect = targetPort.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        return {
          cardBottom: cardRect.bottom,
          cardLeft: cardRect.left,
          cardRight: cardRect.right,
          cardTop: cardRect.top,
          focused: document.activeElement === targetPort,
          hovered: targetPort.matches(':hover'),
          portBottom: portRect.bottom,
          portLeft: portRect.left,
          portRight: portRect.right,
          portTop: portRect.top,
          stageClient
        };
      });
      expect(hoveredAndFocusedPort.hovered).toBe(true);
      expect(hoveredAndFocusedPort.focused).toBe(true);
      expect(hoveredAndFocusedPort.portLeft).toBeGreaterThanOrEqual(hoveredAndFocusedPort.cardLeft);
      expect(hoveredAndFocusedPort.portRight).toBeLessThanOrEqual(hoveredAndFocusedPort.cardRight);
      expect(hoveredAndFocusedPort.portTop).toBeGreaterThanOrEqual(hoveredAndFocusedPort.cardTop);
      expect(hoveredAndFocusedPort.portBottom).toBeLessThanOrEqual(
        hoveredAndFocusedPort.cardBottom
      );
      expect(hoveredAndFocusedPort.portLeft).toBeGreaterThanOrEqual(
        hoveredAndFocusedPort.stageClient.left
      );
      expect(hoveredAndFocusedPort.portRight).toBeLessThanOrEqual(
        hoveredAndFocusedPort.stageClient.right
      );
      expect(hoveredAndFocusedPort.portTop).toBeGreaterThanOrEqual(
        hoveredAndFocusedPort.stageClient.top
      );
      expect(hoveredAndFocusedPort.portBottom).toBeLessThanOrEqual(
        hoveredAndFocusedPort.stageClient.bottom
      );

      await flow.getByRole('button', { name: 'Fit canvas to view' }).click();
      const explicitFit = await flow.evaluate((element) => {
        const stage = element.querySelector<HTMLElement>('.prototype-flow__viewport');
        const plane = element.querySelector<HTMLElement>('.prototype-flow__plane');
        const transform = element.querySelector<HTMLElement>('.prototype-flow__transform');
        if (stage === null || plane === null || transform === null)
          throw new Error('Explicit Fit must retain the compact stage and transformed plane.');
        const stageRect = stage.getBoundingClientRect();
        const planeRect = plane.getBoundingClientRect();
        return {
          planeBottom: planeRect.bottom,
          planeLeft: planeRect.left,
          planeRight: planeRect.right,
          planeTop: planeRect.top,
          stageClientBottom: stageRect.top + stage.clientTop + stage.clientHeight,
          stageClientLeft: stageRect.left + stage.clientLeft,
          stageClientRight: stageRect.left + stage.clientLeft + stage.clientWidth,
          stageClientTop: stageRect.top + stage.clientTop,
          stageScrollHeight: stage.scrollHeight,
          stageScrollLeft: stage.scrollLeft,
          stageScrollTop: stage.scrollTop,
          stageScrollWidth: stage.scrollWidth,
          transformStyle: transform.getAttribute('style')
        };
      });
      expect(explicitFit.transformStyle).toBe(compactLayout.transformStyle);
      expect(explicitFit.planeLeft).toBeGreaterThanOrEqual(explicitFit.stageClientLeft);
      expect(explicitFit.planeRight).toBeLessThanOrEqual(explicitFit.stageClientRight);
      expect(explicitFit.planeTop).toBeGreaterThanOrEqual(explicitFit.stageClientTop);
      expect(explicitFit.planeBottom).toBeLessThanOrEqual(explicitFit.stageClientBottom);
      expect(explicitFit.stageScrollWidth).toBeLessThanOrEqual(compactLayout.stageClientWidth);
      expect(explicitFit.stageScrollHeight).toBeLessThanOrEqual(compactLayout.stageClientHeight);
      expect(explicitFit.stageScrollLeft).toBe(0);
      expect(explicitFit.stageScrollTop).toBe(0);

      const compactDashboard = flow.getByLabel('Dashboard node', { exact: true });
      const compactDashboardBox = await compactDashboard.boundingBox();
      if (!compactDashboardBox)
        throw new Error('Compact Dashboard card must remain physically draggable.');
      const compactStart = { x: compactDashboardBox.x + 32, y: compactDashboardBox.y + 28 };
      const compactEnd = { x: compactStart.x + 6, y: compactStart.y + 6 };
      const compactInitialStyle = (await compactDashboard.getAttribute('style')) ?? '';
      await window.mouse.move(compactStart.x, compactStart.y);
      await window.mouse.down();
      await window.mouse.move(compactEnd.x, compactEnd.y);
      await window.mouse.up();
      await expect(flow.getByRole('status')).toContainText(
        'Node position and compact layout saved to the committed graph.'
      );
      await expect.poll(() => compactDashboard.getAttribute('style')).not.toBe(compactInitialStyle);
      compactPersistedNodeStyles = await flow.evaluate((element) =>
        Object.fromEntries(
          [...element.querySelectorAll<HTMLElement>('[data-prototype-node]')].map((node) => [
            node.dataset.prototypeNode ?? '',
            node.getAttribute('style') ?? ''
          ])
        )
      );
      await test.info().attach('prototype-flow-compact-durable-drag.json', {
        body: JSON.stringify(compactPersistedNodeStyles, null, 2),
        contentType: 'application/json'
      });
    });
    const viewport = flow.getByLabel('Visual prototype flow');
    await test.step('checkpoint: persist a scroll-aware node drag', async () => {
      await window.setViewportSize({ width: 1100, height: 700 });
      await expect
        .poll(() =>
          flow.locator('.prototype-flow__plane').getAttribute('data-prototype-flow-layout')
        )
        .toBe('source-positions');
      const zoomIn = flow.getByRole('button', { name: 'Zoom in' });
      const zoomReadout = flow.locator('.prototype-flow__zoom-readout');
      await flow.getByRole('button', { name: 'Fit canvas to view', exact: true }).click();
      await expect
        .poll(() =>
          flow.evaluate(async (element) => {
            const zoomState = () => {
              const readout = element.querySelector<HTMLElement>('.prototype-flow__zoom-readout');
              const transform = element.querySelector<HTMLElement>('.prototype-flow__transform');
              return {
                accessiblePercent: Number(
                  readout?.getAttribute('aria-label')?.match(/^Canvas zoom (\d+) percent$/)?.[1]
                ),
                visiblePercent: Number(readout?.textContent?.trim().match(/^(\d+)%$/)?.[1]),
                transformPercent: Math.round(
                  Number(transform?.getAttribute('style')?.match(/scale\(([^)]+)\)/)?.[1]) * 100
                )
              };
            };
            const before = zoomState();
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            );
            const after = zoomState();
            return (
              Number.isFinite(after.accessiblePercent) &&
              after.accessiblePercent === after.visiblePercent &&
              after.accessiblePercent === after.transformPercent &&
              before.accessiblePercent === after.accessiblePercent &&
              before.visiblePercent === after.visiblePercent &&
              before.transformPercent === after.transformPercent
            );
          })
        )
        .toBe(true);
      const initialZoom = await flow.evaluate((element) => {
        const readout = element.querySelector<HTMLElement>('.prototype-flow__zoom-readout');
        const transform = element.querySelector<HTMLElement>('.prototype-flow__transform');
        const accessibleName = readout?.getAttribute('aria-label');
        const accessibleMatch = accessibleName?.match(/^Canvas zoom (\d+) percent$/);
        const visibleMatch = readout?.textContent?.trim().match(/^(\d+)%$/);
        const transformMatch = transform?.getAttribute('style')?.match(/scale\(([^)]+)\)/);
        const transformScale = Number(transformMatch?.[1]);
        if (!accessibleMatch || !visibleMatch || !Number.isFinite(transformScale))
          throw new Error(
            'Flow must expose matching accessible, visible, and transformed zoom state.'
          );
        return {
          accessibleName,
          accessiblePercent: Number(accessibleMatch[1]),
          transformPercent: Math.round(transformScale * 100),
          visiblePercent: Number(visibleMatch[1])
        };
      });
      expect(initialZoom.visiblePercent).toBe(initialZoom.accessiblePercent);
      expect(initialZoom.transformPercent).toBe(initialZoom.accessiblePercent);
      const zoomTransitions: number[] = [];
      let expectedZoom = initialZoom.accessiblePercent;
      await Array.from({ length: 6 }).reduce(
        (pending) =>
          pending.then(async () => {
            expectedZoom = Math.min(300, expectedZoom + 20);
            await zoomIn.click();
            await expect(zoomReadout).toHaveAccessibleName(`Canvas zoom ${expectedZoom} percent`);
            zoomTransitions.push(expectedZoom);
          }),
        Promise.resolve()
      );
      await test.info().attach('prototype-flow-scroll-aware-zoom.json', {
        body: JSON.stringify(
          { initialZoom, finalLabel: `Canvas zoom ${expectedZoom} percent`, zoomTransitions },
          null,
          2
        ),
        contentType: 'application/json'
      });
      await expect
        .poll(() =>
          viewport.evaluate(
            (element) =>
              element.scrollWidth > element.clientWidth &&
              element.scrollHeight > element.clientHeight
          )
        )
        .toBe(true);
      await viewport.evaluate((element) => {
        element.scrollLeft = 96;
        element.scrollTop = 64;
      });
      await expect
        .poll(() => viewport.evaluate((element) => element.scrollLeft > 0 && element.scrollTop > 0))
        .toBe(true);

      const dashboard = flow.getByLabel('Dashboard node', { exact: true });
      const dashboardBox = await dashboard.boundingBox();
      if (!dashboardBox) throw new Error('Dashboard graph node must be visible to drag.');
      const start = { x: dashboardBox.x + 36, y: dashboardBox.y + 30 };
      const lastMove = { x: dashboardBox.x + 68, y: dashboardBox.y + 50 };
      const finalPointerUp = { x: dashboardBox.x + 108, y: dashboardBox.y + 76 };
      const initialPosition = await dashboard.evaluate((node) => ({
        left: Number.parseFloat(node.style.left),
        top: Number.parseFloat(node.style.top)
      }));
      const zoom = await flow.locator('.prototype-flow__transform').evaluate((element) => {
        const match = element.getAttribute('style')?.match(/scale\(([^)]+)\)/);
        return Number(match?.[1]);
      });
      if (!Number.isFinite(zoom) || zoom <= 0)
        throw new Error('Flow must expose its exact current zoom before a pointer drag.');
      const expectedFinalPosition = {
        left: initialPosition.left + Math.round((finalPointerUp.x - start.x) / zoom),
        top: initialPosition.top + Math.round((finalPointerUp.y - start.y) / zoom)
      };
      await window.mouse.move(start.x, start.y);
      await window.mouse.down();
      await window.mouse.move(lastMove.x, lastMove.y);
      await window.mouse.move(finalPointerUp.x, finalPointerUp.y);
      await window.mouse.up();
      await expect(flow.getByRole('status')).toContainText(
        'Node position and compact layout saved to the committed graph.'
      );
      await expect
        .poll(() =>
          dashboard.evaluate((node) => ({
            left: Number.parseFloat(node.style.left),
            top: Number.parseFloat(node.style.top)
          }))
        )
        .toEqual(expectedFinalPosition);
    });

    await test.step('checkpoint: cancel and commit a real connector drag', async () => {
      const port = flow.getByRole('button', { name: 'Open orders action port' });
      const portPoint = await visualViewportEndpoint(port, 'Open orders action port');
      const cancelPoint = clampedViewportEndpoint(portPoint, { x: 56, y: 84 });

      await window.mouse.move(portPoint.x, portPoint.y);
      await window.mouse.down();
      await window.mouse.move(cancelPoint.x, cancelPoint.y);
      await expect(flow.locator('.prototype-flow__wire--draft')).toHaveCount(1);
      // Native mouse input cannot produce pointercancel; exercise only the browser cancellation boundary.
      await viewport.dispatchEvent('pointercancel');
      await expect(flow.locator('.prototype-flow__wire--draft')).toHaveCount(0);
      await window.mouse.up();

      await window.mouse.move(portPoint.x, portPoint.y);
      await window.mouse.down();
      await window.mouse.move(cancelPoint.x, cancelPoint.y);
      await expect(flow.locator('.prototype-flow__wire--draft')).toHaveCount(1);
      // Likewise, this covers lost pointer capture cleanup rather than a successful user release.
      await viewport.dispatchEvent('lostpointercapture');
      await expect(flow.locator('.prototype-flow__wire--draft')).toHaveCount(0);
      await window.mouse.up();

      const reviewPort = flow.getByRole('button', { name: 'Review details action port' });
      const reviewNode = flow.getByLabel('Review details node', { exact: true });
      const reviewPortPoint = await visualViewportEndpoint(
        reviewPort,
        'Review details action port'
      );
      await window.mouse.move(reviewPortPoint.x, reviewPortPoint.y);
      await window.mouse.down();
      const reviewNodePoint = await visualViewportEndpoint(reviewNode, 'Review details node');
      await window.mouse.move(reviewNodePoint.x, reviewNodePoint.y);
      await expect(flow.locator('.prototype-flow__wire--draft')).toHaveCount(1);
      await window.mouse.up();
      await expect(flow.getByRole('status')).toContainText(
        'Connection saved to the committed graph.'
      );
    });

    await test.step('checkpoint: trap focus and delete the committed connector', async () => {
      const inspector = flow.getByLabel('Selected graph item inspector');
      const deleteEdge = inspector.getByRole('button', { name: 'Delete edge', exact: true });
      await expect(inspector).toHaveAttribute('open', '');
      await expect(deleteEdge).toBeVisible();
      await deleteEdge.click();
      const dialog = window.getByRole('alertdialog', { name: 'Delete transition?' });
      await expect(dialog).toBeVisible();
      await expect(flow.locator('.prototype-flow__modal-scrim')).toBeVisible();
      await expect(flow.locator('.prototype-flow__content')).toHaveAttribute('inert', '');
      const keep = dialog.getByRole('button', { name: 'Keep transition' });
      const confirm = dialog.getByRole('button', { name: 'Delete transition' });
      await expect(keep).toBeFocused();
      await window.keyboard.press('Tab');
      await expect(confirm).toBeFocused();
      await window.keyboard.press('Shift+Tab');
      await expect(keep).toBeFocused();
      await window.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(deleteEdge).toBeFocused();

      await deleteEdge.click();
      await dialog.getByRole('button', { name: 'Delete transition' }).click();
      await expect(dialog).toBeHidden();
      const graphEdges = flow.getByRole('group', { name: 'Graph connection edges' });
      const edgeButtons = graphEdges.getByRole('button');
      await expect(edgeButtons).toHaveCount(3);
      await Promise.all(
        [
          'dashboard.open-orders → orders (navigate) edge',
          'orders.back → history/back (back) edge',
          'review-overlay.dismiss → review-overlay (close-overlay) edge'
        ].map((name) => expect(graphEdges.getByRole('button', { name, exact: true })).toBeVisible())
      );
      await expect(
        graphEdges.getByRole('button', {
          name: 'dashboard.open-review → review-overlay (open-overlay) edge',
          exact: true
        })
      ).toHaveCount(0);
    });

    await test.step('checkpoint: run the committed production graph in Preview', async () => {
      const run = flow.getByRole('button', { name: 'Run committed graph in Preview' });
      await run.dblclick();
      await expect(window.getByText('Preview is running the committed graph.')).toBeVisible({
        timeout: 10_000
      });
      const previewFrame = window.locator('iframe[title="Generated React preview frame"]');
      const preview = window.frameLocator('iframe[title="Generated React preview frame"]');
      await expect(previewFrame).toBeVisible({ timeout: 5_000 });
      const openOrders = preview.getByRole('button', { name: 'Open orders', exact: true });
      await expect(openOrders).toBeVisible({ timeout: 5_000 });
      const actionGeometry = await openOrders.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return {
          actionPort: button.getAttribute('data-selene-action-port'),
          bounds: bounds.toJSON(),
          nodeId: button.getAttribute('data-selene-flow-node'),
          tagName: button.tagName,
          text: button.textContent?.trim()
        };
      });
      const clickTarget = await previewFrame.evaluate((frame, action) => {
        const bounds = frame.getBoundingClientRect();
        const previewViewport = frame.closest<HTMLDivElement>('.preview-device__viewport');
        const stage = frame.closest('.preview-artifact-stage');
        if (!(previewViewport instanceof HTMLDivElement) || !(stage instanceof HTMLElement)) {
          throw new Error('Generated preview frame is missing its canvas containment.');
        }
        const stageStyle = getComputedStyle(stage);
        const transform = stageStyle.transform;
        const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
        const matrixValues = matrix?.[1]?.split(',').map(Number);
        const viewportBounds = previewViewport.getBoundingClientRect();
        const center = {
          x:
            bounds.left +
            (action.bounds.x + action.bounds.width / 2) * (bounds.width / frame.clientWidth),
          y:
            bounds.top +
            (action.bounds.y + action.bounds.height / 2) * (bounds.height / frame.clientHeight)
        };
        const hitStack = document.elementsFromPoint(center.x, center.y);
        return {
          action,
          center,
          frame: {
            display: getComputedStyle(frame).display,
            height: bounds.height,
            receivesPointer: hitStack[0] === frame,
            visibility: getComputedStyle(frame).visibility,
            width: bounds.width
          },
          hitStack: hitStack.map((element) => ({
            ariaLabel: element.getAttribute('aria-label'),
            className: element.getAttribute('class'),
            tagName: element.tagName,
            title: element.getAttribute('title')
          })),
          stageTransformScaleX: matrixValues?.[0] ?? 1,
          stageTransformScaleY: matrixValues?.[3] ?? 1,
          stageZoom: stageStyle.getPropertyValue('zoom').trim(),
          withinViewport:
            center.x >= viewportBounds.left &&
            center.x <= viewportBounds.right &&
            center.y >= viewportBounds.top &&
            center.y <= viewportBounds.bottom
        };
      }, actionGeometry);
      expect(clickTarget.frame.width).toBeGreaterThan(0);
      expect(clickTarget.frame.height).toBeGreaterThan(0);
      expect(clickTarget.frame.visibility).toBe('visible');
      expect(clickTarget.frame.display).not.toBe('none');
      expect(clickTarget.frame.receivesPointer, JSON.stringify(clickTarget.hitStack, null, 2)).toBe(
        true
      );
      expect(clickTarget.stageTransformScaleX).toBe(1);
      expect(clickTarget.stageTransformScaleY).toBe(1);
      expect(Number(clickTarget.stageZoom)).toBeGreaterThan(0);
      expect(clickTarget).toMatchObject({
        action: {
          actionPort: 'open-orders',
          nodeId: 'dashboard',
          tagName: 'BUTTON',
          text: 'Open orders'
        },
        withinViewport: true
      });
      await window.mouse.click(clickTarget.center.x, clickTarget.center.y);
      await expect(preview.getByRole('heading', { name: 'Orders' })).toBeVisible({
        timeout: 5_000
      });
      await expect
        .poll(() => preview.locator('html').evaluate(() => window.location.pathname))
        .toBe('/orders');
    });

    await test.step('checkpoint: remount durable compact layout across wide and compact viewports', async () => {
      await window.setViewportSize({ width: 620, height: 760 });
      const workspace = window.locator('.workspace-layout');
      await expect(workspace).toHaveAttribute('data-layout-mode', 'inspector-drawer');
      await window.getByRole('button', { name: 'Flow', exact: true }).first().click();
      await expect(workspace).toHaveAttribute('data-center-stage', 'flow');
      const readonlyFlow = window.getByLabel('Prototype flow canvas');
      await expect(readonlyFlow).toBeVisible();
      await expect(readonlyFlow.getByLabel('Open orders action port')).toHaveCount(0);
      await expect(readonlyFlow.getByLabel('Transition editor')).toHaveCount(0);
      await expect
        .poll(() =>
          readonlyFlow.evaluate((element) => {
            const flowViewport = element.querySelector<HTMLElement>('.prototype-flow__viewport');
            const plane = element.querySelector<HTMLElement>('.prototype-flow__plane');
            return {
              layout: plane?.dataset.prototypeFlowLayout,
              viewportIsCompact:
                flowViewport !== null &&
                flowViewport.clientWidth > 0 &&
                flowViewport.clientWidth < 680
            };
          })
        )
        .toEqual({ layout: 'compact-topology', viewportIsCompact: true });
      const compactBeforeReload = await readonlyFlow.evaluate((element) => ({
        layout:
          element.querySelector<HTMLElement>('.prototype-flow__plane')?.dataset.prototypeFlowLayout,
        nodes: Object.fromEntries(
          [...element.querySelectorAll<HTMLElement>('[data-prototype-node]')].map((node) => [
            node.dataset.prototypeNode ?? '',
            node.getAttribute('style') ?? ''
          ])
        )
      }));
      expect(compactBeforeReload.nodes).not.toEqual(compactPersistedNodeStyles);

      await window.reload();
      await expect(workspace).toHaveAttribute('data-layout-mode', 'inspector-drawer');
      await window.getByRole('button', { name: 'Flow', exact: true }).first().click();
      await expect(workspace).toHaveAttribute('data-center-stage', 'flow');
      const reopenedFlow = window.getByLabel('Prototype flow canvas');
      await expect(reopenedFlow).toBeVisible();
      await window.setViewportSize({ width: 620, height: 760 });
      await expect
        .poll(() =>
          reopenedFlow.locator('.prototype-flow__plane').getAttribute('data-prototype-flow-layout')
        )
        .toBe('compact-topology');
      const remountedCompact = await reopenedFlow.evaluate((element) => {
        const port = element.querySelector<HTMLElement>('[aria-label="Open orders action port"]');
        const wire = element.querySelector<SVGGElement>('[data-prototype-wire="dashboard-orders"]');
        const path = wire?.querySelector<SVGPathElement>('.prototype-flow__wire');
        const matrix = path?.getScreenCTM();
        if (!port || !path || !matrix)
          throw new Error('Remounted compact Flow must retain physical ports and their wire.');
        const point = path.getPointAtLength(0);
        const start = {
          x: point.x * matrix.a + point.y * matrix.c + matrix.e,
          y: point.x * matrix.b + point.y * matrix.d + matrix.f
        };
        const portRect = port.getBoundingClientRect();
        const stage = element.querySelector<HTMLElement>('.prototype-flow__viewport');
        if (!stage) throw new Error('Remounted compact Flow must retain its stage.');
        return {
          layout:
            element.querySelector<HTMLElement>('.prototype-flow__plane')?.dataset
              .prototypeFlowLayout,
          nodes: Object.fromEntries(
            [...element.querySelectorAll<HTMLElement>('[data-prototype-node]')].map((node) => [
              node.dataset.prototypeNode ?? '',
              node.getAttribute('style') ?? ''
            ])
          ),
          portHeight: portRect.height,
          portWidth: portRect.width,
          sourceCenterDistance: Math.hypot(
            start.x - (portRect.left + portRect.width / 2),
            start.y - (portRect.top + portRect.height / 2)
          ),
          stageScrollHeight: stage.scrollHeight,
          stageScrollWidth: stage.scrollWidth,
          stageClientHeight: stage.clientHeight,
          stageClientWidth: stage.clientWidth
        };
      });
      expect(remountedCompact.layout).toBe(compactBeforeReload.layout);
      expect(remountedCompact.nodes).toEqual(compactBeforeReload.nodes);
      expect(remountedCompact.portWidth).toBeGreaterThanOrEqual(28);
      expect(remountedCompact.portHeight).toBeGreaterThanOrEqual(28);
      expect(remountedCompact.sourceCenterDistance).toBeLessThanOrEqual(2);
      expect(remountedCompact.stageScrollWidth).toBeLessThanOrEqual(
        remountedCompact.stageClientWidth
      );
      expect(remountedCompact.stageScrollHeight).toBeLessThanOrEqual(
        remountedCompact.stageClientHeight
      );

      await window.setViewportSize({ width: 1100, height: 700 });
      await expect
        .poll(() =>
          reopenedFlow.locator('.prototype-flow__plane').getAttribute('data-prototype-flow-layout')
        )
        .toBe('source-positions');
      await window.setViewportSize({ width: 620, height: 760 });
      await expect
        .poll(() =>
          reopenedFlow.locator('.prototype-flow__plane').getAttribute('data-prototype-flow-layout')
        )
        .toBe('compact-topology');
      const compactAfterRoundTrip = await reopenedFlow.evaluate((element) =>
        Object.fromEntries(
          [...element.querySelectorAll<HTMLElement>('[data-prototype-node]')].map((node) => [
            node.dataset.prototypeNode ?? '',
            node.getAttribute('style') ?? ''
          ])
        )
      );
      expect(compactAfterRoundTrip).toEqual(remountedCompact.nodes);
      await test.info().attach('prototype-flow-compact-remount-geometry.json', {
        body: JSON.stringify(
          { compactBeforeReload, remountedCompact, compactAfterRoundTrip },
          null,
          2
        ),
        contentType: 'application/json'
      });
    });
  } catch (error) {
    if (startupOutput) {
      try {
        await test.info().attach('desktop-startup-output.txt', {
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

test('holds injected callbacks single-flight and suppresses a stale rendered completion', async () => {
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

test('renders a maximum valid action label without clipping in the packaged Flow harness', async () => {
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
          // scroll dimensions are untransformed layout CSS pixels; compare
          // them with client geometry, and keep painted geometry separate for
          // the physical 44px target requirement.
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
