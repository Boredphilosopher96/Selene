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
