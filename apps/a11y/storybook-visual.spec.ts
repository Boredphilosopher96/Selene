import { expect, test, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { harnessPorts, harnessUrl } from '../../scripts/playwright-harness.mjs';

const ports = harnessPorts();

const stories = [
  { id: 'foundation-primitives--default', name: 'foundation-default.png' },
  { id: 'foundation-primitives--dark-theme', name: 'foundation-dark-theme.png' },
  { id: 'foundation-primitives--high-contrast', name: 'foundation-high-contrast.png' },
  { id: 'foundation-primitives--compact-density', name: 'foundation-compact-density.png' },
  { id: 'foundation-primitives--reduced-motion', name: 'foundation-reduced-motion.png' },
  { id: 'foundation-primitives--validation-error', name: 'foundation-validation-error.png' },
  { id: 'foundation-primitives--loading-action', name: 'foundation-loading-action.png' },
  { id: 'foundation-primitives--empty-state', name: 'foundation-empty-state.png' },
  { id: 'foundation-primitives--offline-state', name: 'foundation-offline-state.png' },
  { id: 'foundation-primitives--permission-denied', name: 'foundation-permission-denied.png' },
  { id: 'foundation-workspace-primitives--states', name: 'workspace-primitives-states.png' },
  { id: 'foundation-workspace-primitives--dark', name: 'workspace-primitives-dark.png' },
  {
    id: 'foundation-workspace-primitives--high-contrast',
    name: 'workspace-primitives-high-contrast.png'
  },
  { id: 'foundation-workspace-primitives--compact', name: 'workspace-primitives-compact.png' },
  {
    id: 'foundation-workspace-primitives--reduced-motion',
    name: 'workspace-primitives-reduced-motion.png'
  },
  {
    id: 'foundation-workspace-primitives--localized-content',
    name: 'workspace-primitives-localized.png'
  },
  {
    id: 'foundation-workspace-primitives--overlays',
    name: 'workspace-primitives-overlays.png'
  },
  {
    id: 'foundation-workspace-primitives--modal',
    name: 'workspace-primitives-modal.png'
  }
];

const cockpitStories = [
  {
    id: 'desktop-cockpit--fitted-artifact',
    name: 'cockpit-orders-wide.png',
    viewport: { width: 1440, height: 960 },
    focus: 'fit',
    compact: false
  },
  {
    id: 'desktop-cockpit--compact-inspector-drawer-closed',
    name: 'cockpit-orders-compact-closed.png',
    viewport: { width: 820, height: 900 },
    focus: 'ai',
    compact: true
  },
  {
    id: 'desktop-cockpit--compact-inspector-drawer-open',
    name: 'cockpit-orders-compact-open.png',
    viewport: { width: 820, height: 900 },
    focus: 'drawer',
    compact: true
  }
] as const;

// Storybook's development server compiles the heavyweight cockpit module only
// when the first cockpit story is requested. Keep this harness-only discovery
// allowance separate from the product's asserted 4-second artifact paint budget.
const coldCockpitStoryDiscoveryTimeoutMs = 20_000;

for (const story of stories) {
  test(`the ${story.id} visual contract is stable`, async ({ page }) => {
    await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${story.id}`);
    await expect(
      page.getByRole('main', {
        name: story.id.includes('workspace-primitives')
          ? story.id.endsWith('--overlays')
            ? 'Workspace overlay showcase'
            : story.id.endsWith('--modal')
              ? 'Workspace modal showcase'
              : 'Workspace primitive showcase'
          : story.id.includes('validation-error')
            ? 'Selene UI validation error'
            : story.id.includes('loading-action')
              ? 'Selene UI loading action'
              : story.id.includes('empty-state')
                ? 'Selene UI empty state'
                : story.id.includes('offline-state')
                  ? 'Selene UI offline state'
                  : story.id.includes('permission-denied')
                    ? 'Selene UI permission state'
                    : 'Selene UI foundation'
      })
    ).toBeVisible();
    if (story.id.endsWith('--overlays')) {
      const overlays = page.locator('.sl-popover__content');
      await expect(overlays).toHaveCount(2);
      await expect(page.locator('[data-overlay-portal-host="true"]')).toHaveCount(1);
      await expect
        .poll(() =>
          overlays.evaluateAll((elements) =>
            elements.every((element) => element.style.getPropertyValue('--sl-popover-top') !== '')
          )
        )
        .toBe(true);
    }
    if (story.id.endsWith('--modal'))
      await expect(page.getByRole('dialog', { name: 'Modal lifecycle proof' })).toBeVisible();
    await page.evaluate(async () => document.fonts.ready);
    const target =
      story.id.endsWith('--overlays') || story.id.endsWith('--modal')
        ? page.locator('body')
        : page.locator('#storybook-root');
    await expect(target).toHaveScreenshot(story.name, {
      animations: 'disabled',
      caret: 'hide'
    });
  });
}

for (const story of cockpitStories) {
  test(`the ${story.id} Orders cockpit visual contract is stable`, async ({ page }, testInfo) => {
    await page.setViewportSize(story.viewport);
    await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${story.id}`);
    // The first cockpit story is intentionally the cold Storybook module load: React Flow and the
    // compiled-artifact fixture are both part of the production canvas contract. Keep the semantic
    // landmark assertion, but give that real product surface a bounded startup window.
    const designerWorkspace = page.getByRole('main', { name: 'Fixture desktop designer' });
    await expect(designerWorkspace).toBeVisible({
      timeout: coldCockpitStoryDiscoveryTimeoutMs
    });
    await expect(designerWorkspace).toHaveAttribute('data-selene-preview-paint-budget-ms', '4000');
    const canvas = page.getByLabel('Design canvas');
    const artboard = canvas.getByLabel('Compiled React artboard');
    await expect(canvas).toBeVisible();
    await expect(artboard).toBeVisible();
    await expect(artboard.locator('.preview-frame')).toHaveAttribute(
      'src',
      new URL('fixtures/cockpit-orders-preview.html', page.url()).toString()
    );
    const ordersFrame = artboard.frameLocator('.preview-frame');
    await expect(ordersFrame.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
    await expect(ordersFrame.locator('main[data-selene-preview-paint="ready"]')).toBeVisible();
    await expect
      .poll(() =>
        ordersFrame.locator('main[data-selene-preview-paint="ready"]').evaluate((artifact) => {
          const bounds = artifact.getBoundingClientRect();
          const style = getComputedStyle(artifact);
          const heading = artifact.querySelector('h1');
          const rows = artifact.querySelectorAll('.row');
          const color = style.backgroundColor.match(
            /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/
          );
          const channels = color === null ? [] : color.slice(1).map(Number);
          const [red, green, blue, alpha = 1] = channels;
          const linear = (channel: number) => {
            const normalized = channel / 255;
            return normalized <= 0.04045
              ? normalized / 12.92
              : ((normalized + 0.055) / 1.055) ** 2.4;
          };
          const lightness =
            red === undefined || green === undefined || blue === undefined || alpha < 0.98
              ? undefined
              : 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
          return (
            bounds.width >= 320 &&
            bounds.height >= 320 &&
            style.visibility === 'visible' &&
            Number.parseFloat(style.opacity) >= 0.98 &&
            lightness !== undefined &&
            lightness >= 0.5 &&
            heading?.textContent?.trim() === 'Orders' &&
            heading.getClientRects().length > 0 &&
            rows.length === 3 &&
            Array.from(rows).every((row) => row.getClientRects().length > 0) &&
            artifact.textContent?.includes('Northwind Atelier') === true &&
            artifact.textContent?.includes('SO-1048') === true &&
            artifact.querySelector<HTMLButtonElement>('button.new')?.textContent?.trim() ===
              'New order'
          );
        })
      )
      .toBe(true);
    // The outer readiness handshake must inspect iframe content through the
    // artifact's own Window, rather than Storybook's global CSSOM realm.
    await expect
      .poll(() =>
        page.locator('.preview-frame').evaluate((frame) => {
          if (!(frame instanceof HTMLIFrameElement)) return false;
          const artifact = frame.contentDocument?.querySelector<HTMLElement>(
            'main[data-selene-preview-paint="ready"]'
          );
          const ownerView = artifact?.ownerDocument.defaultView;
          if (artifact === undefined || artifact === null || ownerView === null) return false;
          try {
            return (
              frame.contentWindow === ownerView &&
              ownerView.getComputedStyle(artifact).visibility === 'visible'
            );
          } catch {
            return false;
          }
        })
      )
      .toBe(true);
    await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toHaveAttribute(
      'data-selene-preview-paint',
      'ready'
    );
    await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toHaveAttribute(
      'data-selene-preview-paint-reason',
      'ready'
    );
    await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toHaveAttribute(
      'data-selene-preview-paint-subreason',
      'ready'
    );
    await page.evaluate(async () => document.fonts.ready);

    if (!story.compact) {
      const preAssertionGeometry = await page.locator('.workspace-layout').evaluate((layout) => {
        const rail = layout.querySelector<HTMLElement>('.conversation-rail');
        const history = layout.querySelector<HTMLElement>('.conversation-history');
        const composer = layout.querySelector<HTMLElement>('.conversation-composer');
        if (rail === null || history === null || composer === null)
          throw new Error('Wide pre-assertion evidence requires the rendered AI rail.');
        const bounds = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height };
        };
        return {
          layout: bounds(layout),
          rail: bounds(rail),
          history: bounds(history),
          composer: bounds(composer),
          railClientHeight: rail.clientHeight,
          railScrollHeight: rail.scrollHeight,
          historyOverflowY: getComputedStyle(history).overflowY,
          composerOverflowY: getComputedStyle(composer).overflowY
        };
      });
      await writeFile(
        testInfo.outputPath('cockpit-orders-wide-pre-assertion-geometry.json'),
        `${JSON.stringify(preAssertionGeometry, null, 2)}\n`
      );
      await page.screenshot({
        path: testInfo.outputPath('cockpit-orders-wide-pre-assertion.png'),
        animations: 'disabled',
        caret: 'hide'
      });
    }

    await expect
      .poll(() =>
        page.locator('.workspace-center-stage').evaluate(() => {
          const viewport = document.querySelector('.canvas-workspace');
          const artifact = document.querySelector('.preview-artifact-content');
          if (!(viewport instanceof HTMLElement) || !(artifact instanceof HTMLElement))
            return false;
          const viewportBox = viewport.getBoundingClientRect();
          const artifactBox = artifact.getBoundingClientRect();
          const visibleWidth =
            Math.min(artifactBox.right, viewportBox.right) -
            Math.max(artifactBox.left, viewportBox.left);
          const visibleHeight =
            Math.min(artifactBox.bottom, viewportBox.bottom) -
            Math.max(artifactBox.top, viewportBox.top);
          return visibleWidth > 0 && visibleHeight > 0;
        })
      )
      .toBe(true);

    const geometry = await page.locator('.workspace-layout').evaluate((layout) => {
      const bounds = (selector: string) => {
        const element = layout.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing cockpit element ${selector}.`);
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        };
      };
      const viewport = bounds('.canvas-workspace');
      const stage = bounds('.preview-artifact-content');
      const tools = bounds('.canvas-workspace__toolbar');
      return {
        viewport,
        stage,
        tools,
        scrollbars: {
          inspector: getComputedStyle(layout.querySelector<HTMLElement>('.inspector')!)
            .scrollbarGutter,
          previewViewport: getComputedStyle(layout.querySelector<HTMLElement>('.canvas-workspace')!)
            .scrollbarGutter
        },
        viewportBackground: getComputedStyle(
          layout.querySelector<HTMLElement>('.canvas-workspace')!
        ).backgroundImage
      };
    });
    expect(geometry.tools.left).toBeGreaterThanOrEqual(geometry.viewport.left - 1);
    expect(geometry.tools.right).toBeLessThanOrEqual(geometry.viewport.right + 1);
    expect(geometry.tools.top).toBeGreaterThanOrEqual(geometry.viewport.top - 1);
    expect(geometry.tools.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1);
    expect(geometry.stage.right).toBeGreaterThan(geometry.viewport.left);
    expect(geometry.stage.left).toBeLessThan(geometry.viewport.right);
    expect(geometry.stage.bottom).toBeGreaterThan(geometry.viewport.top);
    expect(geometry.stage.top).toBeLessThan(geometry.viewport.bottom);
    expect(geometry.viewportBackground).not.toContain('conic-gradient');
    const normalizedFitFill = Math.max(
      geometry.stage.width / geometry.viewport.width,
      geometry.stage.height / geometry.viewport.height
    );
    expect(normalizedFitFill).toBeGreaterThanOrEqual(0.75);
    const conversationRailLocator = page.locator('.conversation-rail');
    const conversationHistory = page.getByRole('region', { name: 'AI conversation history' });
    if (story.compact) {
      await expect(conversationRailLocator).toBeHidden();
      await expect(conversationHistory).toBeHidden();
    } else {
      await expect(conversationRailLocator).toBeVisible();
      await expect(conversationHistory).toHaveAttribute('tabindex', '0');
      await conversationHistory.focus();
      await expect(conversationHistory).toBeFocused();
      await expect(conversationHistory).toHaveCSS('outline-style', 'solid');
      await expect(conversationHistory).toHaveCSS('outline-width', '2px');
      const railAllocation = await page.locator('.conversation-rail__body').evaluate((body) => {
        const rail = body.closest<HTMLElement>('.conversation-rail');
        const layout = body.closest<HTMLElement>('.workspace-layout');
        const history = body.querySelector<HTMLElement>('.conversation-history');
        const composer = body.querySelector<HTMLElement>('.conversation-composer');
        if (layout === null || rail === null || history === null || composer === null)
          throw new Error('Missing conversation rail allocation targets.');
        const bounds = (element: HTMLElement) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, height: rect.height };
        };
        return {
          layout: bounds(layout),
          rail: bounds(rail),
          body: bounds(body),
          history: bounds(history),
          composer: bounds(composer),
          railClientHeight: rail.clientHeight,
          railScrollHeight: rail.scrollHeight,
          historyOverflowY: getComputedStyle(history).overflowY,
          composerOverflowY: getComputedStyle(composer).overflowY
        };
      });
      expect(railAllocation.railScrollHeight).toBeLessThanOrEqual(
        railAllocation.railClientHeight + 1
      );
      expect(railAllocation.rail.top).toBeGreaterThanOrEqual(railAllocation.layout.top);
      expect(railAllocation.rail.bottom).toBeLessThanOrEqual(railAllocation.layout.bottom);
      expect(railAllocation.body.top).toBeGreaterThanOrEqual(railAllocation.rail.top);
      expect(railAllocation.body.bottom).toBeLessThanOrEqual(railAllocation.rail.bottom);
      expect(railAllocation.history.top).toBeGreaterThanOrEqual(railAllocation.body.top);
      expect(railAllocation.history.bottom).toBeLessThanOrEqual(railAllocation.composer.top);
      expect(railAllocation.composer.bottom).toBeLessThanOrEqual(railAllocation.body.bottom);
      // Equal 1fr tracks can differ only by fractional CSS-pixel layout rounding.
      expect(
        Math.abs(railAllocation.history.height - railAllocation.composer.height)
      ).toBeLessThanOrEqual(0.5);
      expect(railAllocation.historyOverflowY).toBe('auto');
      expect(railAllocation.composerOverflowY).toBe('auto');
    }
    const ordersHeadingBox = await ordersFrame
      .getByRole('heading', { name: 'Orders', exact: true })
      .boundingBox();
    expect(ordersHeadingBox?.height ?? 0).toBeGreaterThanOrEqual(story.compact ? 12 : 18);
    const namedPin = page.locator('.preview-pin').first();
    await expect(namedPin).toHaveAccessibleName(/Select artifact pin/);
    await expect(namedPin).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const namedPinMarker = namedPin.locator('[aria-hidden="true"]');
    await expect(namedPinMarker).toHaveCSS('pointer-events', 'none');
    const namedPinGeometry = await namedPin.evaluate((element) => {
      if (!(element instanceof HTMLElement))
        throw new Error('Artifact pin is not an HTML element.');
      const pin = element.getBoundingClientRect();
      const marker = element
        .querySelector<HTMLElement>('[aria-hidden="true"]')
        ?.getBoundingClientRect();
      const stage = document.querySelector('.preview-artifact-content')?.getBoundingClientRect();
      if (stage === undefined || marker === undefined)
        throw new Error('Missing preview artifact pin geometry.');
      return {
        pin,
        marker,
        stage,
        x: Number.parseFloat(element.style.left) / 100,
        y: Number.parseFloat(element.style.top) / 100
      };
    });
    expect(namedPinGeometry.pin.width).toBeGreaterThanOrEqual(30);
    expect(namedPinGeometry.pin.width).toBeLessThanOrEqual(36);
    expect(namedPinGeometry.pin.height).toBeGreaterThanOrEqual(30);
    expect(namedPinGeometry.pin.height).toBeLessThanOrEqual(36);
    expect(namedPinGeometry.marker.width).toBeGreaterThanOrEqual(5.5);
    expect(namedPinGeometry.marker.width).toBeLessThanOrEqual(6.5);
    expect(namedPinGeometry.marker.height).toBeGreaterThanOrEqual(5.5);
    expect(namedPinGeometry.marker.height).toBeLessThanOrEqual(6.5);
    expect(
      Math.abs(
        namedPinGeometry.pin.left +
          namedPinGeometry.pin.width / 2 -
          (namedPinGeometry.stage.left + namedPinGeometry.stage.width * namedPinGeometry.x)
      )
    ).toBeLessThanOrEqual(4);
    expect(
      Math.abs(
        namedPinGeometry.pin.top +
          namedPinGeometry.pin.height / 2 -
          (namedPinGeometry.stage.top + namedPinGeometry.stage.height * namedPinGeometry.y)
      )
    ).toBeLessThanOrEqual(4);
    if (story.compact) {
      expect(geometry.viewport.height).toBeGreaterThanOrEqual(360);
      expect(geometry.scrollbars.inspector).toBe('stable');
      expect(geometry.scrollbars.previewViewport).toBe('auto');
    }

    const drawer = page.locator('.workspace-inspector-drawer');
    if (story.focus === 'fit') {
      const designMode = page.getByRole('button', { name: 'Design', exact: true });
      await designMode.focus();
      await expect(designMode).toBeFocused();
    }
    if (story.focus === 'ai') {
      await expect(conversationRailLocator).toBeHidden();
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');
      await expect(page.getByRole('toolbar', { name: 'Canvas tools' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Open AI conversation', exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Open Dev Inspect', exact: true })
      ).toBeVisible();
      const operations = page.getByRole('button', { name: 'Operations', exact: true });
      await expect(operations).toBeHidden();
      const proveToolbarAction = async (label: string, panel: string) => {
        const trigger = page
          .locator('.workspace-toolbar > .sl-popover')
          .getByRole('button', { name: label, exact: true });
        await expect(trigger).toBeVisible();
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog', { name: panel, exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      };
      await proveToolbarAction('Review & handoff', 'Review and developer handoff');
      await proveToolbarAction('Publish', 'Publish generated project');
      await proveToolbarAction('More', 'Workspace operations');
      await page.getByRole('button', { name: 'Open AI conversation', exact: true }).focus();
      await expect(
        page.getByRole('button', { name: 'Open AI conversation', exact: true })
      ).toBeFocused();
    }
    if (story.focus === 'drawer') {
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(drawer).toHaveAttribute('aria-label', 'Compact inspector workspace');
      const compiledScenarioTitle = await ordersFrame
        .getByRole('heading', { name: 'Orders', exact: true })
        .textContent();
      if (compiledScenarioTitle === null)
        throw new Error('The compiled Orders preview did not expose a scenario title.');
      await expect(
        drawer
          .locator('.workspace-inspector-drawer__header')
          .getByRole('heading', { name: compiledScenarioTitle.trim(), exact: true })
      ).toBeVisible();
      const close = drawer.getByRole('button', { name: 'Back to canvas', exact: true });
      await close.focus();
      await expect(close).toBeFocused();
      const drawerBox = await drawer.boundingBox();
      expect(drawerBox?.width ?? 0).toBeGreaterThanOrEqual(story.viewport.width - 1);
    }

    if (!story.compact) {
      const evidencePath = testInfo.outputPath('cockpit-orders-wide-compositor-evidence.json');
      const compositorEvidence: unknown[] = [];
      const recordWideEvidence = async (label: string) => {
        const evidence = await page.locator('.preview-frame').evaluate((frame, captureLabel) => {
          if (!(frame instanceof HTMLIFrameElement)) throw new Error('Missing preview frame.');
          const workspace = document.querySelector<HTMLElement>('.designer-workspace');
          const topbar = document.querySelector<HTMLElement>('.workspace-topbar');
          const layout = document.querySelector<HTMLElement>('.workspace-layout');
          const conversationRail = document.querySelector<HTMLElement>('.conversation-rail');
          const historyElement = document.querySelector<HTMLElement>('.conversation-history');
          const composerElement = document.querySelector<HTMLElement>('.conversation-composer');
          const inspector = document.querySelector<HTMLElement>('.inspector');
          const viewport = document.querySelector<HTMLElement>('.canvas-workspace');
          const flowPlane = document.querySelector<HTMLElement>('.react-flow__viewport');
          const stage = document.querySelector<HTMLElement>('.preview-artifact-content');
          const main = frame.contentDocument?.querySelector<HTMLElement>(
            'main[data-selene-preview-paint="ready"]'
          );
          const frameView = frame.contentWindow;
          if (
            workspace === null ||
            topbar === null ||
            layout === null ||
            conversationRail === null ||
            historyElement === null ||
            composerElement === null ||
            inspector === null ||
            viewport === null ||
            flowPlane === null ||
            stage === null ||
            main === null ||
            frameView === null
          )
            throw new Error(
              'Wide compositor evidence requires the workspace, stage, frame, and Orders main.'
            );
          const boxGeometry = (element: Element) => {
            const box = element.getBoundingClientRect();
            return {
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
              top: box.top,
              right: box.right,
              bottom: box.bottom,
              left: box.left
            };
          };
          const styles = (element: Element, view: Window) => {
            const style = view.getComputedStyle(element);
            return {
              opacity: style.opacity,
              visibility: style.visibility,
              display: style.display,
              contentVisibility: style.contentVisibility,
              filter: style.filter,
              transform: style.transform,
              zIndex: style.zIndex,
              background: style.background,
              backgroundColor: style.backgroundColor,
              overflowY: style.overflowY
            };
          };
          return {
            capture: captureLabel,
            page: {
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              viewportWidth: window.innerWidth,
              viewportHeight: window.innerHeight
            },
            viewportScroll: {
              scrollLeft: viewport.scrollLeft,
              scrollTop: viewport.scrollTop
            },
            readiness: {
              workspacePaint: workspace?.dataset.selenePreviewPaint,
              workspaceReason: workspace?.dataset.selenePreviewPaintReason,
              workspaceSubreason: workspace?.dataset.selenePreviewPaintSubreason,
              frameDocumentReadyState: frame.contentDocument?.readyState,
              artifactPaint: main.dataset.selenePreviewPaint
            },
            geometry: {
              workspace: boxGeometry(workspace),
              topbar: boxGeometry(topbar),
              layout: boxGeometry(layout),
              conversationRail: boxGeometry(conversationRail),
              conversationHistory: boxGeometry(historyElement),
              conversationComposer: boxGeometry(composerElement),
              inspector: boxGeometry(inspector),
              viewport: boxGeometry(viewport),
              canvas: boxGeometry(flowPlane),
              stage: boxGeometry(stage),
              frame: boxGeometry(frame),
              main: boxGeometry(main)
            },
            styles: {
              stage: styles(stage, window),
              frame: styles(frame, window),
              main: styles(main, frameView),
              conversationRail: styles(conversationRail, window),
              conversationHistory: styles(historyElement, window),
              conversationComposer: styles(composerElement, window),
              inspector: styles(inspector, window)
            }
          };
        }, label);
        compositorEvidence.push(evidence);
        await writeFile(evidencePath, `${JSON.stringify(compositorEvidence, null, 2)}\n`);
        return evidence;
      };

      const initialEvidence = await recordWideEvidence('before outer screenshot');
      await page.screenshot({
        path: testInfo.outputPath('cockpit-orders-wide-outer.png'),
        animations: 'disabled',
        caret: 'hide'
      });
      await recordWideEvidence('after outer screenshot');
      expect(initialEvidence.page.scrollX).toBe(0);
      expect(initialEvidence.page.scrollY).toBe(0);
      expect(initialEvidence.geometry.workspace.top).toBeGreaterThanOrEqual(0);
      expect(initialEvidence.geometry.workspace.bottom).toBeLessThanOrEqual(
        initialEvidence.page.viewportHeight
      );
      expect(initialEvidence.geometry.topbar.top).toBeGreaterThanOrEqual(0);
      expect(initialEvidence.geometry.topbar.bottom).toBeLessThanOrEqual(
        initialEvidence.page.viewportHeight
      );
      expect(initialEvidence.geometry.layout.top).toBeGreaterThanOrEqual(
        initialEvidence.geometry.topbar.bottom
      );
      expect(initialEvidence.geometry.layout.bottom).toBeLessThanOrEqual(
        initialEvidence.geometry.workspace.bottom
      );
      expect(initialEvidence.geometry.conversationRail.top).toBeGreaterThanOrEqual(
        initialEvidence.geometry.layout.top
      );
      expect(initialEvidence.geometry.conversationRail.bottom).toBeLessThanOrEqual(
        initialEvidence.geometry.layout.bottom
      );
      expect(initialEvidence.styles.conversationRail.overflowY).toBe('clip');
      expect(initialEvidence.styles.conversationHistory.overflowY).toBe('auto');
      expect(initialEvidence.styles.conversationComposer.overflowY).toBe('auto');
      expect(initialEvidence.styles.inspector.overflowY).toBe('auto');
      expect(initialEvidence.geometry.stage.top).toBeGreaterThanOrEqual(0);
      expect(initialEvidence.geometry.stage.bottom).toBeLessThanOrEqual(
        initialEvidence.page.viewportHeight
      );

      // The canonical page capture must remain the initial, unscrolled workspace;
      // locator screenshots below intentionally scroll their targets into view.
      await recordWideEvidence('before canonical screenshot');
      await expect(page).toHaveScreenshot(story.name, { animations: 'disabled', caret: 'hide' });
      await recordWideEvidence('after canonical screenshot');

      await recordWideEvidence('before iframe element screenshot');
      await page.locator('.preview-frame').screenshot({
        path: testInfo.outputPath('cockpit-orders-wide-iframe-element.png'),
        animations: 'disabled',
        caret: 'hide'
      });
      await recordWideEvidence('after iframe element screenshot');

      await recordWideEvidence('before iframe content screenshot');
      await ordersFrame.locator('main[data-selene-preview-paint="ready"]').screenshot({
        path: testInfo.outputPath('cockpit-orders-wide-iframe-content.png'),
        animations: 'disabled',
        caret: 'hide'
      });
      await recordWideEvidence('after iframe content screenshot');
      await testInfo.attach('cockpit-orders-wide-compositor-evidence', {
        path: evidencePath,
        contentType: 'application/json'
      });
    } else {
      // These are viewport-owned cockpit baselines. The initial CI run intentionally
      // records downloadable actual images; baseline approval remains a product review.
      await expect(page).toHaveScreenshot(story.name, { animations: 'disabled', caret: 'hide' });
    }
    if (story.focus === 'fit') {
      const pointTolerance = 4;
      const assertTargetBounds = async (selector: string) => {
        const targetBounds = await page.locator(selector).evaluate((element) => {
          const target = element.getBoundingClientRect();
          const stage = document
            .querySelector('.preview-artifact-content')
            ?.getBoundingClientRect();
          if (stage === undefined) throw new Error('Missing preview artifact stage.');
          return { target, stage };
        });
        expect(targetBounds.target.width).toBeGreaterThan(0);
        expect(targetBounds.target.height).toBeGreaterThan(0);
        expect(targetBounds.target.left).toBeGreaterThanOrEqual(targetBounds.stage.left - 1);
        expect(targetBounds.target.right).toBeLessThanOrEqual(targetBounds.stage.right + 1);
        expect(targetBounds.target.top).toBeGreaterThanOrEqual(targetBounds.stage.top - 1);
        expect(targetBounds.target.bottom).toBeLessThanOrEqual(targetBounds.stage.bottom + 1);
      };
      const assertTargetMarker = async (
        selector: string,
        point: { readonly x: number; readonly y: number }
      ) => {
        const markerGeometry = await page.locator(selector).evaluate((element) => {
          if (!(element instanceof HTMLElement))
            throw new Error('Target marker is not an HTML element.');
          const marker = element.getBoundingClientRect();
          const stage = document
            .querySelector('.preview-artifact-content')
            ?.getBoundingClientRect();
          if (stage === undefined) throw new Error('Missing preview artifact stage.');
          return {
            marker,
            stage,
            left: Number.parseFloat(element.style.left),
            top: Number.parseFloat(element.style.top)
          };
        });
        expect(Math.abs(markerGeometry.left - point.x * 100)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(markerGeometry.top - point.y * 100)).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(
            markerGeometry.marker.left -
              (markerGeometry.stage.left + markerGeometry.stage.width * point.x)
          )
        ).toBeLessThanOrEqual(pointTolerance);
        expect(
          Math.abs(
            markerGeometry.marker.top -
              (markerGeometry.stage.top + markerGeometry.stage.height * point.y)
          )
        ).toBeLessThanOrEqual(pointTolerance);
        expect(
          Math.abs(markerGeometry.marker.width - markerGeometry.stage.width * 0.02)
        ).toBeLessThanOrEqual(pointTolerance);
        expect(
          Math.abs(markerGeometry.marker.height - markerGeometry.stage.height * 0.02)
        ).toBeLessThanOrEqual(pointTolerance);
      };
      const assertPersistedPinAnchor = async (
        pin: Locator,
        point: { readonly x: number; readonly y: number }
      ) => {
        const pinGeometry = await pin.evaluate((element) => {
          if (!(element instanceof HTMLElement))
            throw new Error('Persisted review pin is not an HTML element.');
          const marker = element.getBoundingClientRect();
          const stage = document
            .querySelector('.preview-artifact-content')
            ?.getBoundingClientRect();
          if (stage === undefined) throw new Error('Missing preview artifact stage.');
          return {
            marker,
            stage,
            left: Number.parseFloat(element.style.left),
            top: Number.parseFloat(element.style.top)
          };
        });
        expect(Math.abs(pinGeometry.left - point.x * 100)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(pinGeometry.top - point.y * 100)).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(
            pinGeometry.marker.left +
              pinGeometry.marker.width / 2 -
              (pinGeometry.stage.left + pinGeometry.stage.width * point.x)
          )
        ).toBeLessThanOrEqual(pointTolerance);
        expect(
          Math.abs(
            pinGeometry.marker.top +
              pinGeometry.marker.height / 2 -
              (pinGeometry.stage.top + pinGeometry.stage.height * point.y)
          )
        ).toBeLessThanOrEqual(pointTolerance);
      };
      const assertPersistedThreadAnchor = async (
        thread: Locator,
        point: { readonly x: number; readonly y: number }
      ) => {
        const anchor = await thread.evaluate((element) => {
          if (!(element instanceof HTMLElement))
            throw new Error('Persisted review thread is not an HTML element.');
          const toolbar = element.closest<HTMLElement>('.artifact-conversation-toolbar');
          return {
            horizontal: toolbar?.dataset.reviewAnchorHorizontal ?? 'none',
            vertical: toolbar?.dataset.reviewAnchorVertical ?? 'none'
          };
        });
        expect(anchor.horizontal).toBe(point.x > 0.56 ? 'right' : 'left');
        expect(anchor.vertical).toBe(point.y > 0.52 ? 'bottom' : 'top');
      };
      const selectArtifactArea = async (input: {
        readonly point: { readonly x: number; readonly y: number };
      }) => {
        const targetLayer = page.locator('.preview-target-layer');
        await expect(targetLayer).toBeVisible();
        await expect(targetLayer).toHaveCSS('cursor', 'crosshair');
        await assertTargetBounds('.preview-target-layer');
        const layerBox = await targetLayer.boundingBox();
        if (layerBox === null)
          throw new Error('The target layer has no visible stage-relative box.');
        await page.mouse.click(
          layerBox.x + layerBox.width * input.point.x,
          layerBox.y + layerBox.height * input.point.y
        );
        const marker = page.locator('.artifact-selection-marker');
        await expect(marker).toBeVisible();
        await assertTargetBounds('.artifact-selection-marker');
        await assertTargetMarker('.artifact-selection-marker', input.point);
        await expect(
          page.getByRole('toolbar', { name: 'Selected artifact actions' })
        ).toBeVisible();
      };
      await page
        .getByLabel('Targeted change actions')
        .getByRole('button', { name: 'Select on canvas', exact: true })
        .click();
      await selectArtifactArea({ point: { x: 0.28, y: 0.32 } });
      await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
      await expect(page.locator('.preview-target--ai')).toBeVisible();
      await assertTargetBounds('.preview-target--ai');
      await assertTargetMarker('.preview-target--ai', { x: 0.28, y: 0.32 });
      await page
        .getByLabel('Targeted change actions')
        .getByRole('button', { name: 'Clear target', exact: true })
        .click();
      await page.getByRole('tab', { name: 'Reviews', exact: true }).click();
      await page
        .getByLabel('Review actions')
        .getByRole('button', { name: 'Select on canvas', exact: true })
        .click();
      await selectArtifactArea({ point: { x: 0.63, y: 0.41 } });
      await page.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(page.locator('.preview-target--review')).toBeVisible();
      await assertTargetBounds('.preview-target--review');
      await assertTargetMarker('.preview-target--review', { x: 0.63, y: 0.41 });
      await expect(
        page.getByRole('textbox', {
          name: 'Stakeholder review thread body',
          exact: true
        })
      ).toBeFocused();
      const reviewBody = 'Persist this stage-relative stakeholder coordinate.';
      await page
        .getByRole('textbox', { name: 'Stakeholder review thread body', exact: true })
        .fill(reviewBody);
      const submitReview = page.getByRole('button', {
        name: 'Start stakeholder thread',
        exact: true
      });
      await expect(submitReview).toBeEnabled();
      await submitReview.click();
      const persistedThread = page.locator('.review-thread-row').filter({ hasText: reviewBody });
      await expect(persistedThread).toBeVisible();
      await expect(persistedThread).toHaveAttribute('aria-pressed', 'true');
      const persistedThreadCard = page.getByRole('dialog', {
        name: 'Review thread from Fixture reviewer',
        exact: true
      });
      await expect(persistedThreadCard).toContainText(reviewBody);
      await assertPersistedThreadAnchor(persistedThreadCard, { x: 0.63, y: 0.41 });
      const persistedPin = page.getByRole('button', {
        name: `Select artifact pin marker: ${reviewBody}`,
        exact: true
      });
      await expect(persistedPin).toBeVisible();
      await expect(persistedPin).toHaveAttribute('aria-pressed', 'true');
      await assertPersistedPinAnchor(persistedPin, { x: 0.63, y: 0.41 });
    }
  });
}

test('catalog drag intent never invents a React insertion target', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=desktop-cockpit--fitted-artifact`
  );
  await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toBeVisible({
    timeout: coldCockpitStoryDiscoveryTimeoutMs
  });
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page
    .getByRole('group', { name: 'Canvas library', exact: true })
    .getByRole('button', { name: 'Assets', exact: true })
    .click();
  const assets = page.locator('.canvas-workspace__assets');
  const projectComponent = assets.locator('li[data-catalog-component="OrderTotal"]');
  const libraryComponent = assets.locator('li[data-catalog-component="Button"]');
  const pattern = assets.locator('li[data-catalog-pattern="primary-action"]');
  await expect(projectComponent).toHaveAttribute('draggable', 'false');
  await expect(libraryComponent).toHaveAttribute('draggable', 'true');
  await expect(pattern).toHaveAttribute('draggable', 'true');
  await expect(pattern).toContainText('The standard action for completing a task.');
  await expect(pattern.locator('.canvas-workspace__asset-origin')).toHaveText('Pattern');

  await libraryComponent
    .locator('.canvas-workspace__asset-icon')
    .dragTo(page.locator('.canvas-artboard--active'));

  await expect(assets.getByRole('status')).toHaveText(
    'Select a source-backed flex or grid container before dropping Button.'
  );
  await expect(page.locator('.canvas-artboard__catalog-drop')).toHaveCount(0);
});

test('component inventory is a dedicated workspace, not the product prototype', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=desktop-cockpit--fitted-artifact`
  );
  const workspace = page.getByRole('main', { name: 'Fixture desktop designer' });
  await expect(workspace).toBeVisible({ timeout: coldCockpitStoryDiscoveryTimeoutMs });
  await page.getByRole('button', { name: 'Components', exact: true }).click();

  const explorer = page.getByRole('region', {
    name: 'Component and Storybook explorer',
    exact: true
  });
  await expect(explorer).toBeVisible();
  await expect(explorer.getByRole('heading', { name: 'Components', exact: true })).toBeVisible();
  await expect(page.locator('.react-flow')).toBeHidden();
  const teamComponent = explorer.getByRole('button', {
    name: /OrderStatus.*Team component/
  });
  await expect(teamComponent).toBeVisible();
  await teamComponent.click();
  await expect(explorer.getByRole('button', { name: 'Reference only' })).toBeDisabled();
  await expect(explorer.getByRole('list', { name: 'OrderStatus canonical stories' })).toContainText(
    'order-status--needs-review'
  );
  await explorer.getByRole('button', { name: /Button.*Library component/ }).click();
  await expect(explorer.getByRole('heading', { name: 'Button', exact: true })).toBeVisible();
  await expect(explorer).toContainText('Validated catalog · build storybook-r1');
  await expect(explorer).toContainText('Default is validated');
  await expect(explorer.getByRole('tab', { name: 'Disabled', exact: true })).toBeVisible();
  await expect(explorer).toContainText('@selene/ui@1.0.0');
  await expect(explorer.getByRole('heading', { name: 'Used in product' })).toBeVisible();
  await expect(explorer.getByRole('list', { name: 'Button screen usage' })).toContainText(
    '/checkout'
  );
  await expect(explorer).toHaveScreenshot('component-explorer-wide.png', {
    animations: 'disabled',
    caret: 'hide'
  });

  await explorer.getByRole('button', { name: 'Use in design', exact: true }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  const assets = page.locator('.canvas-workspace__assets');
  await expect(assets.getByRole('searchbox', { name: 'Search components' })).toHaveValue('Button');
  await expect(assets.locator('li[data-catalog-component="Button"]')).toBeVisible();
});

test('catalog replacement is available only for the exact source-backed selection', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=desktop-cockpit--inspect-selected-node`
  );
  await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toBeVisible({
    timeout: coldCockpitStoryDiscoveryTimeoutMs
  });
  const componentProperties = page.getByRole('region', {
    name: 'Design-system component properties'
  });
  await expect(componentProperties).toContainText('@selene/ui@1.0.0');
  const selectedInspectorGeometry = await page
    .locator('.workspace-layout')
    .evaluate((workspace) => {
      const bounds = (selector: string) => {
        const element = workspace.querySelector<HTMLElement>(selector);
        if (element === null) throw new Error(`Missing selected inspector element ${selector}.`);
        return element.getBoundingClientRect().toJSON();
      };
      return {
        canvas: bounds('.workspace-center-stage'),
        inspector: bounds('.inspector'),
        selectionDetails: bounds('[aria-label="Selection developer details"]')
      };
    });
  expect(selectedInspectorGeometry.canvas.right).toBeLessThanOrEqual(
    selectedInspectorGeometry.inspector.left + 1
  );
  expect(selectedInspectorGeometry.selectionDetails.left).toBeGreaterThanOrEqual(
    selectedInspectorGeometry.inspector.left - 1
  );
  expect(selectedInspectorGeometry.selectionDetails.right).toBeLessThanOrEqual(
    selectedInspectorGeometry.inspector.right + 1
  );
  await componentProperties.getByRole('combobox', { name: 'Tone' }).selectOption('primary');
  await componentProperties.getByRole('button', { name: 'Apply Tone' }).click();
  await expect(componentProperties.getByRole('status')).toHaveText(
    'Component property was not updated: FIXTURE_REJECTION.'
  );
  const appearance = page.getByRole('region', { name: 'Manual React appearance edit' });
  await appearance
    .getByRole('combobox', { name: 'Design token for Fill' })
    .selectOption('fixture-token-action-primary');
  await appearance.getByRole('button', { name: 'Apply backgroundColor' }).click();
  await expect(appearance.getByRole('status')).toHaveText(
    'Appearance was not updated: MANUAL_EDIT_UNAVAILABLE.'
  );
  await page.getByRole('button', { name: 'Pages', exact: true }).click();
  await page
    .getByRole('group', { name: 'Canvas library', exact: true })
    .getByRole('button', { name: 'Assets', exact: true })
    .click();
  const assets = page.locator('.canvas-workspace__assets');
  const libraryComponent = assets.locator('li[data-catalog-component="Button"]');
  const replace = libraryComponent.getByRole('button', {
    name: 'Replace the selected React element with Button',
    exact: true
  });
  await expect(replace).toBeEnabled();
  await replace.click();
  await expect(assets.getByRole('status')).toHaveText(
    'Component was not replaced. Refresh the selection and try again.'
  );
});

