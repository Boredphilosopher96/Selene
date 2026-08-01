import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

function portal(page: Page) {
  return page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
}

async function expectWithinViewport(page: Page, popover: Locator) {
  await expect(popover).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('The compact browser has no viewport size.');
  await expect
    .poll(async () => {
      const bounds = await popover.boundingBox();
      return (
        bounds !== null &&
        bounds.x >= -1 &&
        bounds.y >= -1 &&
        bounds.x + bounds.width <= viewport.width + 1 &&
        bounds.y + bounds.height <= viewport.height + 1
      );
    })
    .toBe(true);
  await expect(popover.locator('xpath=..')).toHaveCSS('overflow', 'visible');
}

async function attachArtifactThreadScreenshot(page: Page, testInfo: TestInfo) {
  const screenshotPath = testInfo.outputPath('compact-artifact-thread.png');
  await page.screenshot({ path: screenshotPath });
  await testInfo.attach('compact-artifact-thread', {
    path: screenshotPath,
    contentType: 'image/png'
  });
}

test('keeps a semantic artifact discussion usable and unclipped at compact width', async ({
  page
}, testInfo) => {
  expect(page.viewportSize()).toMatchObject({ width: 390, height: 844 });
  await page.goto('/Selene/demo/review/prototype');
  const review = portal(page);
  const element = review.locator('[data-review-order="#1046"] [data-artifact-field="customer"]');

  await element.click();
  const actions = page.getByRole('dialog', { name: /Actions for .* artifact pin/, exact: true });
  await expectWithinViewport(page, actions);
  await actions.getByRole('button', { name: 'Comment', exact: true }).click();

  const discussion = page.getByRole('dialog', {
    name: /Discussion on .* artifact pin/,
    exact: true
  });
  const composer = discussion.getByLabel('Start revision-bound thread', { exact: true });
  await composer.fill('Compact semantic thread.');
  await discussion.getByRole('button', { name: 'Add feedback', exact: true }).click();
  await expect(discussion).toContainText('Compact semantic thread.');

  const reply = discussion.getByLabel(/Reply to thread-/);
  await reply.fill('Compact reply remains in the artifact discussion.');
  await discussion.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(discussion).toContainText('Compact reply remains in the artifact discussion.');
  await expectWithinViewport(page, discussion);
  await attachArtifactThreadScreenshot(page, testInfo);

  await discussion.getByRole('button', { name: 'Close pin discussion', exact: true }).click();
  await expect(discussion).toHaveCount(0);
  await expect(element).toBeFocused();
});
