import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exactBunStoreEntry, exactDependencyVersion } from './bun-store';
import { harnessIdentity, harnessPorts, harnessUrl } from '../../scripts/playwright-harness.mjs';

const ports = harnessPorts();

interface AxeViolation {
  readonly id: string;
  readonly impact: string | null;
  readonly nodes: readonly { readonly target: readonly string[] }[];
}

const desktopMainEntry = join(__dirname, '../desktop/out/main/index.js');
const rootPackageManifest = join(process.cwd(), 'package.json');
const desktopPackageManifest = join(process.cwd(), 'apps/desktop/package.json');

async function installedBunPackage(
  name: string,
  manifestPath: string,
  requiredFile: string
): Promise<string> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const version = exactDependencyVersion(manifest, name);
  const packageStore = join(process.cwd(), 'node_modules/.bun');
  const packages = await readdir(packageStore, { withFileTypes: true });
  const packageDirectory = exactBunStoreEntry(
    name,
    version,
    packages.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  );
  const resolved = join(packageStore, packageDirectory, 'node_modules', name);
  const resolvedManifest = JSON.parse(
    await readFile(join(resolved, 'package.json'), 'utf8')
  ) as unknown;
  const installed =
    typeof resolvedManifest === 'object' &&
    resolvedManifest !== null &&
    !Array.isArray(resolvedManifest)
      ? resolvedManifest
      : undefined;
  if (installed?.name !== name || installed.version !== version)
    throw new Error(
      `Bun package store entry ${packageDirectory} does not contain ${name}@${version}`
    );
  try {
    await readFile(join(resolved, requiredFile));
  } catch {
    throw new Error(
      `Bun package store entry ${packageDirectory} is missing required ${requiredFile}`
    );
  }
  return resolved;
}

async function installedAxeSource(): Promise<string> {
  return readFile(
    join(await installedBunPackage('axe-core', rootPackageManifest, 'axe.min.js'), 'axe.min.js'),
    'utf8'
  );
}

