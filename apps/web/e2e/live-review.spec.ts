import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { ordersReviewArtifact as artifact } from '../src/orders-review-handoff';

async function openReview(page: Page, serviceUrl: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // Render the production portal and HTTP provider against this isolated real service.
  await page.route('**/src/main.tsx', async (route) => {
    const response = await route.fetch();
    const entry = await response.text();
    const reactUrl = entry.match(/"([^"\n]*\/react\.js[^"\n]*)"/)?.[1];
    const domUrl = entry.match(/"([^"\n]*\/react-dom_client\.js[^"\n]*)"/)?.[1];
    if (!reactUrl || !domUrl) throw new Error('Vite React entry imports are unavailable.');
    await route.fulfill({
      response,
      body: `
        import React from ${JSON.stringify(reactUrl)};
        import ReactDOM from ${JSON.stringify(domUrl)};
        import { HostedReviewPortal } from '/src/app.tsx';
        import { createHostedReviewHttpProvider } from '/src/hosted-review-http-provider.ts';
        import '/src/styles.css';
        const provider = createHostedReviewHttpProvider(${JSON.stringify({
          serviceUrl,
          reviewUrl: 'https://review.example.test/review/prototype',
          revisionFingerprint: artifact.content.digest.value,
          screenId: 'orders'
        })});
        ReactDOM.createRoot(document.getElementById('root')).render(
          React.createElement(React.StrictMode, null, React.createElement(HostedReviewPortal, { provider }))
        );`
    });
  });
  await page.goto('/demo/review/prototype');
  await expect(page.getByText(/Verified 5 inspectable elements/))
    .toHaveCount(1)
    .catch((error: unknown) => {
      throw new Error(`${String(error)}\nBrowser errors: ${errors.join('\n')}`);
    });
}

test('two browser sessions receive live replies and recover through native EventSource reconnect', async ({
  browser,
  baseURL
}) => {
  if (!baseURL) throw new Error('The browser harness URL is required.');
  const child = spawn('bun', [
    fileURLToPath(new URL('./fixtures/live-review-service.ts', import.meta.url)),
    baseURL
  ]);
  let output = '';
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const url = output.match(/SELENE_TEST_SERVICE (http:\/\/[^\s]+)/)?.[1];
      if (url) resolve(url);
    });
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`Review fixture exited ${code}: ${output}`)));
  });
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const serviceUrl = await ready;
    for (const [context, reviewer] of [
      [first, 'reviewer-a'],
      [second, 'reviewer-b']
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- install each independent session cookie.
      await context.addCookies([
        { name: 'selene-test-reviewer', value: reviewer, url: serviceUrl }
      ]);
    }
    const a = await first.newPage();
    const b = await second.newPage();
    await Promise.all([openReview(a, serviceUrl), openReview(b, serviceUrl)]);
    const status = a.locator('[data-review-order="#1046"] [data-artifact-field="status"]');
    await status.click();
    await a.getByRole('button', { name: 'Comment', exact: true }).click();
    const discussionA = a.getByRole('dialog', { name: /Discussion on .* review point/ });
    await discussionA.getByLabel('Start revision-bound thread').fill('Live review from session A.');
    await discussionA.getByRole('button', { name: 'Add feedback', exact: true }).click();
    await expect(discussionA.getByLabel('Start revision-bound thread')).toHaveCount(0);
    await expect(discussionA).toContainText('Live review from session A.');
    const pin = b.locator('.artifact-pin-control');
    await expect(pin).toHaveCount(1);
    await pin.click();
    const discussionB = b.getByRole('dialog', { name: /Discussion on .* review point/ });
    await expect(discussionB).toContainText('Live review from session A.');
    await discussionB.getByLabel(/Reply to thread-/).fill('Live reply from session B.');
    await discussionB.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(discussionA).toContainText('Live reply from session B.');
    await first.request.post(`${serviceUrl}/__test/disconnect`);
    await discussionA.getByLabel(/Reply to thread-/).fill('Written during reconnect.');
    await discussionA.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(discussionB).toContainText('Written during reconnect.', { timeout: 15_000 });
    await expect
      .poll(async () => {
        const response = await first.request.get(`${serviceUrl}/__test/cursors`);
        const cursors: string[] = await response.json();
        return cursors.some((cursor) => Number(cursor) > 0);
      })
      .toBe(true);
  } finally {
    const logPath = test.info().outputPath('live-service-output.txt');
    await writeFile(logPath, output);
    await test
      .info()
      .attach('live-service-output.txt', { path: logPath, contentType: 'text/plain' });
    await Promise.all([first.close(), second.close()]);
    child.kill('SIGTERM');
  }
});
