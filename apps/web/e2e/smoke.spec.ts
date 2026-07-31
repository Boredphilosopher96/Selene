import { expect, test } from '@playwright/test';

test('keeps the local designer workspace at the normal Vite root', async ({ page }) => {
  await page.goto('/');
  await expect(
    page.getByRole('main', { name: 'Selene designer workspace', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeVisible();
});

test('presents a hosted Orders review portal with a runnable prototype and purposeful review navigation', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.goto('/review/prototype');

  const portal = page.getByRole('main', { name: 'Northstar hosted review portal' });
  await expect(portal.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
  await test.info().attach('hosted-orders-review-portal', {
    body: await portal.screenshot(),
    contentType: 'image/png'
  });
  await expect(portal.getByRole('table', { name: 'Orders under review' })).toContainText(
    'Olivia Parker'
  );

  await portal.getByRole('button', { name: 'Needs review' }).click();
  await expect(portal.getByRole('table', { name: 'Orders under review' })).toContainText('#1048');
  await expect(portal.getByRole('table', { name: 'Orders under review' })).not.toContainText(
    '#1047'
  );
  await portal.getByRole('button', { name: 'All' }).click();
  await portal.getByRole('button', { name: 'Open #1047 review details' }).click();
  await expect(portal.locator('aside.review-aside > .review-detail-panel')).toContainText(
    'Amir Cooper'
  );

  await portal.getByRole('button', { name: 'Flows & screens' }).click();
  await expect(portal.getByRole('heading', { name: 'Flows & screens' })).toBeVisible();
  await portal.getByRole('button', { name: 'Discussions' }).click();
  await expect(portal.getByRole('heading', { name: 'Discussions' })).toBeVisible();
});

test('keeps desktop review geometry clear and exposes an honest compact details drawer', async ({
  page
}) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.goto('/review/prototype');

  const table = page.getByRole('table', { name: 'Orders under review' });
  const details = page.locator('aside.review-aside > .review-detail-panel');
  const [tableBox, detailBox] = await Promise.all([table.boundingBox(), details.boundingBox()]);
  if (!tableBox || !detailBox) throw new Error('Expected review portal geometry');
  expect(tableBox.x + tableBox.width).toBeLessThanOrEqual(detailBox.x + 1);
  expect(tableBox.y).toBeGreaterThan(120);

  await page.getByRole('button', { name: 'Inspect' }).click();
  await expect(page.getByRole('heading', { name: 'Select an element to inspect' })).toBeVisible();
  const statusField = page.locator('[data-review-order="#1048"] [data-artifact-field="status"]');
  const statusBox = await statusField.boundingBox();
  if (statusBox === null) throw new Error('Expected a reviewable Orders status field');
  await page.mouse.click(statusBox.x + statusBox.width / 2, statusBox.y + statusBox.height / 2);
  const inspector = page.getByLabel('Selected element developer details');
  await expect(inspector).toContainText('OrderStatus');
  await expect(inspector).toContainText('@northstar/ui@4.8.2');
  await expect(inspector).toContainText('status.attention');
  await expect(inspector).toContainText('src/orders-review-r18.tsx');
  await expect(inspector).toContainText('Needs review');
  await expect(inspector).toContainText('orders-r18-7f3a');
  await expect(inspector).toContainText('northstar-orders-review-r18--ready');
  await expect(inspector).toContainText('changed since baseline');
  await expect(inspector.getByRole('link', { name: 'Open exact element handoff' })).toHaveAttribute(
    'href',
    /review\/handoff\?.*revision=orders-r18-7f3a.*element=status/
  );
  await expect(page.getByRole('button', { name: 'Select', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await test.info().attach('hosted-read-only-element-inspector', {
    body: await page.locator('.review-layout').screenshot(),
    contentType: 'image/png'
  });
  const customerInspectionCell = page.locator(
    '[data-review-order="#1048"] [data-artifact-field="customer"]'
  );
  await customerInspectionCell.focus();
  await page.keyboard.press('Enter');
  await expect(inspector).toContainText('OrdersReviewRow');
  await expect(inspector).toContainText('field="customer"');
  await page.getByRole('button', { name: 'Comment' }).click();
  await page.getByRole('button', { name: 'Point', exact: true }).click();
  const customerField = page.locator(
    '[data-review-order="#1048"] [data-artifact-field="customer"]'
  );
  const customerBox = await customerField.boundingBox();
  if (customerBox === null) throw new Error('Expected a reviewable Orders customer field');
  await page.mouse.click(
    customerBox.x + customerBox.width / 2,
    customerBox.y + customerBox.height / 2
  );
  await page
    .getByLabel('Start revision-bound thread')
    .fill('Confirm durable local review storage.');
  await page.getByRole('button', { name: 'Start pinned thread', exact: true }).click();
  await expect(page.locator('.static-mode-copy')).toContainText(
    "Saved in this browser's durable local review store; no remote collaboration provider is configured."
  );

  await page.setViewportSize({ width: 620, height: 900 });
  await page.getByRole('button', { name: 'Review details', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Review details', exact: true });
  await expect(drawer).toBeVisible();
  const drawerClose = drawer.getByRole('button', { name: 'Close review details' });
  const drawerLastFocusable = drawer.getByRole('button', {
    name: 'Start pinned thread',
    exact: true
  });
  await expect(drawerClose).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(drawerLastFocusable).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(drawerClose).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Review details', exact: true })).toBeFocused();

  await page.getByRole('button', { name: 'Review details', exact: true }).click();
  await page.setViewportSize({ width: 1360, height: 920 });
  await expect(page.getByRole('dialog', { name: 'Review details', exact: true })).toHaveCount(0);
});

test('keeps hosted inspection legible in dark, reduced-motion, and forced-color modes', async ({
  page
}) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/review/prototype');
  await page.getByRole('button', { name: 'Inspect' }).click();

  const statusField = page.locator('[data-review-order="#1048"] [data-artifact-field="status"]');
  await statusField.focus();
  await page.keyboard.press('Enter');

  const inspector = page.getByLabel('Selected element developer details');
  await expect(inspector).toBeVisible();
  await expect(page.getByRole('main', { name: 'Northstar hosted review portal' })).toHaveCSS(
    'color-scheme',
    'dark'
  );
  await expect(inspector).toHaveCSS('background-color', 'rgb(15, 23, 36)');
  await expect(inspector).toHaveCSS('transition-duration', '0s');
  await test.info().attach('hosted-inspector-dark-reduced-motion', {
    body: await page.locator('.review-layout').screenshot(),
    contentType: 'image/png'
  });

  await page.emulateMedia({
    colorScheme: 'light',
    forcedColors: 'active',
    reducedMotion: 'reduce'
  });
  await expect
    .poll(() => page.evaluate(() => window.matchMedia('(forced-colors: active)').matches))
    .toBe(true);
  await expect(page.locator('.artifact-anchor-highlight')).toHaveCSS('border-top-width', '3px');
  await expect(inspector.locator('.hosted-element-inspector__token > span')).toHaveCSS(
    'forced-color-adjust',
    'none'
  );
});

test('keeps review routes, data states, threaded identity, and handoff provenance truthful', async ({
  page
}) => {
  await page.goto('/review/prototype');

  await expect(page.getByRole('button', { name: 'Prototype' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  const scenarios = page.getByLabel('Prototype data state');
  await scenarios.getByRole('button', { name: 'Loading scenario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Loading scenario' })).toBeVisible();
  await expect(page.locator('aside.review-aside > .review-detail-panel')).toContainText(
    'Choose an order to review'
  );
  await expect(page.getByLabel('Review readiness')).toContainText('Loading scenario selected');
  await expect(page.getByLabel('Orders summary')).toHaveCount(0);

  await scenarios.getByRole('button', { name: 'Empty scenario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Empty scenario' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Orders under review' })).toHaveCount(0);

  await scenarios.getByRole('button', { name: 'Unavailable scenario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unavailable scenario' })).toBeVisible();
  await expect(page.getByLabel('Review readiness')).toContainText('Unavailable scenario selected');

  await scenarios.getByRole('button', { name: 'Ready scenario', exact: true }).click();
  await expect(page.getByLabel('Discussion on selected order')).toContainText(
    'Choose a real artifact point or drag a region to bind this discussion.'
  );
  await expect(page.getByText('No threads for this pinned region.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Handoff' }).click();
  await expect(page).toHaveURL(/\/review\/handoff$/);
  const handoff = page.getByLabel('Developer handoff', { exact: true });
  await expect(
    handoff.getByRole('heading', {
      name: 'Immutable Orders React + TypeScript handoff',
      exact: true
    })
  ).toBeVisible();
  await expect(page.getByText('17 · orders-r17-b9c1')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Download self-contained r18 archive' })
  ).toBeVisible();
  await expect(handoff.getByText('Artifact ID', { exact: true })).toBeVisible();
  await expect(handoff.getByText('orders-review-7f3a-b9c1', { exact: true })).toBeVisible();
  await expect(
    handoff.getByText('sha256:45fcab29dfc3243625ffc567bcc026187d39e59ae5830d93ecb640c8a7ef32bf')
  ).toBeVisible();
});

test('carries an exact selected element from hosted inspection into developer handoff', async ({
  page
}) => {
  await page.goto('/review/prototype');
  await page.getByRole('button', { name: 'Inspect' }).click();
  const statusField = page.locator('[data-review-order="#1048"] [data-artifact-field="status"]');
  await statusField.focus();
  await page.keyboard.press('Enter');
  await page
    .getByLabel('Selected element developer details')
    .getByRole('link', { name: 'Open exact element handoff' })
    .click();

  await expect(page).toHaveURL(
    /review\/handoff\?.*revision=orders-r18-7f3a.*element=status.*story=northstar-orders-review-r18--ready/
  );
  const handoff = page.getByLabel('Developer handoff', { exact: true });
  await expect(handoff).toContainText('OrderStatus · status · Commerce Design Systems');
  await expect(handoff).toContainText('tone="semantic-status", size="compact"');
  await expect(handoff).toContainText('status.attention #9a5b08');
  await expect(handoff).toContainText('northstar-orders-review-r18--ready');
  await expect(handoff).toContainText('Keep status text visible with color.');
});

test('labels scenario controls as semantic review data without a visual baseline', async ({
  page
}) => {
  await page.goto('/review/prototype');
  const scenarios = page.getByLabel('Prototype data state');
  await expect(scenarios).toContainText('Scenario data');
  await expect(
    scenarios.getByRole('button', { name: 'Ready scenario', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(/Revision-bound review data/)).toBeVisible();
});
