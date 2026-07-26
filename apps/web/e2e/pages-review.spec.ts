import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { expect, test, type Download, type Page } from '@playwright/test';

const collaborationStorageKey =
  'selene.hosted-review-collaboration.v2.northstar.orders-r18-7f3a.orders-r17-b9c1.orders-review-7f3a-b9c1';

interface ArtifactPointerEventDiagnostic {
  readonly type: 'pointerdown' | 'pointerup';
  readonly clientX: number;
  readonly clientY: number;
  readonly target: string;
  readonly currentTarget: string;
  readonly captured: boolean;
}

interface ArtifactPointerDiagnostics {
  readonly events: readonly ArtifactPointerEventDiagnostic[];
  readonly selection: {
    readonly notice: string | undefined;
    readonly selectedOrder: string | undefined;
    readonly anchor: string | undefined;
  };
}

function fixtureHashPart(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonicalFixturePinId(input: {
  readonly projectId: string;
  readonly revisionId: string;
  readonly baselineId: string;
  readonly artifactId: string;
  readonly orderId: string;
  readonly anchor: {
    readonly selector: string;
    readonly component: string;
    readonly point: { readonly x: number; readonly y: number };
    readonly region: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  };
}): string {
  const { anchor } = input;
  const payload = JSON.stringify([
    input.projectId,
    input.revisionId,
    input.baselineId,
    input.artifactId,
    input.orderId,
    anchor.selector,
    anchor.component,
    anchor.point.x,
    anchor.point.y,
    anchor.region.x,
    anchor.region.y,
    anchor.region.width,
    anchor.region.height
  ]);
  return `pin-v1-${fixtureHashPart(payload, 0x811c9dc5)}${fixtureHashPart(`selene:${payload}`, 0x01000193)}`;
}

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  if (stream === null) throw new Error(`Could not read ${download.suggestedFilename()}`);
  let contents = '';
  for await (const chunk of stream) contents += chunk.toString();
  return contents;
}

async function selectAddressConfirmationBaseline(page: Page) {
  await page.goto('/Selene/demo/review/changes');
  const portal = page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
  const change = portal.locator('.baseline-change-list article').filter({
    hasText: 'Address confirmation'
  });
  await change.getByRole('button', { name: 'Open pinned discussion', exact: true }).click();
  return portal;
}

async function attachJsonDiagnostic(name: string, value: unknown): Promise<void> {
  const path = test.info().outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await test.info().attach(name, { path, contentType: 'application/json' });
}

function capturePageFailures(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const onPageError = (error: Error) => pageErrors.push(error.stack ?? error.message);
  const onConsole = (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  };
  page.on('pageerror', onPageError);
  page.on('console', onConsole);
  return {
    snapshot: () => ({ pageErrors, consoleErrors }),
    dispose: () => {
      page.off('pageerror', onPageError);
      page.off('console', onConsole);
    }
  };
}

