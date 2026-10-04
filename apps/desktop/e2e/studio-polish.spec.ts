import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { assertNativeElectronTestAllowed } from '../../../scripts/playwright-harness.mjs';

test.beforeAll(() => assertNativeElectronTestAllowed());
const require = createRequire(import.meta.url);
const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));

async function openStudio() {
  const directory = dirname(require.resolve('electron'));
  const executable = (await readFile(join(directory, 'path.txt'), 'utf8')).trim();
  const userData = await mkdtemp(join(tmpdir(), 'selene-studio-polish-'));
  const application = await electron.launch({
    executablePath: join(directory, 'dist', executable),
    args: [mainEntry, `--user-data-dir=${userData}`]
  });
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: 'Start a local project' })).toBeVisible();
  return { application, page, userData };
}

async function closeStudio(studio: Awaited<ReturnType<typeof openStudio>>) {
  await studio.application.close();
  await rm(studio.userData, { recursive: true, force: true });
}

async function expectAccessible(page: Page) {
  await page.addScriptTag({
    content: await readFile(require.resolve('axe-core/axe.min.js'), 'utf8')
  });
  const violations = await page.evaluate(async () => {
    const axe = (window as typeof window & { axe: typeof import('axe-core') }).axe;
    const result = await axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }
    });
    return result.violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target, any }) => ({
        target,
        checks: any.map(({ message }) => message)
      }))
    }));
  });
  expect(violations).toEqual([]);
}

async function expectContained(page: Page, selector: string, withinViewportBlock = true) {
  const geometry = await page.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewport: window.innerWidth,
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: window.innerHeight,
      horizontalOverflow: element.scrollWidth - element.clientWidth
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.horizontalOverflow).toBeLessThanOrEqual(1);
  if (withinViewportBlock) {
    expect(geometry.top).toBeGreaterThanOrEqual(-1);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight + 1);
  }
}

async function captureHeaderGeometry(page: Page) {
  return page.locator('.workspace-topbar').evaluate((header) => {
    const bounds = header.getBoundingClientRect();
    const buttons = Array.from(header.querySelectorAll('button')).map((button) => ({
      label: button.textContent?.trim(),
      rect: button.getBoundingClientRect().toJSON(),
      clientWidth: button.clientWidth,
      clientHeight: button.clientHeight,
      scrollWidth: button.scrollWidth,
      scrollHeight: button.scrollHeight
    }));
    return {
      bounds: bounds.toJSON(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        devicePixelRatio: window.devicePixelRatio
      },
      buttons,
      overflow: buttons.flatMap(({ label, rect }) => {
        if (rect.width === 0 || rect.height === 0) return [];
        return rect.left < bounds.left ||
          rect.right > bounds.right + 1 ||
          rect.top < bounds.top ||
          rect.bottom > bounds.bottom + 1
          ? [label]
          : [];
      })
    };
  });
}