async function electronExecutable(): Promise<string> {
  const electronDirectory = await installedBunPackage(
    'electron',
    desktopPackageManifest,
    'path.txt'
  );
  const executable = (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim();
  return join(electronDirectory, 'dist', executable);
}

async function closeElectron(
  application: Awaited<ReturnType<typeof electron.launch>>
): Promise<void> {
  const closed = application.waitForEvent('close', { timeout: 2_000 });
  try {
    await application.evaluate(({ app }) => {
      app.quit();
      return true;
    });
    await closed;
  } catch {
    const process = application.process();
    if (process.exitCode === null) process.kill('SIGKILL');
    await application.waitForEvent('close', { timeout: 2_000 });
  }
}

async function ensureAxe(page: Page) {
  const hasAxe = await page.evaluate(() => {
    const axe = (window as typeof window & { axe?: typeof import('axe-core') }).axe;
    return typeof axe?.run === 'function';
  });
  if (!hasAxe) await page.addScriptTag({ content: await installedAxeSource() });
}

async function runAxe(page: Page): Promise<AxeViolation[]> {
  return page.evaluate(async () => {
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
}

async function expectNoAxeViolations(page: Page, name: string) {
  await ensureAxe(page);
  const violations = await runAxe(page);
  expect(violations, `${name} axe violations: ${formatViolations(violations)}`).toEqual([]);
}

async function waitForStorybookStory(page: Page, storyId: string): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-selene-story-ready', storyId);
}

async function focusWithKeyboard(
  page: Page,
  target: ReturnType<Page['locator']>,
  remainingTabs = 30,
  key: 'Tab' | 'Shift+Tab' = 'Tab'
): Promise<void> {
  if (await target.evaluate((element) => document.activeElement === element)) return;
  if (remainingTabs === 0)
    throw new Error(`Could not reach ${await target.getAttribute('aria-label')} using only Tab.`);
  await page.keyboard.press(key);
  await focusWithKeyboard(page, target, remainingTabs - 1, key);
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

async function expectKeyboardFocusSequence(
  page: Page,
  controls: readonly ReturnType<Page['locator']>[],
  index = 0
): Promise<void> {
  const control = controls[index];
  if (control === undefined) return;
  await expectVisibleFocus(control);
  if (index + 1 < controls.length) {
    await page.keyboard.press('Tab');
    await expectKeyboardFocusSequence(page, controls, index + 1);
  }
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
  await page.goto(harnessUrl(ports.accessibilityWeb));
  await expect(page.getByRole('main', { name: 'Selene designer workspace' })).toBeVisible();
  await expectNoAxeViolations(page, 'browser prototype');
});

test('the browser prototype supports its primary review workflow using only the keyboard', async ({
  page
}) => {
  await page.goto(harnessUrl(ports.accessibilityWeb));

  const createProject = page.getByRole('button', { name: 'Create project' });
  await focusWithKeyboard(page, createProject);
  await expectVisibleFocus(createProject);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status', { name: 'Workspace status' })).toHaveText(
    'Created a fresh local Northstar project.'
  );

  const screen = page.getByLabel('Navigate screen');
  await focusWithKeyboard(page, screen);
  await expectVisibleFocus(screen);
  await page.keyboard.press('o');
  await page.keyboard.press('Tab');
  await expect(screen).toHaveValue('orders');
  await expect(page.getByLabel('Live React preview')).toContainText('Orders');
  await expect(page.getByRole('status', { name: 'Workspace status' })).toHaveText(
    'Navigated the live preview.'
  );

  const ordersTitle = page.locator('[data-selene-node-id="orders.title"]');
  await focusWithKeyboard(page, ordersTitle, 30, 'Shift+Tab');
  await expectVisibleFocus(ordersTitle);
  await page.keyboard.press('Enter');
  await expect(page.getByText('orders.title', { exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Workspace status' })).toHaveText(
    'Selected orders.title.'
  );

  const comment = page.getByLabel('Comment for selected node');
  await focusWithKeyboard(page, comment);
  await expectVisibleFocus(comment);
  await page.keyboard.type('Clarify the keyboard review path.');

  const addComment = page.getByRole('button', { name: 'Add comment' });
  await focusWithKeyboard(page, addComment);
  await expectVisibleFocus(addComment);
  await page.keyboard.press('Enter');
  await expect(page.getByText('Clarify the keyboard review path.')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Workspace status' })).toHaveText(
    'Added a node-level comment.'
  );
});

test('the Storybook foundation exposes real keyboard focus-visible treatment', async ({ page }) => {
  const storyId = 'foundation-primitives--default';
  await page.goto(`${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=${storyId}`);
  await waitForStorybookStory(page, storyId);

  const controls = [
    page.getByRole('button', { name: 'Save changes' }),
    page.getByRole('button', { name: 'Cancel' }),
    page.getByRole('button', { name: 'Remove' }),
    page.getByRole('button', { name: 'Add collaborator' }),
    page.getByRole('button', { name: 'Dismiss notification' }),
    page.getByRole('textbox', { name: 'Project name' })
  ];

  await focusWithKeyboard(page, controls[0]);
  await expectKeyboardFocusSequence(page, controls);

  await page.goto(
    `${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=foundation-primitives--loading-action`
  );
  await waitForStorybookStory(page, 'foundation-primitives--loading-action');
  const loadingAction = page.getByRole('button', { name: 'Saving changes' });
  await expect(loadingAction).toBeDisabled();
  await expect(loadingAction).toHaveAttribute('aria-busy', 'true');
});

test('the Storybook foundation applies compact, reduced-motion, and responsive tokens', async ({
  page
}) => {
  await page.goto(
    `${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=foundation-primitives--compact-density`
  );
  await waitForStorybookStory(page, 'foundation-primitives--compact-density');
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCSS('min-height', '34px');

  await page.goto(
    `${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=foundation-primitives--reduced-motion`
  );
  await waitForStorybookStory(page, 'foundation-primitives--reduced-motion');
  const motion = await page.getByRole('button', { name: 'Save changes' }).evaluate((element) => {
    const style = getComputedStyle(element);
    return style.transitionDuration;
  });
  expect(motion.split(',').map((duration) => duration.trim())).toEqual([
    '0s',
    '0s',
    '0s',
    '0s',
    '0s'
  ]);

  await page.setViewportSize({ width: 360, height: 700 });
  await page.goto(
    `${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=foundation-primitives--compact-density`
  );
  await waitForStorybookStory(page, 'foundation-primitives--compact-density');
  const cards = page.locator('.sl-foundation__grid > .sl-card');
  const actionCard = await cards.nth(0).boundingBox();
  const fieldCard = await cards.nth(1).boundingBox();
  expect(actionCard).not.toBeNull();
  expect(fieldCard).not.toBeNull();
  expect(fieldCard?.y).toBeGreaterThan(actionCard?.y ?? Number.POSITIVE_INFINITY);

  await page.goto(
    `${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=foundation-workspace-primitives--reduced-motion`
  );
  await waitForStorybookStory(page, 'foundation-workspace-primitives--reduced-motion');
  const workspaceMotion = await page
    .getByRole('button', { name: 'Saving canvas' })
    .evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(workspaceMotion.split(',').map((duration) => duration.trim())).toEqual([
    '0s',
    '0s',
    '0s',
    '0s',
    '0s'
  ]);
});

test('workspace primitives enforce keyboard, modal, and popover focus contracts', async ({
  page
}) => {
  const storyId = 'foundation-workspace-primitives--interaction';
  await page.goto(`${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=${storyId}`);
  await waitForStorybookStory(page, storyId);
  await expect(page.locator('[data-overlay-portal-host="true"]')).toHaveCount(0);
  const layers = page.getByRole('tab', { name: 'Layers', exact: true });
  const assets = page.getByRole('tab', { name: 'Assets', exact: true });
  await layers.focus();
  await expect(layers).toHaveAttribute('tabindex', '0');
  const panelId = await layers.getAttribute('aria-controls');
  await expect(page.locator(`#${panelId ?? ''}`)).toHaveAttribute(
    'aria-labelledby',
    await layers.getAttribute('id')
  );
  await page.keyboard.press('ArrowRight');
  await expect(assets).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Comments' })).toBeFocused();
  await page.getByRole('tab', { name: 'Details' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('tab', { name: 'Tokens' })).toBeFocused();

  const design = page.getByRole('button', { name: 'Design', exact: true });
  const prototype = page.getByRole('button', { name: 'Prototype', exact: true });
  await design.focus();
  await page.keyboard.press('ArrowRight');
  await expect(prototype).toBeFocused();
  await expect(prototype).toHaveAttribute('aria-pressed', 'true');

  const declinedLayers = page.getByRole('tab', { name: 'Declined layers' });
  const declinedAssets = page.getByRole('tab', { name: 'Declined assets' });
  await declinedLayers.focus();
  await page.keyboard.press('ArrowRight');
  await expect(declinedLayers).toBeFocused();
  await expect(declinedLayers).toHaveAttribute('aria-selected', 'true');
  await expect(declinedAssets).toHaveAttribute('aria-selected', 'false');

  const declinedDesign = page.getByRole('button', { name: 'Declined design' });
  const declinedPrototype = page.getByRole('button', { name: 'Declined prototype' });
  await declinedDesign.focus();
  await page.keyboard.press('ArrowRight');
  await expect(declinedDesign).toBeFocused();
  await expect(declinedDesign).toHaveAttribute('aria-pressed', 'true');
  await expect(declinedPrototype).toHaveAttribute('aria-pressed', 'false');

  const delayedDesign = page.getByRole('button', { name: 'Delayed design' });
  const delayedPrototype = page.getByRole('button', { name: 'Delayed prototype' });
  await delayedDesign.focus();
  await page.keyboard.press('ArrowRight');
  await expect(delayedDesign).toBeFocused();
  await expect(delayedPrototype).toHaveAttribute('aria-pressed', 'false');
  await expect(delayedPrototype).toBeFocused({ timeout: 500 });
  await expect(delayedPrototype).toHaveAttribute('aria-pressed', 'true');

  const delayedClose = page.getByRole('button', { name: 'Delayed close help' });
  await delayedClose.click();
  const delayedCloseDialog = page.getByRole('dialog', { name: 'Delayed close details' });
  await expect(delayedCloseDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(delayedCloseDialog).toBeVisible();
  await expect(delayedCloseDialog).toBeHidden({ timeout: 500 });
  await expect(delayedClose).toBeFocused();

  const help = page.getByRole('button', { name: 'Canvas help' });
  await help.click();
  await expect(page.getByRole('dialog', { name: 'Canvas help details' })).toBeVisible();
  await help.focus();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Canvas help details' })).toBeHidden();
  await expect(help).toBeFocused();
  await expect(page.locator('[data-overlay-portal-host="true"]')).toHaveCount(0);

  await help.click();
  const stackedOuter = page.getByRole('dialog', { name: 'Canvas help details' });
  await expect(stackedOuter).toBeVisible();
  await stackedOuter.getByRole('button', { name: 'Open nested help' }).click();
  const stackedInner = page.getByRole('dialog', { name: 'Nested help details' });
  await expect(stackedInner).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stackedInner).toBeHidden();
  await expect(stackedOuter).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stackedOuter).toBeHidden();
  await expect(help).toBeFocused();

  const controlled = page.getByRole('button', { name: 'Controlled help' });
  await controlled.click();
  const controlledDialog = page.getByRole('dialog', { name: 'Controlled help details' });
  await expect(controlledDialog).toBeVisible();
  await controlledDialog.getByRole('button', { name: 'Replace controlled callback' }).click();
  await page.keyboard.press('Escape');
  await expect(controlledDialog).toBeHidden();
  await expect(page.locator('[data-controlled-event]')).toHaveAttribute(
    'data-controlled-event',
    'Callback 1: closed'
  );
  await expect(controlled).toBeFocused();

  const declined = page.getByRole('button', { name: 'Declined help' });
  await declined.click();
  await expect(declined).toHaveAttribute('aria-expanded', 'false');

  await help.click();
  const helpContent = page.getByRole('dialog', { name: 'Canvas help details' });
  await expect(helpContent).toBeVisible();
  const initialTop = await helpContent.evaluate((element) =>
    element.style.getPropertyValue('--sl-popover-top')
  );
  await page.evaluate(() => {
    document.body.style.minHeight = '2000px';
    window.scrollTo(0, 80);
  });
  await expect
    .poll(() =>
      helpContent.evaluate((element) => element.style.getPropertyValue('--sl-popover-top'))
    )
    .not.toBe(initialTop);
  await page.evaluate(() => window.scrollTo(0, 0));
  const topBeforeResize = await helpContent.boundingBox();
  await help.evaluate((element) => {
    element.style.height = '5rem';
  });
  await expect
    .poll(async () => (await helpContent.boundingBox())?.y)
    .toBeGreaterThan(topBeforeResize?.y ?? 0);
  await helpContent.evaluate((element) => {
    const oversized = document.createElement('div');
    oversized.style.cssText = 'width: 200vw; height: 200vh';
    element.append(oversized);
  });
  await expect
    .poll(() =>
      helpContent.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width <= window.innerWidth - 16 &&
          box.height <= window.innerHeight - 16 &&
          element.scrollWidth > element.clientWidth &&
          element.scrollHeight > element.clientHeight &&
          getComputedStyle(element).overflow === 'auto'
        );
      })
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Outside control' }).click();
  await expect(page.getByRole('button', { name: 'Outside control' })).toBeFocused();

  const share = page.getByRole('button', { name: 'Share workspace' });
  await share.click();
  const outer = page.getByRole('dialog', { name: 'Share workspace' });
  await expect(outer.getByRole('button', { name: 'Continue' })).toBeFocused();
  await page
    .locator('body')
    .evaluate(() =>
      (
        document.body.querySelector(
          'button[aria-label="Close sharing dialog"]'
        ) as HTMLElement | null
      )?.focus()
    );
  await page
    .locator('body')
    .evaluate(() => (document.querySelector('[role="tab"]') as HTMLElement | null)?.focus());
  await expect(outer.getByRole('button', { name: 'Close sharing dialog' })).toBeFocused();
  await outer.getByRole('button', { name: 'Open confirmation' }).click();
  const nested = page.getByRole('dialog', { name: 'Confirm sharing' });
  await expect(nested).toBeVisible();
  await expect(page.locator('dialog').filter({ hasText: 'Share workspace' })).toHaveAttribute(
    'aria-hidden',
    'true'
  );
  expect(await nested.evaluate((element) => element.closest('[aria-hidden="true"]') === null)).toBe(
    true
  );
  await expectNoAxeViolations(page, 'Storybook nested dialogs');
  await page.keyboard.press('Escape');
  await expect(nested).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(outer).toBeHidden();
  await expect(share).toBeFocused();
});

test('workspace overlay portal hosts preserve isolated computed tokens outside clipped canvases', async ({
  page
}) => {
  const storyId = 'foundation-workspace-primitives--overlays';
  await page.goto(`${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=${storyId}`);
  await waitForStorybookStory(page, storyId);
  await expect(page.getByRole('main', { name: 'Workspace overlay showcase' })).toBeVisible();
  const dark = page.getByRole('dialog', { name: 'Dark canvas details' });
  const contrast = page.getByRole('dialog', { name: 'High contrast details' });
  await expect(dark).toBeVisible();
  await expect(contrast).toBeVisible();
  await expect(page.locator('[data-overlay-portal-host="true"]')).toHaveCount(1);
  expect(
    await dark.evaluate((element) => element.closest('.sl-overlay-showcase__canvas') === null)
  ).toBe(true);
  expect(
    await dark.evaluate((element) => {
      const host = element.closest<HTMLElement>('[data-overlay-portal="true"]');
      return {
        motion: getComputedStyle(host ?? element)
          .getPropertyValue('--sl-transition-fast')
          .trim(),
        surface: getComputedStyle(host ?? element)
          .getPropertyValue('--sl-color-surface')
          .trim(),
        theme: host?.dataset.theme
      };
    })
  ).toEqual({ motion: '140ms ease', surface: '#1f2937', theme: 'dark' });
  expect(
    await contrast.evaluate((element) => {
      const host = element.closest<HTMLElement>('[data-overlay-portal="true"]');
      return {
        contrast: host?.dataset.contrast,
        density: host?.dataset.density,
        height: getComputedStyle(host ?? element)
          .getPropertyValue('--sl-control-height')
          .trim(),
        motion: getComputedStyle(host ?? element)
          .getPropertyValue('--sl-transition-fast')
          .trim()
      };
    })
  ).toEqual({ contrast: 'more', density: 'compact', height: '2.125rem', motion: '0ms linear' });
  await expectNoAxeViolations(page, 'Storybook isolated overlay portals');
});

test('workspace overlays keep their shared host inside the source iframe document', async ({
  page
}) => {
  const storyId = 'foundation-workspace-primitives--cross-document';
  await page.goto(`${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=${storyId}`);
  await waitForStorybookStory(page, storyId);
  const frame = page.frameLocator('iframe[title="Workspace overlay document"]');
  await expect(frame.getByRole('button', { name: 'Cross-document help' })).toBeVisible();
  await expect(frame.getByRole('dialog', { name: 'Cross-document details' })).toBeVisible();
  await expect(frame.locator('[data-overlay-portal-host="true"]')).toHaveCount(1);
  await expect(page.locator('[data-overlay-portal-host="true"]')).toHaveCount(0);
});

test('workspace modal lifecycle clears overlay history across unmount and remount', async ({
  page
}) => {
  const storyId = 'foundation-workspace-primitives--modal';
  await page.goto(`${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=${storyId}`);
  await waitForStorybookStory(page, storyId);
  const modal = page.getByRole('dialog', { name: 'Modal lifecycle proof' });
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.locator('[data-overlay-portal-host="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reopen modal' }).click();
  await expect(modal).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await page.getByRole('button', { name: 'Reopen modal' }).click();
  await expect(modal).toBeVisible();
  await page.getByRole('button', { name: 'Unmount modal' }).click();
  await expect(modal).toBeHidden();
  await expect(page.locator('[data-overlay-portal-host="true"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mount modal' }).click();
  await expect(modal).toBeVisible();
  await expectNoAxeViolations(page, 'Storybook remounted modal lifecycle');
});