test('the cockpit exposes the first strict preview subreason without relaxing readiness', async ({
  page
}) => {
  await page.setViewportSize({ width: 1_440, height: 960 });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=desktop-cockpit--invalid-artifact-heading`
  );
  const workspace = page.getByRole('main', { name: 'Fixture desktop designer' });
  const ordersFrame = page.frameLocator('.preview-frame');
  await expect(
    ordersFrame.getByRole('heading', { name: 'Order queue', exact: true })
  ).toBeVisible();
  await expect(workspace).toHaveAttribute('data-selene-preview-paint', 'unavailable');
  await expect(workspace).toHaveAttribute('data-selene-preview-paint-reason', 'artifact-timeout');
  await expect(workspace).toHaveAttribute('data-selene-preview-paint-subreason', 'heading-text');
});

test('the cockpit communicates bounded loading and recoverable graph states in place', async ({
  page
}) => {
  await page.setViewportSize({ width: 1_440, height: 960 });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=desktop-cockpit--loading-preview`
  );
  const workspace = page.getByRole('main', { name: 'Fixture desktop designer' });
  await expect(workspace).toBeVisible({ timeout: coldCockpitStoryDiscoveryTimeoutMs });
  await expect(workspace).toHaveAttribute('data-selene-preview-paint', 'loading');
  await expect(workspace).toHaveAttribute('data-selene-preview-paint-reason', 'build-loading');
  await expect(page.locator('.preview-frame--loading')).toHaveText('Preparing the secure preview…');

  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=desktop-cockpit--recovery-required`
  );
  await expect(workspace).toHaveAttribute('data-selene-preview-paint', 'ready');
  const recovery = page.getByRole('alert').filter({ hasText: 'Recover the saved graph' });
  await expect(recovery).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Retry saved graph' })).toBeVisible();
  await expect(recovery.getByRole('button', { name: 'Recover from fixture' })).toBeVisible();
  const [canvas, inspector, recoveryBounds] = await Promise.all([
    page.locator('.workspace-center-stage').boundingBox(),
    page.locator('.inspector').boundingBox(),
    recovery.boundingBox()
  ]);
  if (canvas === null || inspector === null || recoveryBounds === null)
    throw new Error('Recovery layout must expose stable canvas and inspector geometry.');
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(inspector.x + 1);
  expect(recoveryBounds.x).toBeGreaterThanOrEqual(inspector.x - 1);
  expect(recoveryBounds.x + recoveryBounds.width).toBeLessThanOrEqual(
    inspector.x + inspector.width + 1
  );
});

test('the cockpit applies dark, high-contrast, and reduced-motion contracts to real tools', async ({
  page
}) => {
  await page.setViewportSize({ width: 1_440, height: 960 });
  const storyUrl = (story: string) =>
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=desktop-cockpit--${story}`;
  await page.goto(storyUrl('fitted-artifact'));
  const workspace = page.getByRole('main', { name: 'Fixture desktop designer' });
  await expect(workspace).toHaveAttribute('data-selene-preview-paint', 'ready', {
    timeout: coldCockpitStoryDiscoveryTimeoutMs
  });
  const canvas = page.locator('.canvas-workspace');
  const toolbar = page.locator('.canvas-workspace__toolbar');
  const designTool = toolbar.getByRole('button', { name: 'Design', exact: true });
  const defaultCanvasBackground = await canvas.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );

  await page.goto(storyUrl('dark'));
  await expect(workspace).toHaveAttribute('data-theme', 'dark');
  await expect(workspace).toHaveAttribute('data-selene-preview-paint', 'ready');
  const darkCanvasBackground = await canvas.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  expect(darkCanvasBackground).not.toBe(defaultCanvasBackground);

  await page.goto(storyUrl('high-contrast'));
  await expect(workspace).toHaveAttribute('data-contrast', 'more');
  await expect(workspace).toHaveAttribute('data-selene-preview-paint', 'ready');
  await expect(canvas).toHaveCSS('border-top-width', '2px');
  await expect(designTool).toHaveCSS('border-top-width', '2px');
  await expect(designTool).toHaveCSS('border-top-style', 'solid');

  await page.goto(storyUrl('reduced-motion'));
  await expect(workspace).toHaveAttribute('data-motion', 'reduce');
  await expect(workspace).toHaveAttribute('data-selene-preview-paint', 'ready');
  await expect(page.locator('.workspace-pane-resizer').first()).toHaveCSS(
    'transition-duration',
    '0s'
  );
});