async function attachArtifactGestureDiagnostics(
  page: Page,
  phase: string,
  probeSelector = '[data-review-order="#1046"] [data-artifact-field="status"]'
): Promise<void> {
  const diagnostics = await page.evaluate((probeSelectorArgument) => {
    const rectangle = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) return undefined;
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    };
    const probeElement = document.querySelector<HTMLElement>(probeSelectorArgument);
    const probe = probeElement?.getBoundingClientRect();
    const stack =
      probe === undefined
        ? []
        : document
            .elementsFromPoint(probe.left + probe.width * 0.2, probe.top + probe.height * 0.3)
            .map((element) => {
              const html = element instanceof HTMLElement ? element : undefined;
              const field = html?.closest<HTMLElement>('[data-artifact-field]');
              const row = html?.closest<HTMLElement>('[data-review-order]');
              return {
                tag: element.tagName.toLowerCase(),
                className: typeof html?.className === 'string' ? html.className : undefined,
                artifactField: html?.dataset.artifactField,
                reviewOrder: html?.dataset.reviewOrder,
                closestArtifactField: field?.dataset.artifactField,
                closestReviewOrder: row?.dataset.reviewOrder
              };
            });
    const overlay = document.querySelector<HTMLElement>('.artifact-selection-overlay');
    const overlayStyle = overlay === null ? undefined : getComputedStyle(overlay);
    const discussion = document.querySelector<HTMLElement>(
      '[aria-label="Discussion on selected order"]'
    );
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      },
      probe: {
        selector: probeSelectorArgument,
        rectangle: rectangle(probeSelectorArgument)
      },
      rectangles: {
        status: rectangle('[data-review-order="#1046"] [data-artifact-field="status"]'),
        total: rectangle('[data-review-order="#1046"] [data-artifact-field="total"]'),
        overlay: rectangle('.artifact-selection-overlay')
      },
      hitStack: stack,
      overlay: {
        pointerEvents: overlayStyle?.pointerEvents,
        zIndex: overlayStyle?.zIndex
      },
      postGesture: {
        notice: document.querySelector('[role="status"]')?.textContent,
        selectedOrder: document.querySelector('aside.review-aside .review-detail-panel h2')
          ?.textContent,
        discussionAnchor: Array.from(
          discussion?.querySelectorAll('.review-data-notice') ?? []
        ).find((element) => element.textContent?.startsWith('Artifact pin'))?.textContent
      }
    };
  }, probeSelector);
  await attachJsonDiagnostic(`artifact-gesture-${phase}`, diagnostics);
  const screenshot = test.info().outputPath(`artifact-gesture-${phase}.png`);
  await page.screenshot({ path: screenshot });
  await test
    .info()
    .attach(`artifact-gesture-${phase}-screenshot`, { path: screenshot, contentType: 'image/png' });
}

async function armArtifactPointerDiagnostics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>('.artifact-selection-overlay');
    if (overlay === null) throw new Error('Expected artifact selection overlay.');
    const events: {
      readonly type: 'pointerdown' | 'pointerup';
      readonly clientX: number;
      readonly clientY: number;
      readonly target: string;
      readonly currentTarget: string;
      readonly captured: boolean;
    }[] = [];
    const record = (event: PointerEvent) => {
      if (event.type !== 'pointerdown' && event.type !== 'pointerup') return;
      const type = event.type === 'pointerdown' ? 'pointerdown' : 'pointerup';
      const target = event.target instanceof HTMLElement ? event.target : undefined;
      events.push({
        type,
        clientX: event.clientX,
        clientY: event.clientY,
        target: target?.className ?? target?.tagName ?? 'unknown',
        currentTarget: overlay.className,
        captured: overlay.hasPointerCapture(event.pointerId)
      });
    };
    overlay.addEventListener('pointerdown', record);
    overlay.addEventListener('pointerup', record);
    Object.assign(window, {
      seleneArtifactPointerDiagnostics: {
        events,
        dispose: () => {
          overlay.removeEventListener('pointerdown', record);
          overlay.removeEventListener('pointerup', record);
        }
      }
    });
  });
}

async function attachArtifactPointerDiagnostics(
  page: Page,
  name = 'artifact-pointer-gesture'
): Promise<ArtifactPointerDiagnostics> {
  const diagnostics: ArtifactPointerDiagnostics = await page.evaluate(() => {
    const source = window as typeof window & {
      seleneArtifactPointerDiagnostics?: {
        readonly events: readonly ArtifactPointerEventDiagnostic[];
        readonly dispose: () => void;
      };
    };
    const trace = source.seleneArtifactPointerDiagnostics;
    trace?.dispose();
    delete source.seleneArtifactPointerDiagnostics;
    return {
      events: trace?.events ?? [],
      selection: {
        notice: document.querySelector('[role="status"]')?.textContent,
        selectedOrder: document.querySelector('aside.review-aside .review-detail-panel h2')
          ?.textContent,
        anchor: Array.from(
          document.querySelectorAll(
            '[aria-label="Discussion on selected order"] .review-data-notice'
          )
        ).find((element) => element.textContent?.startsWith('Artifact pin'))?.textContent
      }
    };
  });
  await attachJsonDiagnostic(name, diagnostics);
  return diagnostics;
}

