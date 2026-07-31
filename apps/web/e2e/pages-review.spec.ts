import { expect, test, type Page } from '@playwright/test';

const collaborationStorageKey =
  'selene.hosted-review-collaboration.v2.northstar.orders-r18-7f3a.orders-r17-b9c1';
const providerStorageKey = `${collaborationStorageKey}.provider-state.v3.${encodeURIComponent(
  JSON.stringify([
    'northstar-review',
    'northstar',
    'orders-review-7f3a-b9c1',
    'orders-r18-7f3a',
    'orders-r17-b9c1',
    1
  ])
)}`;

function portal(page: Page) {
  return page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
}

async function selectElement(page: Page, field: 'customer' | 'status' | 'total') {
  const review = portal(page);
  await expect(review.getByText(/Verified 5 inspectable elements for orders-r18-7f3a/)).toHaveCount(1);
  const element = review.locator(`[data-review-order="#1046"] [data-artifact-field="${field}"]`);
  await element.click();
  const actions = review.getByRole('dialog', { name: /Actions for .* artifact pin/, exact: true });
  await expect(actions).toBeVisible();
  return { actions, element, review };
}

async function createThread(page: Page, field: 'customer' | 'status' | 'total', body: string) {
  const { actions, review } = await selectElement(page, field);
  await actions.getByRole('button', { name: 'Comment', exact: true }).click();
  const discussion = review.getByRole('dialog', {
    name: /Discussion on .* artifact pin/,
    exact: true
  });
  await discussion.getByLabel('Start revision-bound thread', { exact: true }).fill(body);
  await discussion.getByRole('button', { name: 'Add feedback', exact: true }).click();
  await expect(discussion).toContainText(body);
  return discussion;
}

test('uses one semantic selection and artifact-local Comment and Inspect actions', async ({
  page
}) => {
  await page.goto('/Selene/demo/review/prototype');
  const { actions, review } = await selectElement(page, 'status');

  await expect(review.locator('.mode-switch, .review-aside, .review-detail-panel')).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Region', exact: true })).toHaveCount(0);
  await expect(review.getByRole('button', { name: 'Point', exact: true })).toHaveCount(0);
  await expect(review.locator('.artifact-selection-overlay')).toHaveCount(0);
  await expect(review.locator('.workspace-topbar, .conversation-rail, .inspector')).toHaveCount(0);

  await actions.getByRole('button', { name: 'Inspect', exact: true }).click();
  await expect(actions.getByLabel('Read-only element inspection', { exact: true })).toBeVisible();
  await expect(actions.getByText('Read only', { exact: true })).toBeVisible();
  await actions.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(
    review.getByRole('dialog', { name: 'Discussion on OrderStatus artifact pin', exact: true })
  ).toBeVisible();
});

test('restores semantic trigger focus after popover Escape', async ({ page }) => {
  await page.goto('/Selene/demo/review/prototype');
  const { actions, element, review } = await selectElement(page, 'status');
  await expect(actions.getByRole('button', { name: 'Comment', exact: true })).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(actions).toHaveCount(0);
  await expect(element).toBeFocused();
  await expect(review.getByRole('status')).toContainText('Artifact pin discussion closed.');
});

test('a void click creates no pin and keeps local actions closed', async ({ page }) => {
  await page.goto('/Selene/demo/review/prototype');
  const review = portal(page);

  await review.locator('.orders-table thead').click();

  await expect(review.getByRole('dialog', { name: /artifact (pin|actions)/i })).toHaveCount(0);
  await expect(review.locator('.artifact-pin-control')).toHaveCount(0);
  await expect(review.locator('.artifact-selection-outline')).toHaveCount(0);
});

test('deep-links a baseline change only after resolving its live semantic element', async ({
  page
}) => {
  await page.goto('/Selene/demo/review/changes');
  const review = portal(page);
  const change = review.locator('.baseline-change-list article').filter({
    hasText: 'Address confirmation'
  });

  await change.getByRole('button', { name: 'Open pinned discussion', exact: true }).click();

  await expect(page).toHaveURL(/\/Selene\/demo\/review\/prototype$/);
  await expect(
    review.getByRole('dialog', { name: 'Discussion on OrdersReviewRow artifact pin', exact: true })
  ).toBeVisible();
  await expect(review.locator('.artifact-selection-outline')).toBeVisible();
  await expect(review.getByRole('status')).toContainText(
    'Address confirmation is selected as a revision-bound artifact pin.'
  );
});