test('every reviewed workspace story has both Darwin and Linux baselines', async () => {
  const workspaceStories = stories.filter((story) => story.id.includes('workspace-primitives'));
  await Promise.all(
    ['darwin', 'linux'].flatMap((platform) =>
      workspaceStories.map((story) =>
        expect(
          readFile(
            join(
              process.cwd(),
              'apps/a11y/storybook-visual.spec.ts-snapshots',
              platform,
              story.name
            )
          )
        ).resolves.toBeInstanceOf(Buffer)
      )
    )
  );
});

test('the compact foundation density is stable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=foundation-primitives--compact-density`
  );
  await expect(page.getByRole('main', { name: 'Selene UI foundation' })).toBeVisible();
  await page.evaluate(async () => document.fonts.ready);
  await expect(page.locator('#storybook-root')).toHaveScreenshot(
    'foundation-compact-density-narrow.png',
    {
      animations: 'disabled',
      caret: 'hide'
    }
  );
});

test('workspace dark tokens and reviewed baseline bytes differ from the light state', async ({
  page
}) => {
  const stateId = 'foundation-workspace-primitives--states';
  const darkId = 'foundation-workspace-primitives--dark';
  await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${stateId}`);
  const lightSurface = await page
    .locator('.sl-toolbar')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${darkId}`);
  const darkSurface = await page
    .locator('.sl-toolbar')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(darkSurface).not.toBe(lightSurface);
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const snapshots = join(process.cwd(), 'apps/a11y/storybook-visual.spec.ts-snapshots', platform);
  const hash = async (name: string) =>
    createHash('sha256')
      .update(await readFile(join(snapshots, name)))
      .digest('hex');
  expect(await hash('workspace-primitives-dark.png')).not.toBe(
    await hash('workspace-primitives-states.png')
  );
});