async function attachReplyDiagnostics(
  page: Page,
  phase: string,
  includeScreenshot = false
): Promise<void> {
  const diagnostics = await page.evaluate(() => {
    const discussion = document.querySelector<HTMLElement>(
      '[aria-label="Discussion on selected order"]'
    );
    const describe = (element: HTMLElement) => ({
      name: element.getAttribute('aria-label') ?? element.textContent?.trim(),
      disabled: 'disabled' in element ? (element as HTMLButtonElement).disabled : undefined
    });
    return {
      modes: Array.from(document.querySelectorAll<HTMLElement>('.mode-switch button')).map(
        (button) => ({
          name: button.textContent?.trim(),
          pressed: button.getAttribute('aria-pressed')
        })
      ),
      articleCount: discussion?.querySelectorAll('article').length ?? 0,
      formCount: discussion?.querySelectorAll('form').length ?? 0,
      buttons: Array.from(discussion?.querySelectorAll<HTMLElement>('button') ?? []).map(describe),
      textareas: Array.from(discussion?.querySelectorAll<HTMLElement>('textarea') ?? []).map(
        describe
      )
    };
  });
  await attachJsonDiagnostic(`reply-controls-${phase}`, diagnostics);
  if (!includeScreenshot) return;
  const screenshot = test.info().outputPath(`reply-controls-${phase}.png`);
  await page.screenshot({ path: screenshot });
  await test
    .info()
    .attach(`reply-controls-${phase}-screenshot`, { path: screenshot, contentType: 'image/png' });
}

const directReviewRoutes = ['/Selene/review/handoff', '/Selene/demo/review/handoff'];