test.describe('Storybook accessibility', () => {
  test.describe.configure({ mode: 'serial' });

  for (const story of [
    {
      id: 'foundation-primitives--default',
      name: 'foundation primitives',
      target: { role: 'main' as const, name: 'Selene UI foundation' }
    },
    {
      id: 'foundation-primitives--dark-theme',
      name: 'foundation dark theme',
      target: { role: 'main' as const, name: 'Selene UI foundation' }
    },
    {
      id: 'foundation-primitives--high-contrast',
      name: 'foundation high contrast',
      target: { role: 'main' as const, name: 'Selene UI foundation' }
    },
    {
      id: 'foundation-primitives--validation-error',
      name: 'foundation validation error',
      target: { role: 'main' as const, name: 'Selene UI validation error' }
    },
    {
      id: 'foundation-primitives--loading-action',
      name: 'foundation loading action',
      target: { role: 'main' as const, name: 'Selene UI loading action' }
    },
    {
      id: 'foundation-primitives--empty-state',
      name: 'foundation empty state',
      target: { role: 'main' as const, name: 'Selene UI empty state' }
    },
    {
      id: 'foundation-primitives--offline-state',
      name: 'foundation offline state',
      target: { role: 'main' as const, name: 'Selene UI offline state' }
    },
    {
      id: 'foundation-primitives--permission-denied',
      name: 'foundation permission state',
      target: { role: 'main' as const, name: 'Selene UI permission state' }
    },
    {
      id: 'foundation-primitives--compact-density',
      name: 'foundation compact density',
      target: { role: 'main' as const, name: 'Selene UI foundation' }
    },
    {
      id: 'foundation-primitives--reduced-motion',
      name: 'foundation reduced motion',
      target: { role: 'main' as const, name: 'Selene UI foundation' }
    },
    {
      id: 'foundation-workspace-primitives--states',
      name: 'workspace primitive states',
      target: { role: 'main' as const, name: 'Workspace primitive showcase' }
    },
    {
      id: 'foundation-workspace-primitives--dark',
      name: 'workspace primitive dark',
      target: { role: 'main' as const, name: 'Workspace primitive showcase' }
    },
    {
      id: 'foundation-workspace-primitives--high-contrast',
      name: 'workspace primitive high contrast',
      target: { role: 'main' as const, name: 'Workspace primitive showcase' }
    },
    {
      id: 'foundation-workspace-primitives--modal',
      name: 'workspace primitive modal',
      target: { role: 'main' as const, name: 'Workspace modal showcase' }
    },
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
      await page.goto(`${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=${story.id}`);
      await waitForStorybookStory(page, story.id);
      await expect(page.getByRole(story.target.role, { name: story.target.name })).toBeVisible();
      await expectNoAxeViolations(page, `Storybook ${story.name}`);
    });
  }
});