test('studio launchpad supports keyboard templates, blank-name refusal and a long project name', async () => {
  const testInfo = test.info();
  const studio = await openStudio();
  try {
    const { page } = studio;
    await page.setViewportSize({ width: 1180, height: 812 });
    await expect(page.getByText('Your next idea starts here', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('main', { name: 'Selene project launchpad' }).getByRole('status')
    ).toHaveCount(1);
    const name = page.getByRole('textbox', { name: 'Project name' });
    const create = page.getByRole('button', { name: 'Create project', exact: true });
    await name.fill('   ');
    await expect(create).toBeDisabled();
    const dashboard = page.getByRole('radio', { name: /Dashboard/ });
    await dashboard.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Review/ })).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('radio', { name: /Blank/ })).toBeChecked();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(dashboard).toBeChecked();
    await name.fill('Studio boundary ' + 'W'.repeat(104));
    await expectContained(page, '.project-launchpad--first-run', false);
    await create.scrollIntoViewIfNeeded();
    await expect(create).toBeInViewport();
    await page.setViewportSize({ width: 1180, height: 980 });
    await page.locator('.project-launchpad-shell').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: testInfo.outputPath('studio-launchpad-wide.png') });
    await expectAccessible(page);
    await page.locator('main').evaluate((element) => {
      element.dataset.theme = 'dark';
    });
    await expectAccessible(page);
    await page.screenshot({ path: testInfo.outputPath('studio-launchpad-dark.png') });
    await page.locator('main').evaluate((element) => {
      delete element.dataset.theme;
      element.dataset.contrast = 'more';
    });
    await expectAccessible(page);
    await page.locator('main').evaluate((element) => {
      delete element.dataset.contrast;
    });
    await name.press('Enter');
    await expect(page.getByRole('main', { name: 'Selene desktop designer' })).toBeVisible({
      timeout: 15_000
    });
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Studio boundary ' + 'W'.repeat(104), exact: true })
    ).toBeVisible();
    await expectContained(page, '.project-launchpad--header');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Project launchpad' })).not.toBeVisible();
  } finally {
    await closeStudio(studio);
  }
});