test('persists multiple artifact threads and supports reload, replies, resolve, reopen, and pin navigation', async ({
  page
}) => {
  await page.goto('/Selene/demo/review/prototype');
  const first = await createThread(page, 'status', 'Keep the shipped status treatment.');
  const firstReply = first.getByLabel(/Reply to thread-/);
  await firstReply.fill('Accepted for implementation.');
  await first.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(first).toContainText('Accepted for implementation.');
  await first.getByRole('button', { name: 'Resolve', exact: true }).click();
  await first.getByRole('button', { name: 'Reopen', exact: true }).click();

  const second = await createThread(page, 'total', 'Keep order totals right-aligned.');
  await expect(second).toContainText('Keep order totals right-aligned.');
  const review = portal(page);
  await expect(review.locator('.artifact-pin-control')).toHaveCount(2);
  await second.getByRole('button', { name: 'Previous pin', exact: true }).click();
  await expect(second).toContainText('Keep the shipped status treatment.');
  await second.getByRole('button', { name: 'Next pin', exact: true }).click();
  await expect(second).toContainText('Keep order totals right-aligned.');

  await page.reload();
  await review.locator('.artifact-pin-control').nth(0).click();
  const restored = review.getByRole('dialog', {
    name: /Discussion on .* artifact pin/,
    exact: true
  });
  await expect(restored).toContainText('Keep the shipped status treatment.');
  await expect(restored).toContainText('Accepted for implementation.');
});

test('does not render malformed or stale browser-local review records', async ({ page }) => {
  await page.addInitScript(
    ({ legacyKey, stateKey }) => {
      window.localStorage.setItem(
        legacyKey,
        JSON.stringify([{ id: 'bad', pin: {}, messages: 'bad' }])
      );
      window.localStorage.setItem(
        stateKey,
        JSON.stringify({
          threads: [
            {
              id: 'thread-stale',
              version: 1,
              pin: {
                id: 'pin-v1-0000000000000000',
                projectId: 'northstar',
                artifactId: 'orders-review-stale',
                revisionId: 'orders-r17-stale',
                baselineId: 'orders-r16-stale',
                orderId: 'anchor',
                anchor: {
                  selector: '[data-review-order="#1046"] [data-artifact-field="status"]',
                  component: 'OrderStatus',
                  point: { x: 0.5, y: 0.5 },
                  region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
                }
              },
              replies: [],
              lifecycle: 'open'
            }
          ]
        })
      );
    },
    { legacyKey: collaborationStorageKey, stateKey: providerStorageKey }
  );

  await page.goto('/Selene/demo/review/prototype');

  await expect(portal(page).locator('.artifact-pin-control')).toHaveCount(0);
});

test('keeps the draft and existing discussion when local storage rejects a write', async ({
  page
}) => {
  await page.goto('/Selene/demo/review/prototype');
  const first = await createThread(page, 'customer', 'Existing local review thread.');
  await page.evaluate((key) => {
    const prototype = Object.getPrototypeOf(window.localStorage) as Storage;
    const originalSetItem = prototype.setItem;
    Object.defineProperty(prototype, 'setItem', {
      configurable: true,
      value(storageKey: string, value: string) {
        if (storageKey === key) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        return originalSetItem.call(this, storageKey, value);
      }
    });
  }, providerStorageKey);

  const composer = first.getByLabel(/Reply to thread-/);
  await composer.fill('Keep this quota-rejected draft.');
  await first.getByRole('button', { name: 'Reply', exact: true }).click();

  await expect(portal(page).getByRole('alert')).toContainText('quota prevented this change');
  await expect(composer).toHaveValue('Keep this quota-rejected draft.');
  await expect(first).toContainText('Existing local review thread.');
});

for (const route of ['/Selene/review/handoff', '/Selene/demo/review/handoff']) {
  test(`restores the assembled Pages handoff from ${route}`, async ({ page }) => {
    await page.goto(route);

    await expect(page).toHaveURL(/\/Selene\/demo\/review\/handoff$/);
    await expect(
      portal(page).getByRole('heading', {
        name: 'Immutable Orders React + TypeScript handoff',
        exact: true
      })
    ).toBeVisible();
    await expect(portal(page).getByLabel('Developer handoff', { exact: true })).toBeVisible();
  });
}