test('workspace primitives remain usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=foundation-workspace-primitives--localized-content`
  );
  await expect(page.getByRole('main', { name: 'Workspace primitive showcase' })).toBeVisible();
  await page.evaluate(async () => document.fonts.ready);
  await expect(page.locator('#storybook-root')).toHaveScreenshot(
    'workspace-primitives-localized-narrow.png',
    { animations: 'disabled', caret: 'hide' }
  );
});

test('workspace interaction states have deliberate hover, focus, and selected baselines', async ({
  page
}) => {
  const storyId = 'foundation-workspace-primitives--interaction';
  await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${storyId}`);
  await expect(page.getByRole('main', { name: 'Workspace primitive interactions' })).toBeVisible();
  await page.getByRole('button', { name: 'Share workspace' }).hover();
  await expect(page.locator('#storybook-root')).toHaveScreenshot('workspace-primitives-hover.png', {
    animations: 'disabled',
    caret: 'hide'
  });
  await page.getByRole('button', { name: 'Canvas help' }).focus();
  await expect(page.locator('#storybook-root')).toHaveScreenshot('workspace-primitives-focus.png', {
    animations: 'disabled',
    caret: 'hide'
  });
  await page.getByRole('tab', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Prototype', exact: true }).click();
  await expect(page.locator('#storybook-root')).toHaveScreenshot(
    'workspace-primitives-selected.png',
    { animations: 'disabled', caret: 'hide' }
  );
});

test('the forced-colors token set is visually stable', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(
    `${harnessUrl(ports.visualStorybook)}/iframe.html?id=foundation-primitives--default`
  );
  await expect(page.getByRole('main', { name: 'Selene UI foundation' })).toBeVisible();
  await page.evaluate(async () => document.fonts.ready);
  await expect(page.locator('#storybook-root')).toHaveScreenshot('foundation-forced-colors.png', {
    animations: 'disabled',
    caret: 'hide'
  });
});