test('studio canvas keeps grouped tools, panel actions and save feedback reachable across rail and viewport sizes', async () => {
  const testInfo = test.info();
  const studio = await openStudio();
  try {
    const { page } = studio;
    await page.getByRole('textbox', { name: 'Project name' }).fill('Responsive studio');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(page.getByRole('main', { name: 'Selene desktop designer' })).toBeVisible({
      timeout: 15_000
    });
    await expect(page.locator('.canvas-workspace')).toBeVisible();
    await [1600, 1180, 1025, 1024, 768, 620, 390].reduce(async (previous, width) => {
      await previous;
      await page.setViewportSize({ width, height: 900 });
      const tools = page.getByRole('toolbar', { name: 'Canvas tools' });
      await expect(tools).toBeVisible();
      // Native window resizing and React/media-query projection settle on
      // paint frames, not merely when the viewport command is acknowledged.
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      });
      const headerGeometry = await captureHeaderGeometry(page);
      await testInfo.attach(`studio-header-geometry-${width}.json`, {
        body: JSON.stringify(headerGeometry, null, 2),
        contentType: 'application/json'
      });
      if (headerGeometry.overflow.length > 0)
        await page.screenshot({ path: testInfo.outputPath(`studio-header-overflow-${width}.png`) });
      // Preserve the original same-unit physical containment predicate.
      expect(headerGeometry.overflow).toEqual([]);
      await expectContained(page, '.canvas-workspace__toolbar');
      await expectContained(page, '.canvas-workspace__tools');
      await Promise.all(
        [
          'Design',
          'Components',
          'Present',
          'Connections',
          'Hand',
          'Fit all',
          'Reset',
          'Fit selection',
          'Selection',
          '@ Ask AI'
        ].map((name) => expect(tools.getByRole('button', { name, exact: true })).toBeVisible())
      );
      await expect(
        page.getByRole('button', { name: 'Open AI conversation', exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Open Dev Inspect', exact: true })
      ).toBeVisible();
      await expect(page.locator('.canvas-workspace__toolbar > output')).toBeVisible();
      await expectContained(page, '.canvas-workspace__toolbar > output');
      await page.screenshot({ path: testInfo.outputPath(`studio-canvas-${width}.png`) });
    }, Promise.resolve());
    // Simulate wider native glyph metrics within this disposable document,
    // without modifying system fonts. Wrapped chrome must grow intrinsically.
    await page.setViewportSize({ width: 768, height: 900 });
    const widerChrome = await page.addStyleTag({
      content:
        '.workspace-topbar button { font-family: monospace !important; font-size: 15px !important; }'
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const wrapped = await captureHeaderGeometry(page);
    await testInfo.attach('studio-header-wider-font-768.json', {
      body: JSON.stringify(wrapped, null, 2),
      contentType: 'application/json'
    });
    await page.screenshot({ path: testInfo.outputPath('studio-header-wider-font-768.png') });
    expect(wrapped.bounds.height).toBeGreaterThan(50);
    expect(wrapped.overflow).toEqual([]);
    expect(
      (await page.locator('.canvas-workspace .react-flow').boundingBox())?.height
    ).toBeGreaterThan(40);
    await page.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Compact inspector workspace', exact: true })
    ).toBeVisible();
    const overlay = await page.locator('.workspace-layout').evaluate((layout) => ({
      workspace: layout.getBoundingClientRect().toJSON(),
      drawer: layout.querySelector('.workspace-inspector-drawer')!.getBoundingClientRect().toJSON(),
      scrim: layout
        .querySelector('.workspace-inspector-drawer-scrim')!
        .getBoundingClientRect()
        .toJSON()
    }));
    await testInfo.attach('studio-header-expanded-inspector-768.json', {
      body: JSON.stringify(overlay, null, 2),
      contentType: 'application/json'
    });
    await page.screenshot({
      path: testInfo.outputPath('studio-header-expanded-inspector-768.png')
    });
    expect(overlay.drawer.top).toBe(overlay.workspace.top);
    expect(overlay.drawer.left).toBe(overlay.workspace.left);
    expect(overlay.drawer.right).toBe(overlay.workspace.right);
    expect(overlay.drawer.bottom).toBe(overlay.workspace.bottom);
    expect(overlay.scrim.top).toBe(overlay.workspace.top);
    expect(overlay.scrim.left).toBe(overlay.workspace.left);
    expect(overlay.scrim.right).toBe(overlay.workspace.right);
    expect(overlay.scrim.bottom).toBe(overlay.workspace.bottom);
    expect(overlay.drawer.top).toBeGreaterThanOrEqual(wrapped.bounds.bottom);
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('dialog', { name: 'Compact inspector workspace', exact: true })
    ).toBeHidden();
    // Recreate the former fixed-height constraint to prove this fixture
    // rejects the actual clipping, rather than merely exercising a resize.
    await page.locator('.workspace-topbar').evaluate((header) => {
      header.style.height = '50px';
    });
    const fixedHeight = await captureHeaderGeometry(page);
    expect(fixedHeight.overflow.length).toBeGreaterThan(0);
    await page.locator('.workspace-topbar').evaluate((header) => {
      header.style.removeProperty('height');
    });
    await widerChrome.evaluate((style) => style.remove());
    await page.setViewportSize({ width: 1180, height: 812 });
    await page.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
    const expectConversationHeader = async () => {
      const header = page.locator('.conversation-rail > .pane-toggle');
      await expect(header).toBeVisible();
      const geometry = await header.evaluate((element) => ({
        writingMode: getComputedStyle(element).writingMode,
        height: element.getBoundingClientRect().height
      }));
      expect(geometry.writingMode).toBe('horizontal-tb');
      expect(geometry.height).toBeGreaterThanOrEqual(32);
      expect(geometry.height).toBeLessThanOrEqual(40);
    };
    await expectConversationHeader();
    const leftResizer = page.getByRole('separator', { name: 'Resize AI conversation rail' });
    await leftResizer.focus();
    await leftResizer.press('ArrowRight', { noWaitAfter: true });
    await Array.from({ length: 8 }).reduce(async (previous) => {
      await previous;
      await page.keyboard.press('ArrowRight');
    }, Promise.resolve());
    await expect(leftResizer).toHaveAttribute('aria-valuenow', '340');
    await expectConversationHeader();
    await expectContained(page, '.canvas-workspace__toolbar');
    await expectAccessible(page);
    await page.screenshot({ path: testInfo.outputPath('studio-ai-conversation-wide.png') });
    await page.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    const rightResizer = page.getByRole('separator', { name: 'Resize inspector rail' });
    await rightResizer.focus();
    await rightResizer.press('ArrowLeft', { noWaitAfter: true });
    await Array.from({ length: 8 }).reduce(async (previous) => {
      await previous;
      await page.keyboard.press('ArrowLeft');
    }, Promise.resolve());
    await expect(rightResizer).toHaveAttribute('aria-valuenow', '340');
    await expectContained(page, '.canvas-workspace__toolbar');
    await page.getByRole('button', { name: 'Fit all', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('studio-inspector-wide.png') });
    await expectAccessible(page);
    await page.locator('main').evaluate((element) => {
      element.dataset.theme = 'dark';
    });
    await expectAccessible(page);
    await page.screenshot({ path: testInfo.outputPath('studio-inspector-dark.png') });
    await page.locator('main').evaluate((element) => {
      delete element.dataset.theme;
      element.dataset.contrast = 'more';
    });
    await expectAccessible(page);
    await page.screenshot({ path: testInfo.outputPath('studio-inspector-contrast.png') });
    await page.locator('main').evaluate((element) => {
      delete element.dataset.contrast;
    });
    await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 320 });
    await page.getByRole('button', { name: 'Operations', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Compact action menu' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Compact action menu' })).not.toBeVisible();
    await expectContained(page, '.canvas-workspace__toolbar');
    expect(
      await page
        .locator('.canvas-workspace .react-flow')
        .evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThan(40);
    await page.screenshot({ path: testInfo.outputPath('studio-short-390.png') });
    await page.setViewportSize({ width: 620, height: 360 });
    await expectContained(page, '.canvas-workspace__toolbar');
    expect(
      await page
        .locator('.canvas-workspace .react-flow')
        .evaluate((element) => element.getBoundingClientRect().height)
    ).toBeGreaterThan(40);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Inspect' })).toBeVisible();
    await expect(page.getByText('Explore the details', { exact: true })).toBeVisible();
    await expectContained(page, '.dev-inspector__empty');
    const search = page.getByRole('searchbox', { name: 'Search inspect context' });
    await search.fill('AI edit');
    await expect(page.getByText(/No inspect context matches/)).toBeVisible();
    await search.fill('No selection');
    await expect(page.getByText(/No inspect context matches/)).toBeVisible();
    await search.fill('no-such-context');
    await expect(page.getByText(/No inspect context matches/)).toBeVisible();
    await search.fill('');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tabpanel', { name: 'Inspect' })).not.toBeVisible();
    await page.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    await expect(search).toHaveValue('');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1180, height: 812 });
    const fit = page.getByRole('button', { name: 'Fit all', exact: true });
    await fit.focus();
    await fit.press('Enter');
    await expect(fit).toBeFocused();
    await expect(page.locator('.canvas-workspace__toolbar > output')).not.toHaveText('');
  } finally {
    await closeStudio(studio);
  }
});