for (const route of directReviewRoutes) {
  test(`restores the assembled Pages handoff from ${route}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.goto(route);

    await expect(page).toHaveURL(/\/Selene\/demo\/review\/handoff$/);
    const portal = page.getByRole('main', {
      name: 'Northstar hosted review portal',
      exact: true
    });
    await expect(portal).toBeVisible();
    await expect(
      portal.getByRole('heading', {
        name: 'Immutable Orders React + TypeScript handoff',
        exact: true
      })
    ).toBeVisible();
    await expect(portal.getByLabel('Developer handoff', { exact: true })).toContainText(
      'Download the committed artifact and its manifest together.'
    );
    const evidencePath = test.info().outputPath(`assembled-pages${route.replaceAll('/', '-')}.png`);
    await portal.screenshot({ path: evidencePath });
    await test.info().attach(`assembled-pages${route.replaceAll('/', '-')}`, {
      path: evidencePath,
      contentType: 'image/png'
    });
  });
}

test('stores revision-bound pinned threads, replies, and resolution locally', async ({ page }) => {
  const portal = await selectAddressConfirmationBaseline(page);
  const failures = capturePageFailures(page);
  const discussion = portal.getByLabel('Discussion on selected order');
  const discussionBody = discussion.locator('article .review-reply');
  try {
    await expect(discussion).toContainText(
      '[data-review-order="#1048"] [data-artifact-field="customer"]'
    );
    await portal.getByLabel('Start revision-bound thread').fill('Confirm address before packing.');
    await portal.getByRole('button', { name: 'Start pinned thread' }).click();
    await expect(
      discussionBody.getByText('Confirm address before packing.', { exact: true })
    ).toBeVisible();
    const activeThreadForm = discussion
      .locator('article')
      .filter({ hasText: 'Confirm address before packing.' })
      .locator('form.thread-actions');
    const reply = activeThreadForm.getByRole('button', { name: 'Reply', exact: true });
    await attachReplyDiagnostics(page, 'before-fill');
    await activeThreadForm
      .getByLabel(/Reply to thread-/)
      .fill('Accepted for the Orders row implementation.');
    await attachReplyDiagnostics(page, 'after-fill', true);
    await expect(portal).toBeVisible();
    await expect(reply).toBeVisible();
    await expect(reply).toBeEnabled();
    await reply.click();
    await expect(
      discussionBody.getByText('Accepted for the Orders row implementation.', { exact: true })
    ).toBeVisible();
    expect(failures.snapshot()).toEqual({ pageErrors: [], consoleErrors: [] });
    await portal.getByRole('button', { name: 'Resolve' }).click();
    await expect(portal.getByText('Resolved thread')).toBeVisible();
    await portal.getByRole('button', { name: 'Reopen' }).click();
    await expect(portal.getByText('Open thread')).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    const restoredChange = portal.locator('.baseline-change-list article').filter({
      hasText: 'Address confirmation'
    });
    await restoredChange
      .getByRole('button', { name: 'Open pinned discussion', exact: true })
      .click();
    await expect(
      discussionBody.getByText('Confirm address before packing.', { exact: true })
    ).toBeVisible();
    await expect(
      discussionBody.getByText('Accepted for the Orders row implementation.', { exact: true })
    ).toBeVisible();
  } finally {
    await attachJsonDiagnostic('reply-runtime-failures', failures.snapshot());
    failures.dispose();
  }
});

test('opens an actionable baseline delta at its exact pinned artifact region', async ({ page }) => {
  await page.goto('/Selene/demo/review/changes');
  const portal = page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
  const change = portal.locator('.baseline-change-list article').filter({
    hasText: 'Address confirmation'
  });
  await change.getByRole('button', { name: 'Open pinned discussion', exact: true }).click();

  await expect(page).toHaveURL(/\/Selene\/demo\/review\/prototype$/);
  await expect(portal.getByLabel('Discussion on selected order')).toContainText(
    '[data-review-order="#1048"] [data-artifact-field="customer"]'
  );
  const baselineNotice = portal.getByRole('status');
  await expect(baselineNotice).toContainText(
    'Address confirmation is selected as a pinned baseline change:'
  );
});

test('selects an arbitrary artifact region with coordinate, selector, and component provenance', async ({
  page
}) => {
  await page.goto('/Selene/demo/review/prototype');
  const portal = page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
  await expect(portal.locator('aside.review-aside .review-detail-panel h2')).toHaveText('#1048');
  await portal.getByRole('button', { name: 'Region', exact: true }).click();
  await expect(
    portal.getByLabel('Select region on the Orders artifact', { exact: true })
  ).toBeVisible();
  const statusField = portal.locator('[data-review-order="#1046"] [data-artifact-field="status"]');
  const totalField = portal.locator('[data-review-order="#1046"] [data-artifact-field="total"]');
  await statusField.scrollIntoViewIfNeeded();
  await totalField.scrollIntoViewIfNeeded();
  const [box, totalBox, viewport] = await Promise.all([
    statusField.boundingBox(),
    totalField.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  ]);
  if (box === null || totalBox === null) throw new Error('Expected #1046 review artifact fields');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(totalBox.x).toBeGreaterThanOrEqual(0);
  expect(totalBox.x + totalBox.width).toBeLessThanOrEqual(viewport.width);
  expect(totalBox.y).toBeGreaterThanOrEqual(0);
  expect(totalBox.y + totalBox.height).toBeLessThanOrEqual(viewport.height);
  await attachArtifactGestureDiagnostics(page, 'before');
  await armArtifactPointerDiagnostics(page);
  const start = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 };
  const end = { x: totalBox.x + totalBox.width * 0.5, y: totalBox.y + totalBox.height * 0.5 };
  let pointerDiagnostics: ArtifactPointerDiagnostics | undefined;
  try {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y);
    await page.mouse.up();
  } finally {
    pointerDiagnostics = await attachArtifactPointerDiagnostics(page);
  }
  if (pointerDiagnostics === undefined) throw new Error('Missing artifact pointer diagnostics.');
  const pointerDown = pointerDiagnostics.events.filter((event) => event.type === 'pointerdown');
  const pointerUp = pointerDiagnostics.events.filter((event) => event.type === 'pointerup');
  expect(pointerDiagnostics.events).toHaveLength(2);
  expect(pointerDown).toHaveLength(1);
  expect(pointerUp).toHaveLength(1);
  const [down] = pointerDown;
  const [up] = pointerUp;
  if (down === undefined || up === undefined)
    throw new Error('Expected complete artifact pointer trace.');
  expect(down.target).toContain('artifact-selection-overlay');
  expect(down.currentTarget).toContain('artifact-selection-overlay');
  expect(up.target).toContain('artifact-selection-overlay');
  expect(up.currentTarget).toContain('artifact-selection-overlay');
  expect(up.captured).toBe(true);
  expect(Math.abs(down.clientX - start.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(down.clientY - start.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(up.clientX - end.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(up.clientY - end.y)).toBeLessThanOrEqual(1);
  expect(down.clientX).toBeGreaterThanOrEqual(box.x);
  expect(down.clientX).toBeLessThanOrEqual(box.x + box.width);
  expect(down.clientY).toBeGreaterThanOrEqual(box.y);
  expect(down.clientY).toBeLessThanOrEqual(box.y + box.height);
  expect(up.clientX).toBeGreaterThanOrEqual(totalBox.x);
  expect(up.clientX).toBeLessThanOrEqual(totalBox.x + totalBox.width);
  expect(up.clientY).toBeGreaterThanOrEqual(totalBox.y);
  expect(up.clientY).toBeLessThanOrEqual(totalBox.y + totalBox.height);
  expect(pointerDiagnostics.selection.selectedOrder).toBe('#1046');
  expect(pointerDiagnostics.selection.anchor).toContain('Artifact pin · OrderStatus');
  expect(pointerDiagnostics.selection.anchor).toContain(
    '[data-review-order="#1046"] [data-artifact-field="status"]'
  );
  await attachArtifactGestureDiagnostics(page, 'after');

  const discussion = portal.getByLabel('Discussion on selected order');
  await expect(portal.locator('aside.review-aside .review-detail-panel h2')).toHaveText('#1046');
  await expect(discussion).toContainText('OrderStatus');
  await expect(discussion).toContainText(
    '[data-review-order="#1046"] [data-artifact-field="status"]'
  );
  await expect(discussion).toContainText('point');
  await expect(discussion).toContainText('region');
  await expect(discussion).toContainText('Artifact pin · OrderStatus');
  await expect(discussion).toContainText('No threads for this pinned region.');
  await expect(portal.locator('.artifact-anchor-highlight')).toBeVisible();
  await expect(portal.getByLabel('Start revision-bound thread')).toHaveAttribute(
    'maxlength',
    '4000'
  );
  await portal.getByLabel('Start revision-bound thread').fill('Keep the shipped status treatment.');
  await portal.getByRole('button', { name: 'Start pinned thread' }).click();
  await expect(discussion).toContainText('Keep the shipped status treatment.');
  await portal
    .getByLabel('Start revision-bound thread')
    .fill('Keep the separate shipped review note.');
  await portal.getByRole('button', { name: 'Start pinned thread' }).click();
  await expect(discussion).toContainText('Keep the separate shipped review note.');
  const persistedThreads = await page.evaluate((key) => {
    return JSON.parse(window.localStorage.getItem(key) ?? '[]');
  }, collaborationStorageKey);
  await expect(persistedThreads).toHaveLength(2);
  const firstThread = persistedThreads.find(
    (thread: { messages: readonly { body: string }[] }) =>
      thread.messages[0]?.body === 'Keep the shipped status treatment.'
  );
  const secondThread = persistedThreads.find(
    (thread: { messages: readonly { body: string }[] }) =>
      thread.messages[0]?.body === 'Keep the separate shipped review note.'
  );
  if (firstThread === undefined || secondThread === undefined) {
    throw new Error('Expected two independently persisted #1046 status threads');
  }
  expect(firstThread.id).not.toBe(secondThread.id);
  expect(firstThread.pin.id).toMatch(/^pin-v1-[0-9a-f]{16}$/);
  expect(secondThread.pin.id).toBe(firstThread.pin.id);
  await expect(firstThread).toMatchObject({
    pin: {
      projectId: 'northstar',
      revisionId: 'orders-r18-7f3a',
      baselineId: 'orders-r17-b9c1',
      artifactId: 'orders-review-7f3a-b9c1',
      orderId: '#1046',
      anchor: {
        selector: '[data-review-order="#1046"] [data-artifact-field="status"]',
        component: 'OrderStatus'
      }
    }
  });

  await portal
    .getByLabel('Start revision-bound thread')
    .fill('Keep this draft when a non-reviewable hit is rejected.');
  await portal.getByRole('button', { name: 'Point', exact: true }).click();
  await expect(
    portal.getByLabel('Select point on the Orders artifact', { exact: true })
  ).toBeVisible();
  const header = portal.locator('.orders-table thead');
  await header.scrollIntoViewIfNeeded();
  const [headerBox, headerViewport] = await Promise.all([
    header.boundingBox(),
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  ]);
  if (headerBox === null) throw new Error('Expected non-reviewable table header');
  const headerCenter = {
    x: headerBox.x + headerBox.width * 0.5,
    y: headerBox.y + headerBox.height * 0.5
  };
  expect(headerCenter.x).toBeGreaterThanOrEqual(0);
  expect(headerCenter.x).toBeLessThanOrEqual(headerViewport.width);
  expect(headerCenter.y).toBeGreaterThanOrEqual(0);
  expect(headerCenter.y).toBeLessThanOrEqual(headerViewport.height);
  await attachArtifactGestureDiagnostics(page, 'invalid-before', '.orders-table thead');
  await armArtifactPointerDiagnostics(page);
  let invalidPointerDiagnostics: ArtifactPointerDiagnostics | undefined;
  try {
    await page.mouse.click(headerCenter.x, headerCenter.y);
  } finally {
    invalidPointerDiagnostics = await attachArtifactPointerDiagnostics(
      page,
      'invalid-artifact-pointer-gesture'
    );
  }
  if (invalidPointerDiagnostics === undefined)
    throw new Error('Missing invalid artifact pointer diagnostics.');
  const invalidDown = invalidPointerDiagnostics.events.filter(
    (event) => event.type === 'pointerdown'
  );
  const invalidUp = invalidPointerDiagnostics.events.filter((event) => event.type === 'pointerup');
  expect(invalidPointerDiagnostics.events).toHaveLength(2);
  expect(invalidDown).toHaveLength(1);
  expect(invalidUp).toHaveLength(1);
  const [invalidDownEvent] = invalidDown;
  const [invalidUpEvent] = invalidUp;
  if (invalidDownEvent === undefined || invalidUpEvent === undefined)
    throw new Error('Expected complete invalid artifact pointer trace.');
  expect(invalidDownEvent.target).toContain('artifact-selection-overlay');
  expect(invalidDownEvent.currentTarget).toContain('artifact-selection-overlay');
  expect(invalidUpEvent.target).toContain('artifact-selection-overlay');
  expect(invalidUpEvent.currentTarget).toContain('artifact-selection-overlay');
  expect(invalidDownEvent.captured).toBe(false);
  expect(invalidUpEvent.captured).toBe(false);
  expect(Math.abs(invalidDownEvent.clientX - headerCenter.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(invalidDownEvent.clientY - headerCenter.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(invalidUpEvent.clientX - headerCenter.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(invalidUpEvent.clientY - headerCenter.y)).toBeLessThanOrEqual(1);
  expect(invalidPointerDiagnostics.selection.notice).toBe(
    'No reviewable artifact row or field was found at that point; the current anchor is unchanged.'
  );
  expect(invalidPointerDiagnostics.selection.selectedOrder).toBe('#1046');
  expect(invalidPointerDiagnostics.selection.anchor).toContain('Artifact pin · OrderStatus');
  expect(invalidPointerDiagnostics.selection.anchor).toContain(
    '[data-review-order="#1046"] [data-artifact-field="status"]'
  );
  await attachArtifactGestureDiagnostics(page, 'invalid-after', '.orders-table thead');
  await expect(portal.getByRole('status')).toContainText(
    'No reviewable artifact row or field was found at that point; the current anchor is unchanged.'
  );
  await expect(portal.locator('.artifact-anchor-highlight')).toBeVisible();
  await expect(portal.getByLabel('Start revision-bound thread')).toHaveValue(
    'Keep this draft when a non-reviewable hit is rejected.'
  );
  await expect(discussion).toContainText('OrderStatus');
  await page.reload();
  await expect(
    portal.getByText('Revision-bound review data · 2 local threads on this artifact')
  ).toBeVisible();
  const rail = portal.getByLabel('Saved local review threads');
  await expect(rail.getByRole('button', { name: /Open saved thread thread-/ })).toHaveCount(2);
  await expect(rail.locator('[data-saved-thread-ref]')).toHaveCount(2);
  const reloadedThreads = await page.evaluate((key) => {
    return JSON.parse(window.localStorage.getItem(key) ?? '[]');
  }, collaborationStorageKey);
  await expect(reloadedThreads).toEqual(persistedThreads);
  await expect(reloadedThreads).toHaveLength(2);
  await expect(firstThread).toMatchObject({
    pin: {
      projectId: 'northstar',
      orderId: '#1046',
      revisionId: 'orders-r18-7f3a',
      baselineId: 'orders-r17-b9c1',
      artifactId: 'orders-review-7f3a-b9c1',
      anchor: {
        selector: '[data-review-order="#1046"] [data-artifact-field="status"]',
        component: 'OrderStatus'
      }
    }
  });
  const firstThreadButton = rail.getByRole('button', {
    name: `Open saved thread ${firstThread.id}; open; Keep the shipped status treatment.`,
    exact: true
  });
  await expect(firstThreadButton).toHaveAttribute('id', `open-saved-thread-${firstThread.id}`);
  await expect(firstThreadButton.locator('..')).toHaveAttribute(
    'data-saved-thread-ref',
    firstThread.id
  );
  await firstThreadButton.click();
  await expect(portal.locator('aside.review-aside .review-detail-panel h2')).toHaveText('#1046');
  await expect(discussion).toContainText(
    '[data-review-order="#1046"] [data-artifact-field="status"]'
  );
  await expect(discussion).toContainText('OrderStatus');
  await expect(discussion).toContainText('Keep the shipped status treatment.');
  await expect(discussion).not.toContainText('Keep the separate shipped review note.');
  await expect(portal.locator('.artifact-anchor-highlight')).toBeVisible();
  const restoredThreadForm = discussion
    .locator('article')
    .filter({ hasText: 'Keep the shipped status treatment.' })
    .locator('form.thread-actions');
  await restoredThreadForm.getByLabel(/Reply to thread-/).fill('Restored pin reply.');
  await restoredThreadForm.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(discussion).toContainText('Restored pin reply.');
  await portal.getByRole('button', { name: 'Resolve' }).click();
  await expect(discussion).toContainText('Resolved thread');
  await portal.getByRole('button', { name: 'Reopen' }).click();
  await expect(discussion).toContainText('Open thread');
  const secondThreadButton = rail.getByRole('button', {
    name: `Open saved thread ${secondThread.id}; open; Keep the separate shipped review note.`,
    exact: true
  });
  await expect(secondThreadButton).toHaveAttribute('id', `open-saved-thread-${secondThread.id}`);
  await secondThreadButton.click();
  await expect(discussion).toContainText('Keep the separate shipped review note.');
  await expect(discussion).not.toContainText('Keep the shipped status treatment.');
});

test('ignores malformed local collaboration storage', async ({ page }) => {
  await page.addInitScript((key) => {
    window.localStorage.setItem(
      key,
      JSON.stringify([{ id: 'malformed', pin: {}, messages: 'not-an-array', status: 'open' }])
    );
  }, collaborationStorageKey);
  const portal = await selectAddressConfirmationBaseline(page);
  await expect(portal.getByText('No threads for this pinned region.')).toBeVisible();
});

test('rejects stale revision, baseline, and artifact records under the active storage key', async ({
  page
}) => {
  const stalePin = {
    projectId: 'northstar',
    revisionId: 'orders-r17-stale',
    baselineId: 'orders-r16-stale',
    artifactId: 'orders-review-stale',
    orderId: '#1046',
    anchor: {
      selector: '[data-review-order="#1046"] [data-artifact-field="status"]',
      component: 'OrderStatus',
      point: { x: 0.5, y: 0.5 },
      region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
    }
  };
  await page.addInitScript(
    ({ key, pinId }) => {
      window.localStorage.setItem(
        key,
        JSON.stringify([
          {
            id: 'thread-stale-binding',
            pin: {
              id: pinId,
              projectId: 'northstar',
              revisionId: 'orders-r17-stale',
              baselineId: 'orders-r16-stale',
              artifactId: 'orders-review-stale',
              orderId: '#1046',
              anchor: {
                selector: '[data-review-order="#1046"] [data-artifact-field="status"]',
                component: 'OrderStatus',
                point: { x: 0.5, y: 0.5 },
                region: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 }
              }
            },
            messages: [
              {
                id: 'message-stale-binding',
                author: 'Audit',
                body: 'This stale record must not render.',
                createdAt: '2026-07-25T22:18:00.000Z'
              }
            ],
            status: 'open'
          }
        ])
      );
    },
    { key: collaborationStorageKey, pinId: canonicalFixturePinId(stalePin) }
  );
  await page.goto('/Selene/demo/review/prototype');
  const portal = page.getByRole('main', { name: 'Northstar hosted review portal', exact: true });
  const rail = portal.getByLabel('Saved local review threads');
  await expect(rail).toContainText('No local revision-bound threads are saved for this artifact.');
  await expect(rail.locator('[data-saved-thread-ref]')).toHaveCount(0);
  await expect(
    portal.getByText('Revision-bound review data · 0 local threads on this artifact')
  ).toBeVisible();
});

test('retains a valid pin and draft when local storage quota rejects a write', async ({ page }) => {
  const portal = await selectAddressConfirmationBaseline(page);
  const discussion = portal.getByLabel('Discussion on selected order');
  await portal.getByLabel('Start revision-bound thread').fill('Existing local review thread.');
  await portal.getByRole('button', { name: 'Start pinned thread' }).click();
  const before = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    collaborationStorageKey
  );

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
  }, collaborationStorageKey);

  await portal.getByLabel('Start revision-bound thread').fill('Keep this quota-rejected draft.');
  await portal.getByRole('button', { name: 'Start pinned thread' }).click();
  await expect(portal.getByRole('alert')).toHaveText(
    'Local review storage quota prevented this change. Existing saved threads and drafts were kept.'
  );
  await expect(portal.getByLabel('Start revision-bound thread')).toHaveValue(
    'Keep this quota-rejected draft.'
  );
  await expect(
    discussion
      .locator('article .review-reply')
      .getByText('Existing local review thread.', { exact: true })
  ).toBeVisible();
  const after = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    collaborationStorageKey
  );
  expect(after).toBe(before);
});

test('downloads an exact content-addressed handoff artifact and manifest', async ({ page }) => {
  await page.goto('/Selene/demo/review/handoff');
  const downloads: Download[] = [];
  page.on('download', (download) => downloads.push(download));
  await page.getByRole('button', { name: 'Download exact React artifact + manifest' }).click();
  await expect.poll(() => downloads.length).toBe(2);

  const received = await Promise.all(
    downloads.map(
      async (download) => [download.suggestedFilename(), await readDownload(download)] as const
    )
  );
  const contents = new Map(received);
  const artifact = contents.get('orders-review-r18.tsx');
  const manifestText = contents.get('orders-review-r18.manifest.json');
  if (artifact === undefined || manifestText === undefined)
    throw new Error('Missing handoff download');

  const digest = createHash('sha256').update(artifact).digest('hex');
  const manifest = JSON.parse(manifestText);
  expect(manifest.artifact.content.ref).toBe(`sha256:${digest}`);
  expect(manifest.artifact.content.digest).toEqual({ algorithm: 'sha256', value: digest });
  expect(manifest.artifact.content.blob).toEqual({
    name: 'orders-review-r18.tsx',
    mediaType: 'text/plain;charset=utf-8'
  });
  expect(manifest.artifact).not.toHaveProperty('sourceRef');
  expect(manifest.artifact).not.toHaveProperty('sourceCommit');
});
