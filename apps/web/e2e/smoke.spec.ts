import { expect, test } from '@playwright/test';

type Bounds = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function right(box: Bounds): number {
  return box.x + box.width;
}

function bottom(box: Bounds): number {
  return box.y + box.height;
}

async function bounds(page: import('@playwright/test').Page, selector: string): Promise<Bounds> {
  const box = await page.locator(selector).boundingBox();
  if (box === null)
    throw new Error(`Expected ${selector} to have measurable deployed layout bounds.`);
  return box;
}

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

test('wires a connector and runs the compiled React prototype with deterministic history and state', async ({
  page
}) => {
  await page.goto('/');
  const studio = page.getByLabel('Prototype editor and runtime');
  const canvas = studio.getByLabel('Prototype flow canvas');
  const runtime = studio.getByLabel('Compiled React prototype');

  await runtime.getByLabel('Start scenario').selectOption('orders-empty');
  await expect(runtime.getByText('No orders match this filter.')).toBeVisible();
  await runtime.getByLabel('Start scenario').selectOption('orders-default');

  const port = canvas.getByRole('button', { name: 'Create order action port' });
  const target = canvas.locator('[data-prototype-target="new-order"]');
  await port.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const start = await port.boundingBox();
  const end = await target.boundingBox();
  if (!start || !end) throw new Error('Expected visible source port and target node');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(studio.getByRole('status')).toContainText('Updated the portable flow graph');
  await expect(canvas.getByLabel('Existing connectors')).toContainText('orders.create → new-order');

  await runtime.getByRole('button', { name: 'Create order', exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/new$/);
  await expect(
    runtime.getByLabel('New order prototype page').getByRole('heading', { name: 'New order' })
  ).toBeVisible();
  await expect(runtime.getByLabel('Navigation history')).toContainText('orders');
  await expect(runtime.getByLabel('Navigation history')).toContainText('new-order');

  await runtime.getByRole('button', { name: 'Save order', exact: true }).click();
  await expect(runtime.getByLabel('Order saved overlay')).toBeVisible();
  await runtime.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(runtime.getByLabel('Order saved overlay')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(runtime.getByLabel('Orders prototype page')).toBeVisible();
  await runtime.getByRole('button', { name: 'Show empty', exact: true }).click();
  await expect(runtime.getByText('No orders match this filter.')).toBeVisible();
});

test('supports keyboard canvas editing, viewport controls, external paste, and scheduled reset', async ({
  page
}) => {
  await page.clock.install();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const studio = page.getByLabel('Prototype editor and runtime');
  const canvas = studio.getByLabel('Prototype flow canvas');
  const runtime = studio.getByLabel('Compiled React prototype');

  const zoom = canvas.locator('[aria-label^="Canvas zoom"]');
  const initialZoom = await zoom.getAttribute('aria-label');
  const initialZoomPercent = Number(initialZoom?.match(/(\d+)/)?.[1]);
  await canvas.getByRole('button', { name: 'Zoom in' }).click();
  await expect(canvas.getByLabel(`Canvas zoom ${initialZoomPercent + 10} percent`)).toBeVisible();
  const viewport = canvas.getByLabel('Visual prototype flow');
  const initialTransform = await canvas.locator('.prototype-flow__transform').getAttribute('style');
  const viewportBox = await viewport.boundingBox();
  if (!viewportBox) throw new Error('Expected canvas viewport');
  await page.mouse.move(viewportBox.x + 12, viewportBox.y + 12);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + 36, viewportBox.y + 36);
  await page.mouse.up();
  await expect(canvas.locator('.prototype-flow__transform')).not.toHaveAttribute(
    'style',
    initialTransform ?? ''
  );

  await canvas.getByRole('button', { name: 'Create order action port' }).focus();
  await page.keyboard.press('Enter');
  await canvas.getByRole('button', { name: 'Connect to New order' }).press('Enter');
  await expect(canvas.getByLabel('Existing connectors')).toContainText('orders.create → new-order');
  await canvas.getByRole('button', { name: 'Undo' }).click();
  await expect(canvas.getByLabel('Existing connectors')).not.toContainText(
    'orders.create → new-order'
  );
  await canvas.getByRole('button', { name: 'Redo' }).click();

  await page.evaluate(async () => {
    await navigator.clipboard.writeText(
      JSON.stringify({
        format: 'selene-prototype-fragment/v1',
        nodes: [
          {
            kind: 'overlay',
            id: 'clipboard-overlay',
            label: 'Clipboard overlay',
            dismissible: true,
            position: { x: 1040, y: 160 },
            ports: []
          }
        ],
        transitions: []
      })
    );
  });
  await canvas.getByRole('button', { name: 'Paste' }).click();
  await expect(canvas.getByText('Clipboard overlay', { exact: true })).toBeVisible();

  await runtime.getByRole('button', { name: 'Create order', exact: true }).click();
  await expect(page).toHaveURL(/\/orders\/new$/);
  await page.clock.fastForward(10_000);
  await expect(page).toHaveURL(/\/orders$/);
  await expect(runtime.getByLabel('Orders prototype page')).toBeVisible();
});

test('keeps narrow multi-edge back, overlay, and timeout labels visibly separate', async ({
  page
}) => {
  await page.setViewportSize({ width: 540, height: 900 });
  await page.goto('/');
  const canvas = page.getByLabel('Prototype flow canvas');
  const labels = canvas.locator('[data-prototype-wire-label]');

  await expect(labels).toHaveCount(6);
  await expect(labels.filter({ hasText: 'open-overlay' })).toBeVisible();
  await expect(labels.filter({ hasText: 'back' })).toBeVisible();
  await expect(labels.filter({ hasText: 'reset-flow' })).toBeVisible();
  const boxes = await labels.evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      return {
        text: item.textContent ?? '',
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height
      };
    })
  );
  const viewportBox = await canvas.locator('.prototype-flow__viewport').boundingBox();
  if (!viewportBox) throw new Error('Expected a visible prototype viewport');
  const nodeBoxes = await canvas.locator('.prototype-flow__node').evaluateAll((items) =>
    items.map((item) => {
      const box = item.getBoundingClientRect();
      return {
        name: item.getAttribute('aria-label') ?? '',
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height
      };
    })
  );
  for (const [index, label] of boxes.entries()) {
    expect(label.x).toBeGreaterThanOrEqual(viewportBox.x);
    expect(label.y).toBeGreaterThanOrEqual(viewportBox.y);
    expect(label.x + label.width).toBeLessThanOrEqual(viewportBox.x + viewportBox.width);
    expect(label.y + label.height).toBeLessThanOrEqual(viewportBox.y + viewportBox.height);
    for (const other of boxes.slice(index + 1))
      expect(
        label.x < other.x + other.width &&
          label.x + label.width > other.x &&
          label.y < other.y + other.height &&
          label.y + label.height > other.y
      ).toBe(false);
    for (const node of nodeBoxes)
      expect(
        label.x < node.x + node.width &&
          label.x + label.width > node.x &&
          label.y < node.y + node.height &&
          label.y + label.height > node.y,
        `${label.text} must not overlap ${node.name}`
      ).toBe(false);
  }
  await expect(canvas).toHaveScreenshot('prototype-flow-multiedge-narrow.png', {
    animations: 'disabled',
    caret: 'hide'
  });
});

