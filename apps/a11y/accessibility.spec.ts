import { expect, test, type Page } from '@playwright/test';
import { source as axeSource } from 'axe-core';

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

const axeBusyMessage = 'Axe is already running';

async function ensureAxe(page: Page) {
  const hasAxe = await page.evaluate(() => {
    const axe = (window as typeof window & { axe?: typeof import('axe-core') }).axe;
    return typeof axe?.run === 'function';
  });
  if (!hasAxe) await page.addScriptTag({ content: axeSource });
}

async function runAxe(page: Page, remainingBusyRetries = 10): Promise<AxeViolation[]> {
  try {
    return await page.evaluate(async () => {
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
  } catch (error) {
    if (remainingBusyRetries === 0 || !String(error).includes(axeBusyMessage)) throw error;
    await page.waitForTimeout(100);
    return runAxe(page, remainingBusyRetries - 1);
  }
}

async function expectNoAxeViolations(page: Page, name: string) {
  await ensureAxe(page);
  const violations = await runAxe(page);
  expect(violations, `${name} axe violations: ${formatViolations(violations)}`).toEqual([]);
}

async function focusWithKeyboard(
  page: Page,
  target: ReturnType<Page['locator']>,
  remainingTabs = 30
): Promise<void> {
  if (await target.evaluate((element) => document.activeElement === element)) return;
  if (remainingTabs === 0)
    throw new Error(`Could not reach ${await target.getAttribute('aria-label')} using only Tab.`);
  await page.keyboard.press('Tab');
  await focusWithKeyboard(page, target, remainingTabs - 1);
}

async function expectVisibleFocus(target: ReturnType<Page['locator']>) {
  await expect(target).toBeFocused();
  const focusStyle = await target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe('none');
  expect(focusStyle.outlineWidth).not.toBe('0px');
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

test('the browser prototype supports its primary review workflow using only the keyboard', async ({
  page
}) => {
  await page.goto('http://127.0.0.1:4174');

  const createProject = page.getByRole('button', { name: 'Create project' });
  await focusWithKeyboard(page, createProject);
  await expectVisibleFocus(createProject);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Created a fresh local Northstar project.');

  const screen = page.getByLabel('Navigate screen');
  await focusWithKeyboard(page, screen);
  await expectVisibleFocus(screen);
  await page.keyboard.press('o');
  await page.keyboard.press('Tab');
  await expect(screen).toHaveValue('orders');
  await expect(page.getByLabel('Live React preview')).toContainText('Orders');
  await expect(page.getByRole('status')).toHaveText('Navigated the live preview.');

  const ordersTitle = page.locator('[data-selene-node-id="orders.title"]');
  await focusWithKeyboard(page, ordersTitle);
  await expectVisibleFocus(ordersTitle);
  await page.keyboard.press('Enter');
  await expect(page.getByText('orders.title', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Selected orders.title.');

  const comment = page.getByLabel('Comment for selected node');
  await focusWithKeyboard(page, comment);
  await expectVisibleFocus(comment);
  await page.keyboard.type('Clarify the keyboard review path.');

  const addComment = page.getByRole('button', { name: 'Add comment' });
  await focusWithKeyboard(page, addComment);
  await expectVisibleFocus(addComment);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Clarify the keyboard review path.')).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Added a node-level comment.');
});

test.describe('Storybook accessibility', () => {
  test.describe.configure({ mode: 'serial' });

  for (const story of [
    {
      id: 'foundation-placeholderpanel--default',
      name: 'placeholder panel',
      target: { role: 'region' as const, name: 'Shared UI placeholder' }
    },
    {
      id: 'enterprise-generated-design-scenarios--loading-owner',
      name: 'loading owner scenario',
      target: { role: 'main' as const, name: 'Enterprise design scenario' }
    },
    {
      id: 'enterprise-generated-design-scenarios--empty-editor',
      name: 'empty editor scenario',
      target: { role: 'main' as const, name: 'Enterprise design scenario' }
    },
    {
      id: 'enterprise-generated-design-scenarios--error-commenter',
      name: 'error commenter scenario',
      target: { role: 'main' as const, name: 'Enterprise design scenario' }
    },
    {
      id: 'enterprise-generated-design-scenarios--success-viewer',
      name: 'success viewer scenario',
      target: { role: 'main' as const, name: 'Enterprise design scenario' }
    }
  ]) {
    test(`the Storybook ${story.name} has no WCAG A or AA violations`, async ({ page }) => {
      await page.goto(`http://127.0.0.1:6007/iframe.html?id=${story.id}`);
      await expect(page.getByRole(story.target.role, { name: story.target.name })).toBeVisible();
      await expectNoAxeViolations(page, `Storybook ${story.name}`);
    });
  }
});

test('the built Electron desktop renderer has no WCAG A or AA violations', async ({ page }) => {
  await page.goto('http://127.0.0.1:4175');
  await expect(page.getByRole('main', { name: 'Selene designer workspace' })).toBeVisible();
  await expectNoAxeViolations(page, 'Electron desktop renderer');
});
