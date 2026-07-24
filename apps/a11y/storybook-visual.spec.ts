import { expect, test } from '@playwright/test';

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
  { id: 'foundation-primitives--permission-denied', name: 'foundation-permission-denied.png' }
];

for (const story of stories) {
  test(`the ${story.id} visual contract is stable`, async ({ page }) => {
    await page.goto(`${harnessUrl(ports.visualStorybook)}/iframe.html?id=${story.id}`);
    await expect(
      page.getByRole('main', {
        name: story.id.includes('validation-error')
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
    await page.evaluate(async () => document.fonts.ready);
    await expect(page.locator('#storybook-root')).toHaveScreenshot(story.name, {
      animations: 'disabled',
      caret: 'hide'
    });
  });
}

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
