import { expect, test } from '@playwright/test';

test('creates, reviews, exports, opens, and reopens a portable designer project', async ({
  page
}) => {
  await page.goto('/');
  await expect(page.getByRole('main', { name: 'Selene designer workspace' })).toBeVisible();

  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Preview state').selectOption('busy');
  await page.getByLabel('Navigate screen').selectOption('orders');
  await expect(page.getByLabel('Live React preview')).toContainText('Orders');

  await page.locator('[data-selene-node-id="orders.title"]').click();
  await expect(page.getByText('orders.title', { exact: true })).toBeVisible();
  await page.getByLabel('Comment for selected node').fill('Clarify the orders count.');
  await page.getByRole('button', { name: 'Add comment' }).click();
  await expect(page.getByText('Clarify the orders count.')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByText('You · Resolved')).toBeVisible();

  await page.getByLabel('Developer direction').fill('Keep the order row keyboard reachable.');
  await page.getByRole('button', { name: 'Add direction' }).click();
  await expect(page.getByText('Keep the order row keyboard reachable.')).toBeVisible();
  await page.getByLabel('Project status').selectOption('ready');
  await expect(
    page.getByRole('complementary', { name: 'Inspector' }).locator('.status-badge')
  ).toHaveText('ready');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('northstar.selene.json');
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Expected an exported project file');

  await page.getByLabel('Open exported project').setInputFiles(downloadPath);
  await expect(page.getByText('Opened Northstar workspace.')).toBeVisible();
  await page.getByRole('button', { name: 'Reopen saved' }).click();
  await expect(page.getByText('Reopened Northstar workspace.')).toBeVisible();
  await expect(page.getByText('Keep the order row keyboard reachable.')).toBeVisible();
  await expect(page.getByText('You · Resolved')).toBeVisible();
});
