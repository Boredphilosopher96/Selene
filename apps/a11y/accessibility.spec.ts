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
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: [desktopMainEntry, `--user-data-dir=${userData}`]
  });
  try {
    const page = await application.firstWindow({ timeout: 5_000 });
    await expect(page.getByRole('main', { name: 'Selene desktop designer' })).toBeVisible({
      timeout: 5_000
    });
    await expectNoAxeViolations(page, 'Electron desktop window');
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