test('the Storybook foundation uses forced-colors tokens without accessibility violations', async ({
  page
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  const storyId = 'foundation-primitives--default';
  await page.goto(`${harnessUrl(ports.accessibilityStorybook)}/iframe.html?id=${storyId}`);
  await waitForStorybookStory(page, storyId);
  await expect(page.getByRole('main', { name: 'Selene UI foundation' })).toBeVisible();
  await expectNoAxeViolations(page, 'Storybook foundation forced colors');
});

test('the built Electron desktop window has no WCAG A or AA violations', async () => {
  const userData = await mkdtemp(join(tmpdir(), `selene-${harnessIdentity()}-a11y-electron-`));
  const diagnostics: string[] = [];
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: [desktopMainEntry, `--user-data-dir=${userData}`]
  });
  try {
    const page = await application.firstWindow({ timeout: 5_000 });
    const recordDiagnostic = (message: string) => {
      if (diagnostics.length < 16) diagnostics.push(message.slice(0, 1_024));
    };
    page.on('console', (message) => {
      if (message.type() === 'error')
        recordDiagnostic(`console ${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', (error) => recordDiagnostic(`pageerror: ${error.message}`));
    page.on('requestfailed', (request) =>
      recordDiagnostic(
        `requestfailed ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`
      )
    );
    await page.waitForURL(
      (url) =>
        url.protocol === 'file:' && url.pathname.endsWith('/apps/desktop/out/renderer/index.html'),
      { timeout: 5_000 }
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              typeof window.selene?.designer?.snapshot === 'function' &&
              typeof window.selene?.preview?.build === 'function'
          ),
        { message: 'the versioned Electron preload API is ready', timeout: 5_000 }
      )
      .toBe(true);
    const initialSnapshot = await page.evaluate(async () => {
      try {
        const snapshot = await window.selene.designer.snapshot();
        return { status: 'ready' as const, apiVersion: snapshot.apiVersion };
      } catch (error) {
        return {
          status: 'error' as const,
          message: error instanceof Error ? error.message : String(error)
        };
      }
    });
    expect(initialSnapshot, 'the main-frame designer snapshot contract is ready').toMatchObject({
      status: 'ready'
    });
    const designer = page.getByRole('main', { name: 'Selene desktop designer' });
    await expect
      .poll(
        async () => {
          if (await designer.isVisible()) return 'ready';
          const body = (await page.locator('body').innerText()).slice(0, 512);
          return `not-ready: ${body}\nrenderer diagnostics:\n${diagnostics.join('\n') || '(none)'}`;
        },
        { message: 'the desktop designer shell is ready', timeout: 5_000 }
      )
      .toBe('ready');
    await expectNoAxeViolations(page, 'Electron desktop window');
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
