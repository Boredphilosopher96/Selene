import { expect, test, type Page } from '@playwright/test';

function reviewPortal(page: Page) {
  return page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
}

async function selectSemanticArtifact(
  page: Page,
  orderId: '#1046' | '#1047' | '#1048',
  field: 'customer' | 'status' | 'total'
) {
  const element = page.locator(`[data-review-order="${orderId}"] [data-artifact-field="${field}"]`);
  await element.click();
  const actions = page.getByRole('dialog', { name: /Actions for .* review point/, exact: true });
  await expect(actions).toBeVisible();
  return { actions, element };
}

async function inspectSemanticArtifact(
  page: Page,
  orderId: '#1046' | '#1047' | '#1048',
  field: 'customer' | 'status' | 'total'
) {
  const selection = await selectSemanticArtifact(page, orderId, field);
  await selection.actions.getByRole('button', { name: 'Inspect', exact: true }).click();
  const inspection = selection.actions.getByLabel('Read-only element inspection', { exact: true });
  await expect(inspection).toBeVisible();
  return { ...selection, inspection };
}

async function expectNoSideConversationPanel(page: Page) {
  await expect(
    page.locator(
      'aside.review-aside, .review-detail-panel, .conversation-rail, [data-review-panel]'
    )
  ).toHaveCount(0);
}

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

  const portal = reviewPortal(page);
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
  const { actions, element } = await selectSemanticArtifact(page, '#1047', 'customer');
  await expect(element).toContainText('Amir Cooper');
  await actions.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(actions.getByLabel('Read-only element inspection', { exact: true })).toBeVisible();
  await actions.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: /Discussion on .* review point/, exact: true })
  ).toBeVisible();

  await portal.getByRole('button', { name: 'Flows & screens' }).click();
  await expect(portal.getByRole('heading', { name: 'Flows & screens' })).toBeVisible();
  await portal.getByRole('button', { name: 'Discussions' }).click();
  await expect(portal.getByRole('heading', { name: 'Discussions' })).toBeVisible();
});

test('keeps desktop review actions bound to their semantic artifact', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.goto('/review/prototype');

  const table = page.getByRole('table', { name: 'Orders under review' });
  const tableBox = await table.boundingBox();
  if (tableBox === null) throw new Error('Expected review portal geometry');
  expect(tableBox.y).toBeGreaterThan(120);
  await expectNoSideConversationPanel(page);

  const { actions, inspection } = await inspectSemanticArtifact(page, '#1048', 'status');
  const inspector = inspection.getByLabel('Selected element developer details', { exact: true });
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
  await test.info().attach('hosted-read-only-element-inspector', {
    body: await actions.screenshot(),
    contentType: 'image/png'
  });
  await actions.getByRole('button', { name: 'Comment', exact: true }).click();
  const discussion = page.getByRole('dialog', {
    name: /Discussion on .* review point/,
    exact: true
  });
  await discussion
    .getByLabel('Start revision-bound thread', { exact: true })
    .fill('Confirm durable local review storage.');
  await discussion.getByRole('button', { name: 'Add feedback', exact: true }).click();
  await expect(discussion).toContainText('Confirm durable local review storage.');
  await expect(discussion).toContainText(
    "Saved in this browser's durable local review store; no remote collaboration provider is configured."
  );
});

test('keeps hosted inspection legible in dark, reduced-motion, and forced-color modes', async ({
  page
}) => {
  await page.setViewportSize({ width: 1360, height: 920 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/review/prototype');
  const { actions, inspection } = await inspectSemanticArtifact(page, '#1048', 'status');
  const inspector = inspection.getByLabel('Selected element developer details', { exact: true });
  await expect(inspector).toBeVisible();
  await expect(reviewPortal(page)).toHaveCSS('color-scheme', 'dark');
  await expect(inspector).toHaveCSS('background-color', 'rgb(15, 23, 36)');
  await expect(inspector).toHaveCSS('transition-duration', '0s');
  await test.info().attach('hosted-inspector-dark-reduced-motion', {
    body: await actions.screenshot(),
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
  await expect(inspector.locator('.hosted-element-inspector__token > span')).toHaveCSS(
    'forced-color-adjust',
    'none'
  );
});

test('keeps review routes, data states, threaded identity, and handoff provenance truthful', async ({
  page
}) => {
  await page.goto('/review/prototype');
  await expectNoSideConversationPanel(page);

  await expect(page.getByRole('button', { name: 'Prototype' })).toHaveAttribute(
    'aria-current',
    'page'
  );
  const scenarios = page.getByLabel('Prototype data state');
  await scenarios.getByRole('button', { name: 'Loading scenario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Loading scenario' })).toBeVisible();
  await expectNoSideConversationPanel(page);
  await expect(page.getByLabel('Review readiness')).toContainText('Loading scenario selected');
  await expect(page.getByLabel('Orders summary')).toHaveCount(0);

  await scenarios.getByRole('button', { name: 'Empty scenario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Empty scenario' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Orders under review' })).toHaveCount(0);

  await scenarios.getByRole('button', { name: 'Unavailable scenario', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unavailable scenario' })).toBeVisible();
  await expect(page.getByLabel('Review readiness')).toContainText('Unavailable scenario selected');

  await scenarios.getByRole('button', { name: 'Ready scenario', exact: true }).click();
  await expectNoSideConversationPanel(page);
  await expect(page.getByRole('dialog', { name: /review point/i })).toHaveCount(0);

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
  const { inspection } = await inspectSemanticArtifact(page, '#1048', 'status');
  await inspection
    .getByLabel('Selected element developer details', { exact: true })
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
