import { expect, test, type Page } from '@playwright/test';
import { source as axeSource } from 'axe-core';

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

async function expectNoAxeViolations(page: Page, name: string) {
  await page.addScriptTag({ content: axeSource });
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & { axe: typeof import('axe-core') }).axe;
    const results = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => ({ target: node.target }))
    }));
  });

  expect(violations, `${name} axe violations: ${formatViolations(violations)}`).toEqual([]);
}

function formatViolations(violations: readonly AxeViolation[]) {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.nodes
          .map((node) => node.target.join(', '))
          .join('; ')}`
    )
    .join('\n');
}

test('the browser prototype has no WCAG A or AA violations', async ({ page }) => {
  await page.goto('http://127.0.0.1:4174');
  await expect(page.getByRole('main', { name: 'Selene designer workspace' })).toBeVisible();
  await expectNoAxeViolations(page, 'browser prototype');
});

test('the shared-component Storybook story has no WCAG A or AA violations', async ({ page }) => {
  await page.goto('http://127.0.0.1:6007/iframe.html?id=foundation-placeholderpanel--default');
  await expect(page.getByRole('region', { name: 'Shared UI placeholder' })).toBeVisible();
  await expectNoAxeViolations(page, 'Storybook placeholder panel');
});

test('the built Electron desktop renderer has no WCAG A or AA violations', async ({ page }) => {
  await page.goto('http://127.0.0.1:4175');
  await expect(page.getByRole('main', { name: 'Selene designer workspace' })).toBeVisible();
  await expectNoAxeViolations(page, 'Electron desktop renderer');
});
