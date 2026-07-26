import { expect, test } from '@playwright/test';

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
      portal.getByRole('heading', { name: 'Illustrative Orders React sample', exact: true })
    ).toBeVisible();
    await expect(portal.getByLabel('Handoff draft', { exact: true })).toContainText(
      'This demo-only browser-generated TypeScript sample'
    );
    const evidencePath = test.info().outputPath(`assembled-pages${route.replaceAll('/', '-')}.png`);
    await portal.screenshot({ path: evidencePath });
    await test.info().attach(`assembled-pages${route.replaceAll('/', '-')}`, {
      path: evidencePath,
      contentType: 'image/png'
    });
  });
}
