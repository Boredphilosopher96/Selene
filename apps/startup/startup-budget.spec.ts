import { expect, test } from '@playwright/test';

const maxJavaScriptRequests = 2;
const maxJavaScriptTransferBytes = 300 * 1024;

test('the production browser prototype startup stays within its JavaScript request and transfer budget', async ({
  page
}) => {
  await page.goto('http://127.0.0.1:4176');
  await page.waitForLoadState('networkidle');

  const startupJavaScript = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry as PerformanceResourceTiming)
      .filter((entry) => {
        const resource = new URL(entry.name);
        return resource.origin === location.origin && resource.pathname.endsWith('.js');
      })
      .map((entry) => ({ name: new URL(entry.name).pathname, transferSize: entry.transferSize }))
  );

  expect(startupJavaScript.length).toBeGreaterThan(0);
  expect(startupJavaScript.length).toBeLessThanOrEqual(maxJavaScriptRequests);
  expect(
    startupJavaScript.reduce((total, entry) => total + entry.transferSize, 0)
  ).toBeLessThanOrEqual(maxJavaScriptTransferBytes);
});
