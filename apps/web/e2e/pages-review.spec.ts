import { expect, test } from '@playwright/test';

test('deep-links a baseline change to its live semantic artifact element', async ({ page }) => {
  await page.goto('/Selene/demo/review/changes');
  const portal = page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
  const change = portal.locator('.baseline-change-list article').filter({
    hasText: 'Address confirmation'
  });

  await change.getByRole('button', { name: 'Open pinned discussion', exact: true }).click();

  await expect(page).toHaveURL(/\/Selene\/demo\/review\/prototype$/);
  await expect(
    portal.getByRole('dialog', { name: 'Discussion on OrdersReviewRow artifact pin', exact: true })
  ).toBeVisible();
  await expect(portal.locator('.artifact-selection-outline')).toBeVisible();
  await expect(portal.getByLabel('Start revision-bound thread', { exact: true })).toBeFocused();
  await expect(portal.getByRole('status')).toContainText(
    'Address confirmation is selected as a revision-bound artifact pin.'
  );
});

test('uses semantic element selection with popover Escape focus restoration', async ({ page }) => {
  await page.goto('/Selene/demo/review/prototype');
  const portal = page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
  const status = portal.locator('[data-review-order="#1046"] [data-artifact-field="status"]');

  await expect(portal.getByRole('button', { name: 'Region', exact: true })).toHaveCount(0);
  await expect(portal.getByRole('button', { name: 'Point', exact: true })).toHaveCount(0);
  await expect(portal.getByText(/Select (a )?(region|point) on the Orders artifact/i)).toHaveCount(0);

  await status.click();
  const discussion = portal.getByRole('dialog', {
    name: 'Discussion on OrderStatus artifact pin',
    exact: true
  });
  const composer = discussion.getByLabel('Start revision-bound thread', { exact: true });
  await expect(composer).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(discussion).toHaveCount(0);
  await expect(status).toBeFocused();
  await expect(portal.getByRole('status')).toContainText('Artifact pin discussion closed.');
});

test('a void artifact click cannot create a pin', async ({ page }) => {
  await page.goto('/Selene/demo/review/prototype');
  const portal = page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });

  await portal.locator('.orders-table thead').click();

  await expect(portal.getByRole('dialog', { name: /Discussion on .* artifact pin/ })).toHaveCount(0);
  await expect(portal.locator('.artifact-pin-control')).toHaveCount(0);
  await expect(portal.getByRole('status')).not.toContainText('Selected');
});
