import { expect, test, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
    viewport: { width: 640, height: 900 },
    focus: 'ai',
    compact: true
  },
  {
    id: 'desktop-cockpit--compact-inspector-drawer-open',
    name: 'cockpit-orders-compact-open.png',
    viewport: { width: 640, height: 900 },
    focus: 'drawer',
    compact: true
  }
] as const;

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
  test(`the ${story.id} Orders cockpit visual contract is stable`, async ({ page }) => {
    await page.setViewportSize(story.viewport);
    await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${story.id}`);
    await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toBeVisible();
    await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toHaveAttribute(
      'data-selene-preview-paint-budget-ms',
      '4000'
    );
    await expect(page.locator('.preview-device')).toBeVisible();
    await expect(page.locator('.preview-frame')).toHaveAttribute(
      'src',
      new URL('fixtures/cockpit-orders-preview.html', page.url()).toString()
    );
    const ordersFrame = page.frameLocator('.preview-frame');
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

    await expect
      .poll(() =>
        page.locator('.workspace-center-stage').evaluate(() => {
          const viewport = document.querySelector('.preview-device__viewport');
          const artifact = document.querySelector('.preview-artifact-stage');
          if (!(viewport instanceof HTMLElement) || !(artifact instanceof HTMLElement))
            return false;
          const viewportBox = viewport.getBoundingClientRect();
          const artifactBox = artifact.getBoundingClientRect();
          return (
            artifactBox.left >= viewportBox.left - 1 &&
            artifactBox.right <= viewportBox.right + 1 &&
            artifactBox.top >= viewportBox.top - 1 &&
            artifactBox.bottom <= viewportBox.bottom + 1
          );
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
      const viewport = bounds('.preview-device__viewport');
      const stage = bounds('.preview-artifact-stage');
      const tools = bounds('.canvas-tool-palette');
      return {
        viewport,
        stage,
        tools,
        viewportBackground: getComputedStyle(
          layout.querySelector<HTMLElement>('.preview-device__viewport')!
        ).backgroundImage
      };
    });
    expect(geometry.tools.bottom).toBeLessThanOrEqual(geometry.viewport.top + 1);
    expect(geometry.stage.left).toBeGreaterThanOrEqual(geometry.viewport.left - 1);
    expect(geometry.stage.right).toBeLessThanOrEqual(geometry.viewport.right + 1);
    expect(geometry.stage.top).toBeGreaterThanOrEqual(geometry.viewport.top - 1);
    expect(geometry.stage.bottom).toBeLessThanOrEqual(geometry.viewport.bottom + 1);
    expect(geometry.viewportBackground).not.toContain('conic-gradient');
    const normalizedFitFill = Math.max(
      geometry.stage.width / geometry.viewport.width,
      geometry.stage.height / geometry.viewport.height
    );
    expect(normalizedFitFill).toBeGreaterThanOrEqual(0.75);
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
      const stage = document.querySelector('.preview-artifact-stage')?.getBoundingClientRect();
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
    }

    const drawer = page.locator('.workspace-inspector-drawer');
    if (story.focus === 'fit') {
      await page.getByRole('button', { name: 'Fit', exact: true }).focus();
      await expect(page.getByRole('button', { name: 'Fit', exact: true })).toBeFocused();
    }
    if (story.focus === 'ai') {
      await expect(page.locator('.conversation-rail')).toBeHidden();
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');
      await expect(page.getByRole('button', { name: 'Zoom in generated artifact' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enable direct canvas pan' })).toBeVisible();
      const operations = page.getByRole('button', { name: 'Operations', exact: true });
      await operations.focus();
      await page.keyboard.press('Enter');
      const compactOperations = page.getByRole('dialog', {
        name: 'Compact action menu',
        exact: true
      });
      await expect(compactOperations).toBeVisible();
      const proveCompactAction = async (label: string, panel: string) => {
        const trigger = compactOperations.getByRole('button', { name: label, exact: true });
        await trigger.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog', { name: panel, exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      };
      await proveCompactAction('Review & handoff', 'Review and developer handoff');
      await proveCompactAction('Publish', 'Publish generated project');
      await proveCompactAction('More', 'Workspace operations');
      await page.keyboard.press('Escape');
      await expect(operations).toBeFocused();
      await page.getByRole('button', { name: 'Open AI', exact: true }).focus();
      await expect(page.getByRole('button', { name: 'Open AI', exact: true })).toBeFocused();
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
      const close = drawer.getByRole('button', { name: 'Back to preview', exact: true });
      await close.focus();
      await expect(close).toBeFocused();
      const drawerBox = await drawer.boundingBox();
      expect(drawerBox?.width ?? 0).toBeGreaterThanOrEqual(story.viewport.width - 1);
    }

    // These are viewport-owned cockpit baselines. The initial CI run intentionally
    // records downloadable actual images; baseline approval remains a product review.
    await expect(page).toHaveScreenshot(story.name, { animations: 'disabled', caret: 'hide' });
    if (story.focus === 'fit') {
      const pointTolerance = 4;
      const assertTargetBounds = async (selector: string) => {
        const targetBounds = await page.locator(selector).evaluate((element) => {
          const target = element.getBoundingClientRect();
          const stage = document.querySelector('.preview-artifact-stage')?.getBoundingClientRect();
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
          const stage = document.querySelector('.preview-artifact-stage')?.getBoundingClientRect();
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
          const stage = document.querySelector('.preview-artifact-stage')?.getBoundingClientRect();
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
          return {
            left: Number.parseFloat(element.style.left),
            top: Number.parseFloat(element.style.top)
          };
        });
        expect(
          Math.abs(anchor.left - Math.min(72, Math.max(4, point.x * 100 + 2)))
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(anchor.top - Math.min(72, Math.max(4, point.y * 100 + 2)))
        ).toBeLessThanOrEqual(0.5);
      };
      const proveTargetMode = async (input: {
        readonly button: string;
        readonly mode: 'ai' | 'review';
        readonly cursor: 'crosshair' | 'cell';
        readonly feedback: string;
        readonly savedTarget: string;
        readonly point: { readonly x: number; readonly y: number };
      }) => {
        const tool = page.getByRole('button', { name: input.button, exact: true });
        await tool.click();
        const targetLayer = page.locator('.preview-target-layer');
        await expect(targetLayer).toBeVisible();
        await expect(targetLayer).toHaveAttribute('data-target-mode', input.mode);
        await expect(page.locator('.preview-device__mode')).toContainText(input.feedback);
        await expect(targetLayer).toHaveCSS('cursor', input.cursor);
        await assertTargetBounds('.preview-target-layer');
        const layerBox = await targetLayer.boundingBox();
        if (layerBox === null)
          throw new Error('The target layer has no visible stage-relative box.');
        await targetLayer.click({
          position: { x: layerBox.width * input.point.x, y: layerBox.height * input.point.y }
        });
        const savedTarget = page.locator(input.savedTarget);
        await expect(savedTarget).toBeVisible();
        await assertTargetBounds(input.savedTarget);
        await assertTargetMarker(input.savedTarget, input.point);
        await expect(tool).toBeFocused();
        return tool;
      };
      await proveTargetMode({
        button: 'AI edit',
        mode: 'ai',
        cursor: 'crosshair',
        feedback: 'AI target',
        savedTarget: '.preview-target--ai',
        point: { x: 0.28, y: 0.32 }
      });
      await proveTargetMode({
        button: 'Review comment',
        mode: 'review',
        cursor: 'cell',
        feedback: 'Review target',
        savedTarget: '.preview-target--review',
        point: { x: 0.63, y: 0.41 }
      });
      await page.getByRole('tab', { name: 'Reviews', exact: true }).click();
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
        name: `Select artifact pin ${reviewBody}`,
        exact: true
      });
      await expect(persistedPin).toBeVisible();
      await expect(persistedPin).toHaveAttribute('aria-pressed', 'true');
      await assertPersistedPinAnchor(persistedPin, { x: 0.63, y: 0.41 });
    }
  });
}

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