test('presentation returns to a painted authoring artboard after Exit and Escape without manual Render', async () => {
  test.setTimeout(60_000);
  const studio = await openStudio();
  try {
    const { page } = studio;
    await page.getByRole('textbox', { name: 'Project name' }).fill('Presentation return');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const canvas = page.getByLabel('Design canvas', { exact: true });
    const prototype = page.frameLocator('iframe[title="Generated React preview frame"]');
    const heading = prototype.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible({ timeout: 15_000 });
    const initialHeading = await heading.innerText();
    const dashboard = prototype.getByRole('heading', { name: initialHeading, exact: true });
    const frame = page.locator('iframe[title="Generated React preview frame"]');
    const before = await page.evaluate(() => window.selene.designer.snapshot());
    const dismissAndVerify = async (dismissal: 'Exit' | 'Escape') => {
      await canvas.getByRole('button', { name: 'Present', exact: true }).click();
      const presentation = page.getByLabel('Prototype presentation', { exact: true });
      await expect(presentation).toBeVisible();
      await expect(dashboard).toBeVisible({ timeout: 15_000 });
      await expect(presentation.getByRole('button', { name: /Exit/ })).toBeEnabled();
      await expect(presentation.getByRole('button', { name: /Exit/ })).toBeFocused();
      const presentationUrl = await frame.getAttribute('src');
      if (dismissal === 'Exit') {
        await prototype.getByRole('button', { name: 'Open orders', exact: true }).click();
        await expect(heading).toHaveText(/Orders/);
        await prototype.locator('button[data-selene-action-port="back"]').click();
        await expect(dashboard).toBeVisible();
        await presentation.getByRole('button', { name: /Exit/ }).click();
      } else {
        await page.keyboard.press('Escape');
      }
      await expect(presentation).toBeHidden();
      await expect(canvas).toBeVisible();
      await expect(frame).not.toHaveAttribute('src', presentationUrl!);
      await expect(dashboard).toBeVisible({ timeout: 15_000 });
      await expect(prototype.locator('html')).toHaveAttribute(
        'data-selene-canvas-navigation',
        'design'
      );
      await page.screenshot({
        path: test.info().outputPath(`studio-presentation-return-${dismissal}.png`)
      });
      const snapshot = await page.evaluate(() => window.selene.designer.snapshot());
      expect(snapshot.source.revision.id).toBe(before.source.revision.id);
      expect(snapshot.editablePrototype.revision).toBe(before.editablePrototype.revision);
      expect(snapshot.editablePrototype.mode).toBe('edit');
      expect(snapshot.editablePrototype.runtime).toBeUndefined();
    };
    await dismissAndVerify('Exit');
    await dismissAndVerify('Escape');
    await canvas.getByRole('button', { name: 'Present', exact: true }).click();
    const presentation = page.getByLabel('Prototype presentation', { exact: true });
    await expect(dashboard).toBeVisible({ timeout: 15_000 });
    // Refuse only the post-commit preview build, not the durable edit-mode save.
    const refuseNextPreviewBuild = async () => {
      await studio.application.evaluate(({ ipcMain }) => {
        const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
        if (!(handlers instanceof Map))
          throw new Error('Electron invoke handler registry unavailable');
        const original: unknown = handlers.get('selene:preview-build');
        if (typeof original !== 'function')
          throw new Error('Canonical preview handler unavailable');
        ipcMain.removeHandler('selene:preview-build');
        ipcMain.handle('selene:preview-build', () => {
          ipcMain.removeHandler('selene:preview-build');
          ipcMain.handle('selene:preview-build', (...args) =>
            Reflect.apply(original, ipcMain, args)
          );
          throw new Error('Injected authoring presentation failure');
        });
        return true;
      });
    };
    await refuseNextPreviewBuild();
    await presentation.getByRole('button', { name: /Exit/ }).click();
    await expect(canvas).toBeVisible();
    await expect(canvas.locator('.canvas-workspace__toolbar > output')).toHaveText(
      'Editor restored; the preview could not refresh. Use Render to try again.'
    );
    const committed = await page.evaluate(() => window.selene.designer.snapshot());
    expect(committed.editablePrototype.mode).toBe('edit');
    expect(committed.editablePrototype.runtime).toBeUndefined();
    expect(committed.source.revision.id).toBe(before.source.revision.id);
    expect(committed.editablePrototype.revision).toBe(before.editablePrototype.revision);
    await page.getByRole('button', { name: 'Render', exact: true }).click();
    await expect(dashboard).toBeVisible({ timeout: 15_000 });
    await expect(prototype.locator('html')).toHaveAttribute(
      'data-selene-canvas-navigation',
      'design'
    );
    // A failed Present build also remounts the authoring owner. It must recover
    // automatically with a fresh authority, rather than strand the old URL.
    const beforeFailedPresent = await frame.getAttribute('src');
    await refuseNextPreviewBuild();
    await canvas.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(canvas).toBeVisible();
    await expect(frame).not.toHaveAttribute('src', beforeFailedPresent!);
    await expect(dashboard).toBeVisible({ timeout: 15_000 });
    const restored = await page.evaluate(() => window.selene.designer.snapshot());
    expect(restored.editablePrototype.mode).toBe('edit');
    expect(restored.editablePrototype.runtime).toBeUndefined();
    expect(restored.source.revision.id).toBe(before.source.revision.id);
    expect(restored.editablePrototype.revision).toBe(before.editablePrototype.revision);
    await canvas.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(presentation).toBeVisible();
    await expect(dashboard).toBeVisible({ timeout: 15_000 });
    await expect(presentation.getByRole('button', { name: /Exit/ })).toBeEnabled();
    await expect(presentation.getByRole('button', { name: /Exit/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(canvas).toBeVisible();
    await expect(dashboard).toBeVisible({ timeout: 15_000 });
    await page.setViewportSize({ width: 390, height: 320 });
    // Refuse the compensating host edit once as well. The UI must retain the
    // real run-mode owner and expose Exit as a retry, not imply saved edit.
    await refuseNextPreviewBuild();
    const refusePrototypeModes = async (modes: readonly ('run' | 'edit')[]) => {
      await studio.application.evaluate(({ ipcMain }, requestedModes) => {
        const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
        if (!(handlers instanceof Map))
          throw new Error('Electron invoke handler registry unavailable');
        const channel = 'selene:designer:set-prototype-mode';
        const original: unknown = handlers.get(channel);
        if (typeof original !== 'function') throw new Error('Prototype mode handler unavailable');
        const remaining = requestedModes.slice();
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (...args) => {
          if (args[1] !== remaining[0]) return Reflect.apply(original, ipcMain, args);
          remaining.shift();
          if (remaining.length === 0) {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, (...retryArgs) => Reflect.apply(original, ipcMain, retryArgs));
          }
          throw new Error('Injected prototype mode refusal');
        });
        return true;
      }, modes.slice());
    };
    await refusePrototypeModes(['edit']);
    await canvas.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(presentation.locator('.canvas-presentation__status')).toHaveText(
      'Presentation could not start. Return to the editor with Exit to retry.'
    );
    await expect(canvas).toHaveCount(0);
    await expectContained(page, '.canvas-presentation__status');
    await expectAccessible(page);
    expect(
      (await page.evaluate(() => window.selene.designer.snapshot())).editablePrototype.mode
    ).toBe('run');
    await expect(presentation.getByRole('button', { name: /Exit/ })).toBeEnabled();
    await expect(presentation.getByRole('button', { name: /Exit/ })).toBeFocused();
    await presentation.getByRole('button', { name: /Exit/ }).click();
    await expect(canvas).toBeVisible();
    await expect(dashboard).toBeVisible({ timeout: 15_000 });
    const retried = await page.evaluate(() => window.selene.designer.snapshot());
    expect(retried.editablePrototype.mode).toBe('edit');
    expect(retried.editablePrototype.runtime).toBeUndefined();
    expect(retried.source.revision.id).toBe(before.source.revision.id);
    expect(retried.editablePrototype.revision).toBe(before.editablePrototype.revision);
    // Both mode transitions may refuse before any host commit. Dismissing the
    // retained presentation still needs a new authoring iframe authority.
    await refusePrototypeModes(['run', 'edit']);
    await canvas.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(presentation.locator('.canvas-presentation__status')).toHaveText(
      'Presentation could not start. Return to the editor with Exit to retry.'
    );
    expect(
      (await page.evaluate(() => window.selene.designer.snapshot())).editablePrototype.mode
    ).toBe('edit');
    const refusedModeUrl = await frame.getAttribute('src');
    await presentation.getByRole('button', { name: /Exit/ }).click();
    await expect(canvas).toBeVisible();
    await expect(frame).not.toHaveAttribute('src', refusedModeUrl!);
    await expect(dashboard).toBeVisible({ timeout: 15_000 });
  } finally {
    await closeStudio(studio);
  }
});
