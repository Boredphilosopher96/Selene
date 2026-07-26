import { expect, test } from '@playwright/test';
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
    id: 'desktop-cockpit--normal',
    name: 'desktop-cockpit-wide.png',
    viewport: { width: 1_440, height: 960 }
  },
  {
    id: 'desktop-cockpit--compact-inspector-drawer-closed',
    name: 'desktop-cockpit-compact-drawer-closed.png',
    viewport: { width: 820, height: 900 }
  },
  {
    id: 'desktop-cockpit--compact-inspector-drawer-open',
    name: 'desktop-cockpit-compact-drawer-open.png',
    viewport: { width: 820, height: 900 }
  }
] as const;

type Rectangle = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function right(bounds: Rectangle): number {
  return bounds.x + bounds.width;
}

function bottom(bounds: Rectangle): number {
  return bounds.y + bounds.height;
}

function expectHorizontalSeparation(left: Rectangle, rightHand: Rectangle, label: string): void {
  expect(right(left), `${label} must not overlap its next workspace region`).toBeLessThanOrEqual(
    rightHand.x + 1
  );
}

async function boundingRectangle(
  page: import('@playwright/test').Page,
  selector: string
): Promise<Rectangle> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`Expected ${selector} to have measurable geometry.`);
  return box;
}

async function expectCockpitGridHasNoOverlap(page: import('@playwright/test').Page): Promise<void> {
  const rail = await boundingRectangle(page, '.conversation-rail');
  const stage = await boundingRectangle(page, '.workspace-center-stage');
  expectHorizontalSeparation(rail, stage, 'conversation rail');
  const inspector = page.locator('.workspace-inspector-drawer');
  const layoutMode = await page.locator('.workspace-layout').getAttribute('data-layout-mode');
  if (
    layoutMode !== 'inspector-drawer' &&
    (await inspector.getAttribute('aria-hidden')) !== 'true'
  ) {
    const inspectorBox = await boundingRectangle(page, '.workspace-inspector-drawer');
    expectHorizontalSeparation(stage, inspectorBox, 'designer stage');
  }
}

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
  test(`the ${story.id} visual baseline and layout geometry are stable`, async ({ page }) => {
    await page.setViewportSize(story.viewport);
    await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${story.id}`);
    await expect(page.getByRole('main', { name: 'Fixture desktop designer' })).toBeVisible();
    await page.evaluate(async () => document.fonts.ready);
    await expectCockpitGridHasNoOverlap(page);

    const drawer = page.locator('.workspace-inspector-drawer');
    if (story.id.endsWith('--compact-inspector-drawer-closed')) {
      await expect(drawer).toHaveAttribute('aria-hidden', 'true');
      const drawerBox = await boundingRectangle(page, '.workspace-inspector-drawer');
      expect(drawerBox.x).toBeGreaterThanOrEqual(story.viewport.width);
    }
    if (story.id.endsWith('--compact-inspector-drawer-open')) {
      await expect(drawer).toHaveAttribute('role', 'dialog');
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      const drawerBox = await boundingRectangle(page, '.workspace-inspector-drawer');
      expect(drawerBox.x).toBeGreaterThanOrEqual(0);
      expect(right(drawerBox)).toBeLessThanOrEqual(story.viewport.width + 1);
      expect(bottom(drawerBox)).toBeLessThanOrEqual(story.viewport.height + 1);
      await expect(page.getByRole('button', { name: 'Close inspector' })).toBeVisible();
    }
    await expect(page.locator('#storybook-root')).toHaveScreenshot(story.name, {
      animations: 'disabled',
      caret: 'hide'
    });
  });
}

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