test('keeps an action-port back transition inside Selene at the runtime history boundary', async ({
  page
}) => {
  await page.goto('/');
  const studio = page.getByLabel('Prototype editor and runtime');
  const canvas = studio.getByLabel('Prototype flow canvas');
  const runtime = studio.getByLabel('Compiled React prototype');

  await canvas.getByLabel('Effect').selectOption('back');
  await canvas.getByRole('button', { name: 'Connect action' }).click();
  await expect(canvas.getByLabel('Existing connectors')).toContainText(
    'orders.create → history/back (back)'
  );
  await runtime.getByRole('button', { name: 'Create order', exact: true }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(studio.getByRole('status')).toContainText('local boundary');
  await expect(runtime.getByLabel('Orders prototype page')).toBeVisible();
});

test('keeps the deployed Pages workspace in three contained columns and a narrow stacked flow', async ({
  page
}) => {
  await page.setViewportSize({ width: 1_440, height: 960 });
  await page.goto('/');
  const deployed = page.locator('.designer-workspace--deployed');
  const layout = page.locator('.deployed-workspace-layout');
  await expect(deployed).toBeVisible();
  await expect(layout).toBeVisible();
  await expect(page.locator('.workspace-layout')).toHaveCount(0);
  await expect
    .poll(() =>
      layout
        .locator(':scope > *')
        .evaluateAll((items) => items.every((item) => getComputedStyle(item).minWidth === '0px'))
    )
    .toBe(true);

  const rail = await bounds(page, '.deployed-workspace-layout > .conversation-rail');
  const preview = await bounds(page, '.deployed-workspace-layout > .preview-pane');
  const inspector = await bounds(page, '.deployed-workspace-layout > .inspector');
  const layoutBounds = await bounds(page, '.deployed-workspace-layout');
  expect(right(rail), 'conversation rail must end before the preview starts').toBeLessThanOrEqual(
    preview.x + 1
  );
  expect(right(preview), 'preview must end before the inspector starts').toBeLessThanOrEqual(
    inspector.x + 1
  );
  expect(rail.x).toBeGreaterThanOrEqual(layoutBounds.x);
  expect(right(inspector)).toBeLessThanOrEqual(right(layoutBounds) + 1);
  expect(
    preview.width,
    'wide deployed preview must remain the dominant authoring surface'
  ).toBeGreaterThanOrEqual(720);
  await page.getByLabel('Navigate screen').focus();
  await expect(page.getByLabel('Navigate screen')).toBeFocused();
  expect(
    await page.getByLabel('Navigate screen').evaluate((element) => {
      const control = element.getBoundingClientRect();
      const inspectorBounds = element.closest('.inspector')?.getBoundingClientRect();
      const layoutElement = element.closest('.deployed-workspace-layout');
      return (
        inspectorBounds !== undefined &&
        control.left - 5 >= inspectorBounds.left &&
        control.right + 5 <= inspectorBounds.right &&
        getComputedStyle(element).outlineStyle !== 'none' &&
        layoutElement !== null &&
        getComputedStyle(layoutElement).overflow !== 'clip'
      );
    }),
    'focused deployed inspector content must retain an unclipped focus ring'
  ).toBe(true);
  const previewControl = page.locator('[data-selene-node-id="dashboard.hero"]');
  await previewControl.focus();
  await expect(previewControl).toBeFocused();
  expect(
    await previewControl.evaluate((element) => {
      const control = element.getBoundingClientRect();
      const pane = element.closest('.preview-pane')?.getBoundingClientRect();
      const overflow = getComputedStyle(element.closest('.preview-pane')!).overflow;
      return (
        pane !== undefined &&
        control.left - 5 >= pane.left &&
        control.right + 5 <= pane.right &&
        control.top - 5 >= pane.top &&
        getComputedStyle(element).outlineStyle !== 'none' &&
        overflow === 'auto'
      );
    }),
    'focused preview content must remain visible within its contained scroll surface'
  ).toBe(true);
  await expect(deployed).toHaveScreenshot('deployed-workspace-wide.png', {
    animations: 'disabled',
    caret: 'hide'
  });

  await page.setViewportSize({ width: 860, height: 1_000 });
  await page.goto('/');
  const mediumRail = await bounds(page, '.deployed-workspace-layout > .conversation-rail');
  const mediumPreview = await bounds(page, '.deployed-workspace-layout > .preview-pane');
  const mediumInspector = await bounds(page, '.deployed-workspace-layout > .inspector');
  expect(
    right(mediumRail),
    'medium conversation rail must not overlap preview'
  ).toBeLessThanOrEqual(mediumPreview.x + 1);
  expect(right(mediumPreview), 'medium preview must not overlap inspector').toBeLessThanOrEqual(
    mediumInspector.x + 1
  );
  expect(
    mediumPreview.width,
    'medium deployed preview must retain useful authoring width'
  ).toBeGreaterThanOrEqual(300);
  await expect(page.locator('.designer-workspace--deployed')).toHaveScreenshot(
    'deployed-workspace-medium.png',
    { animations: 'disabled', caret: 'hide' }
  );

  await page.setViewportSize({ width: 640, height: 1_400 });
  await page.goto('/');
  const compactRail = await bounds(page, '.deployed-workspace-layout > .conversation-rail');
  const compactPreview = await bounds(page, '.deployed-workspace-layout > .preview-pane');
  const compactInspector = await bounds(page, '.deployed-workspace-layout > .inspector');
  const compactLayout = await bounds(page, '.deployed-workspace-layout');
  for (const region of [compactRail, compactPreview, compactInspector]) {
    expect(region.x).toBeGreaterThanOrEqual(compactLayout.x);
    expect(right(region)).toBeLessThanOrEqual(right(compactLayout) + 1);
  }
  expect(compactPreview.y).toBeGreaterThanOrEqual(bottom(compactRail));
  expect(compactInspector.y).toBeGreaterThanOrEqual(bottom(compactPreview));
  await expect(page.locator('.designer-workspace--deployed')).toHaveScreenshot(
    'deployed-workspace-compact.png',
    { animations: 'disabled', caret: 'hide' }
  );
});
