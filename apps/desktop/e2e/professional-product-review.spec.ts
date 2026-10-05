import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { assertNativeElectronTestAllowed } from '../../../scripts/playwright-harness.mjs';

test.beforeAll(() => assertNativeElectronTestAllowed());
const require = createRequire(import.meta.url);
const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const rendererDirectory = fileURLToPath(new URL('../out/renderer/', import.meta.url));
const projectPresentationFailure =
  'Your project is saved, but its design tools could not open. Open it from Recent projects to retry.';

async function openStudio() {
  const directory = dirname(require.resolve('electron'));
  const executable = (await readFile(join(directory, 'path.txt'), 'utf8')).trim();
  const userData = await mkdtemp(join(tmpdir(), 'selene-product-review-'));
  const application = await electron.launch({
    executablePath: join(directory, 'dist', executable),
    args: [mainEntry, `--user-data-dir=${userData}`]
  });
  const page = await application.firstWindow();
  await expect(
    page.getByRole('main', { name: 'Selene project launchpad', exact: true })
  ).toBeVisible();
  return { application, page, userData };
}

async function closeStudio(studio: Awaited<ReturnType<typeof openStudio>>) {
  try {
    await studio.application.close();
  } finally {
    await rm(studio.userData, { recursive: true, force: true });
  }
}

/** Fail the real host build once; no fabricated preview or authority enters the renderer. */
async function refuseNextPreviewBuild(application: ElectronApplication) {
  await application.evaluate(({ ipcMain }) => {
    const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
    if (!(handlers instanceof Map)) throw new Error('Electron invoke handlers are unavailable.');
    const original: unknown = handlers.get('selene:preview-build');
    if (typeof original !== 'function')
      throw new Error('Canonical preview handler is unavailable.');
    ipcMain.removeHandler('selene:preview-build');
    ipcMain.handle('selene:preview-build', () => {
      ipcMain.removeHandler('selene:preview-build');
      ipcMain.handle('selene:preview-build', (...args) => Reflect.apply(original, ipcMain, args));
      throw new Error('Injected product-review build failure');
    });
    return true;
  });
}

const pendingPreviewGateKey = 'seleneProductReviewPendingPreviewGate';

/** Hold one real invocation without issuing a build, source, or frame authority. */
async function holdNextPreviewBuild(application: ElectronApplication) {
  await application.evaluate(({ ipcMain }, key) => {
    const handlers: unknown = Reflect.get(ipcMain, '_invokeHandlers');
    if (!(handlers instanceof Map)) throw new Error('Electron invoke handlers are unavailable.');
    const originalHandler: unknown = handlers.get('selene:preview-build');
    if (typeof originalHandler !== 'function')
      throw new Error('Canonical preview handler is unavailable.');
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      ipcMain.removeHandler('selene:preview-build');
      ipcMain.handle('selene:preview-build', (...args) =>
        Reflect.apply(originalHandler, ipcMain, args)
      );
    };
    const gate = {
      requested: false,
      completed: false,
      outcome: 'pending',
      release: () => release?.(),
      restore
    };
    Reflect.set(globalThis, key, gate);
    ipcMain.removeHandler('selene:preview-build');
    ipcMain.handle('selene:preview-build', async (...args) => {
      restore();
      gate.requested = true;
      try {
        await pending;
        const result = await Reflect.apply(originalHandler, ipcMain, args);
        gate.outcome = 'fulfilled';
        return result;
      } catch (error) {
        gate.outcome = 'rejected';
        throw error;
      } finally {
        gate.completed = true;
      }
    });
  }, pendingPreviewGateKey);
}

async function readPreviewGate(application: ElectronApplication) {
  return application.evaluate((_electron, key) => {
    const gate = Reflect.get(globalThis, key);
    return gate
      ? { requested: gate.requested, completed: gate.completed, outcome: gate.outcome }
      : undefined;
  }, pendingPreviewGateKey);
}

async function releasePreviewGate(application: ElectronApplication, restore = false) {
  await application.evaluate(
    (_electron, { key, restore: clear }) => {
      const gate = Reflect.get(globalThis, key);
      if (!gate) return;
      if (clear) gate.restore();
      gate.release();
      if (clear) Reflect.deleteProperty(globalThis, key);
    },
    { key: pendingPreviewGateKey, restore }
  );
}

test('the actionable first-run launchpad loads only its bounded initial resources', async () => {
  const studio = await openStudio();
  try {
    const { page } = studio;
    await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled();
    // Native file-backed Electron does not expose these loads in ResourceTiming.
    // Capture the actual renderer requests over a launchpad reload instead. This
    // is a code-graph byte budget, never a cold-start latency measurement.
    const network = await page.context().newCDPSession(page);
    const requested = new Map<string, { name: string; type: string }>();
    network.on('Network.requestWillBeSent', ({ request, type }) => {
      if (/\.(?:js|css)$/u.test(new URL(request.url).pathname))
        requested.set(request.url, { name: request.url, type: type ?? 'Unknown' });
    });
    await network.send('Network.enable');
    await page.reload();
    await expect(
      page.getByRole('main', { name: 'Selene project launchpad', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await network.send('Network.disable');
    await network.detach();
    const resources = [...requested.values()];
    const emitted = await Promise.all(
      resources.map(async (resource) => {
        const url = new URL(resource.name);
        expect(url.protocol).toBe('file:');
        const file = fileURLToPath(url);
        const path = relative(rendererDirectory, file);
        expect(isAbsolute(path)).toBe(false);
        expect(path.startsWith(`..${sep}`) || path === '..').toBe(false);
        const metadata = await stat(file);
        expect(metadata.isFile()).toBe(true);
        return { path, bytes: metadata.size, resourceType: resource.type };
      })
    );
    await test.info().attach('actionable-launchpad-resources.json', {
      body: JSON.stringify(
        {
          coverage:
            'Native CDP request capture over initial-state launchpad reload; no latency claim',
          resources: emitted
        },
        null,
        2
      ),
      contentType: 'application/json'
    });
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.some(({ path }) => /desktop-cockpit/u.test(path))).toBe(false);
    const javascript = emitted.filter(({ path }) => path.endsWith('.js'));
    const stylesheets = emitted.filter(({ path }) => path.endsWith('.css'));
    expect(javascript.length).toBeGreaterThan(0);
    expect(stylesheets.length).toBeGreaterThan(0);
    expect(javascript.reduce((total, { bytes }) => total + bytes, 0)).toBeLessThanOrEqual(
      350 * 1024
    );
    expect(stylesheets.reduce((total, { bytes }) => total + bytes, 0)).toBeLessThanOrEqual(
      140 * 1024
    );
    await page.screenshot({ path: test.info().outputPath('actionable-first-run-launchpad.png') });
  } finally {
    await closeStudio(studio);
  }
});

test('a saved first project survives initial preview failure and has a visible reopen path', async () => {
  const studio = await openStudio();
  try {
    const { page } = studio;
    await page.setViewportSize({ width: 1280, height: 900 });
    await refuseNextPreviewBuild(studio.application);
    await page
      .getByRole('textbox', { name: 'Project name', exact: true })
      .fill('Recover first project');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const launchpad = page.getByRole('main', { name: 'Selene project launchpad', exact: true });
    await expect(launchpad).toBeVisible();
    await expect(launchpad).toContainText(projectPresentationFailure);
    await expect(
      page.getByRole('main', { name: 'Selene desktop designer', exact: true })
    ).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    const saved = await page.evaluate(() => window.selene.designer.listRecentProjects());
    expect(saved.filter((project) => project.name === 'Recover first project')).toHaveLength(1);
    const reopen = launchpad.getByRole('button', { name: 'Recover first project', exact: true });
    await expect(reopen).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('first-project-preview-failure.png') });
    await reopen.click();
    await expect(
      page.getByRole('main', { name: 'Selene desktop designer', exact: true })
    ).toBeVisible({
      timeout: 15_000
    });
    const host = await page.evaluate(() => window.selene.designer.snapshot());
    expect(host.source.projectId).toBe('recover-first-project');
    await expect(page.locator('.project-kicker')).toContainText('Recover first project');
    await expect(
      page.frameLocator('iframe[title="Generated React preview frame"]').locator('main')
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: test.info().outputPath('first-project-reopened.png') });
  } finally {
    await closeStudio(studio);
  }
});

test('a failed project switch never leaves departed project chrome or preview and reopens the saved owner', async () => {
  const studio = await openStudio();
  try {
    const { page } = studio;
    // Seed a second local project through the public host setup contract. The
    // review journey itself uses the real Create/Projects/reopen controls.
    const savedProject = await page.evaluate(() =>
      window.selene.designer.createProject({
        id: 'saved-project-b',
        name: 'Saved project B',
        template: 'review'
      })
    );
    await page
      .getByRole('textbox', { name: 'Project name', exact: true })
      .fill('Visible project A');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect(
      page.getByRole('main', { name: 'Selene desktop designer', exact: true })
    ).toBeVisible({
      timeout: 15_000
    });
    await expect(
      page.frameLocator('iframe[title="Generated React preview frame"]').locator('main')
    ).toBeVisible({ timeout: 15_000 });
    await refuseNextPreviewBuild(studio.application);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const chooser = page.getByRole('dialog', { name: 'Project launchpad', exact: true });
    await chooser.getByRole('button', { name: 'Saved project B', exact: true }).click();
    const launchpad = page.getByRole('main', { name: 'Selene project launchpad', exact: true });
    await expect(launchpad).toBeVisible();
    await expect(page.locator('.project-kicker')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(
      page.getByRole('main', { name: 'Selene desktop designer', exact: true })
    ).toHaveCount(0);
    expect((await page.evaluate(() => window.selene.designer.snapshot())).source.projectId).toBe(
      'saved-project-b'
    );
    await expect(launchpad).toContainText(projectPresentationFailure);
    await page.screenshot({ path: test.info().outputPath('project-switch-preview-failure.png') });
    await launchpad.getByRole('button', { name: 'Saved project B', exact: true }).click();
    await expect(
      page.getByRole('main', { name: 'Selene desktop designer', exact: true })
    ).toBeVisible({
      timeout: 15_000
    });
    await expect(page.locator('.project-kicker')).toContainText('Saved project B');
    await expect(
      page.frameLocator('iframe[title="Generated React preview frame"]').locator('main')
    ).toBeVisible({ timeout: 15_000 });
    const recovered = await page.evaluate(() => window.selene.designer.snapshot());
    expect(recovered.source.projectId).toBe('saved-project-b');
    expect(recovered.source).toEqual(savedProject.snapshot.source);
    expect(recovered.aiChangeRequests).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('project-switch-recovered-owner.png') });
  } finally {
    await closeStudio(studio);
  }
});

async function expectDisjointReciprocalLabels(page: Page, checkpoint: string): Promise<void> {
  const labels = page.locator('.react-flow__edge-textbg');
  await expect
    .poll(
      async () =>
        labels.evaluateAll(
          (elements) =>
            elements.filter((element) => {
              const bounds = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return (
                bounds.width > 0 &&
                bounds.height > 0 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden'
              );
            }).length
        ),
      { message: 'Both reciprocal wire labels must have visible measured rectangles.' }
    )
    .toBe(2);
  const rectangles = await labels.evaluateAll((elements) =>
    elements.map((element) => ({
      edgeId: element.closest('.react-flow__edge')?.getAttribute('data-id'),
      bounds: element.getBoundingClientRect().toJSON()
    }))
  );
  expect(rectangles).toHaveLength(2);
  const first = rectangles[0]!.bounds;
  const second = rectangles[1]!.bounds;
  expect(
    first.right <= second.left ||
      second.right <= first.left ||
      first.bottom <= second.top ||
      second.bottom <= first.top,
    'Forward/back wire label backgrounds must be strictly disjoint.'
  ).toBe(true);
  await test.info().attach(`${checkpoint}-reciprocal-label-rectangles.json`, {
    body: JSON.stringify(rectangles, null, 2),
    contentType: 'application/json'
  });
}

async function expectSettledAuthoringCapture(
  page: Page,
  application: ElectronApplication,
  checkpoint: string
) {
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
  });
  await page
    .frameLocator('iframe[title="Generated React preview frame"]')
    .locator('html')
    .evaluate(async (element) => {
      if (element.ownerDocument.fonts) await element.ownerDocument.fonts.ready;
    });
  let previousTransform: string | undefined;
  let stableCameraSamples = 0;
  await expect
    .poll(
      async () => {
        const transform = await page
          .locator('.react-flow__viewport')
          .evaluate((element) => getComputedStyle(element).transform);
        stableCameraSamples = transform === previousTransform ? stableCameraSamples + 1 : 0;
        previousTransform = transform;
        return stableCameraSamples;
      },
      {
        intervals: [80, 120, 160],
        message: 'The authoring camera and fonts must settle before pixel review or physical input.'
      }
    )
    .toBeGreaterThanOrEqual(2);
  const [viewport, native] = await Promise.all([
    page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio
    })),
    application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('The actual native capture window is unavailable.');
      return {
        contentBounds: window.getContentBounds(),
        shown: window.isVisible(),
        zoomFactor: window.webContents.getZoomFactor()
      };
    })
  ]);
  const matchesNativeContent =
    viewport.width === native.contentBounds.width &&
    viewport.height === native.contentBounds.height;
  await test.info().attach(`${checkpoint}-capture-surface.json`, {
    body: JSON.stringify(
      {
        coverage: matchesNativeContent
          ? 'Electron renderer viewport aligned to observed native content bounds'
          : 'Electron renderer responsive viewport; CDP emulation is intentional',
        viewport,
        native,
        matchesNativeContent
      },
      null,
      2
    ),
    contentType: 'application/json'
  });
}

async function captureActualNativeStarter(
  studio: Awaited<ReturnType<typeof openStudio>>,
  template: string
) {
  let previous: string | undefined;
  let stable = 0;
  let accepted: { width: number; height: number } | undefined;
  await expect
    .poll(
      async () => {
        const window = await studio.application.evaluate(({ BrowserWindow }) => {
          const current = BrowserWindow.getAllWindows()[0];
          if (!current) throw new Error('The native starter window is unavailable.');
          return { shown: current.isVisible(), bounds: current.getContentBounds() };
        });
        const sample = JSON.stringify(window);
        stable = window.shown && sample === previous ? stable + 1 : 0;
        previous = sample;
        accepted = window.bounds;
        return stable;
      },
      { intervals: [80, 120, 160], message: 'The shown native content surface must settle.' }
    )
    .toBeGreaterThanOrEqual(2);
  if (!accepted || accepted.width <= 0 || accepted.height <= 0)
    throw new Error('The shown native starter surface has no usable dimensions.');
  const viewport = { width: accepted.width, height: accepted.height };
  await studio.page.setViewportSize(viewport);
  await studio.page
    .getByRole('toolbar', { name: 'Canvas navigation', exact: true })
    .getByRole('button', { name: 'Fit selection', exact: true })
    .click();
  await expectSettledAuthoringCapture(studio.page, studio.application, `${template}-native-window`);
  const finalNative = await studio.application.evaluate(({ BrowserWindow }) => {
    const current = BrowserWindow.getAllWindows()[0]!;
    return { shown: current.isVisible(), bounds: current.getContentBounds() };
  });
  expect(finalNative.shown).toBe(true);
  expect(finalNative.bounds).toMatchObject(viewport);
  expect(await studio.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(
    viewport
  );
  await studio.page.screenshot({
    path: test.info().outputPath(`${template}-actual-native-window.png`)
  });
  await studio.page.setViewportSize({ width: 1280, height: 900 });
  await studio.page
    .getByRole('toolbar', { name: 'Canvas navigation', exact: true })
    .getByRole('button', { name: 'Fit selection', exact: true })
    .click();
}

for (const template of ['dashboard', 'review', 'blank'] as const) {
  test(`a first-user ${template} project edits literal React text, cancels safely and durably undo/redoes`, async () => {
    const studio = await openStudio();
    try {
      const { page } = studio;
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('radio', { name: new RegExp(`^${template}`, 'iu') }).check();
      const projectName = `First user ${template}`;
      await page.getByRole('textbox', { name: 'Project name', exact: true }).fill(projectName);
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      await expect(
        page.getByRole('main', { name: 'Selene desktop designer', exact: true })
      ).toBeVisible({ timeout: 15_000 });
      const previewFrame = page.locator('iframe[title="Generated React preview frame"]');
      const preview = page.frameLocator('iframe[title="Generated React preview frame"]');
      const heading = preview.locator('[data-selene-node-id="designer.title"]');
      await expect(heading).toBeVisible({ timeout: 15_000 });
      const initial = await page.evaluate(() => window.selene.designer.snapshot());
      const initialHeading = await heading.innerText();
      await captureActualNativeStarter(studio, template);
      await expectSettledAuthoringCapture(page, studio.application, `${template}-wide`);
      if (template !== 'blank') await expectDisjointReciprocalLabels(page, `${template}-wide`);
      await page.screenshot({ path: test.info().outputPath(`${template}-first-user.png`) });

      await page.setViewportSize({ width: 768, height: 900 });
      await expect(page.locator('.workspace-layout')).toHaveAttribute(
        'data-layout-mode',
        'inspector-drawer'
      );
      await expectSettledAuthoringCapture(page, studio.application, `${template}-compact`);
      const compactChrome = await page.evaluate(() => {
        const selectors = [
          '.workspace-topbar',
          '.canvas-workspace__toolbar',
          '.canvas-workspace__navigation'
        ];
        return selectors.map((selector) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`Missing first-user chrome: ${selector}`);
          const bounds = element.getBoundingClientRect();
          return {
            selector,
            bounds: bounds.toJSON(),
            horizontalOverflow: element.scrollWidth - element.clientWidth,
            controls: Array.from(element.querySelectorAll<HTMLButtonElement>('button'))
              .filter(
                (button) =>
                  button.getBoundingClientRect().width > 0 &&
                  (selector !== '.canvas-workspace__toolbar' ||
                    button.closest('.canvas-workspace__navigation') === null)
              )
              .map((button) => ({
                label: button.getAttribute('aria-label') || button.textContent?.trim(),
                bounds: button.getBoundingClientRect().toJSON()
              }))
          };
        });
      });
      await test.info().attach(`${template}-compact-first-user-chrome.json`, {
        body: JSON.stringify(compactChrome, null, 2),
        contentType: 'application/json'
      });
      for (const region of compactChrome) {
        expect(region.bounds.left, region.selector).toBeGreaterThanOrEqual(-1);
        expect(region.bounds.right, region.selector).toBeLessThanOrEqual(769);
        expect(region.bounds.top, region.selector).toBeGreaterThanOrEqual(-1);
        expect(region.bounds.bottom, region.selector).toBeLessThanOrEqual(901);
        expect(region.horizontalOverflow, region.selector).toBeLessThanOrEqual(1);
        expect(region.controls.length, region.selector).toBeGreaterThan(0);
        for (const control of region.controls) {
          expect(control.bounds.left, control.label).toBeGreaterThanOrEqual(region.bounds.left - 1);
          expect(control.bounds.right, control.label).toBeLessThanOrEqual(region.bounds.right + 1);
          expect(control.bounds.top, control.label).toBeGreaterThanOrEqual(region.bounds.top - 1);
          expect(control.bounds.bottom, control.label).toBeLessThanOrEqual(
            region.bounds.bottom + 1
          );
        }
      }
      if (template !== 'blank') await expectDisjointReciprocalLabels(page, `${template}-compact`);
      await page.screenshot({ path: test.info().outputPath(`${template}-first-user-compact.png`) });
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(page.locator('.workspace-layout')).toHaveAttribute(
        'data-layout-mode',
        'split-pane'
      );
      await expectSettledAuthoringCapture(page, studio.application, `${template}-restored-wide`);

      // Observe the real authored target, then dispatch a physical mouse click
      // through the app's native input bridge. No fabricated proof or host selection.
      const target = await heading.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x + bounds.width / 2,
          y: bounds.y + bounds.height / 2,
          width: window.innerWidth,
          height: window.innerHeight
        };
      });
      const frameBounds = await previewFrame.boundingBox();
      if (!frameBounds) throw new Error('The authored preview frame has no physical bounds.');
      await page.mouse.click(
        frameBounds.x + (target.x / target.width) * frameBounds.width,
        frameBounds.y + (target.y / target.height) * frameBounds.height
      );
      const actions = page.getByRole('toolbar', {
        name: 'Selected React element actions',
        exact: true
      });
      await expect(actions.getByRole('button', { name: 'Edit text', exact: true })).toBeVisible();
      await expect(
        page.getByRole('main', { name: 'Selene desktop designer', exact: true })
      ).toHaveAttribute('data-selene-preview-direct-authorized', 'true');
      await actions.getByRole('button', { name: 'Edit text', exact: true }).click();
      const editor = page.getByRole('form', { name: 'Edit selected React text', exact: true });
      const draft = editor.getByRole('textbox', { name: 'React text', exact: true });
      await expect(draft).toHaveValue(initialHeading);
      await draft.fill('This draft must be cancelled');
      await draft.press('Escape');
      await expect(editor).toHaveCount(0);
      const escapeCancelled = await page.evaluate(() => window.selene.designer.snapshot());
      expect(escapeCancelled.source).toEqual(initial.source);
      expect(escapeCancelled.selectedNodeId).toBe('designer.title');
      await expect(actions.getByRole('button', { name: 'Edit text', exact: true })).toBeEnabled();

      await actions.getByRole('button', { name: 'Edit text', exact: true }).click();
      await expect(draft).toHaveValue(initialHeading);
      await draft.fill('This button-cancelled draft must also be discarded');
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(editor).toHaveCount(0);
      const buttonCancelled = await page.evaluate(() => window.selene.designer.snapshot());
      expect(buttonCancelled.source).toEqual(initial.source);
      expect(buttonCancelled.selectedNodeId).toBe('designer.title');
      await expect(actions.getByRole('button', { name: 'Edit text', exact: true })).toBeEnabled();

      await actions.getByRole('button', { name: 'Edit text', exact: true }).click();
      await expect(draft).toHaveValue(initialHeading);
      const replacement = `My ${template} design`;
      await draft.fill(replacement);
      await editor.getByRole('button', { name: 'Save text', exact: true }).click();
      await expect(heading).toHaveText(replacement, { timeout: 15_000 });
      const edited = await page.evaluate(() => window.selene.designer.snapshot());
      expect(edited.source.revision.id).not.toBe(initial.source.revision.id);
      expect(edited.source.nodes).toEqual(initial.source.nodes);
      expect(edited.source.files.find((file) => file.path === 'src/App.tsx')?.content).toContain(
        `>${replacement}</h1>`
      );
      expect(edited.source.files.filter((file) => file.path !== 'src/App.tsx')).toEqual(
        initial.source.files.filter((file) => file.path !== 'src/App.tsx')
      );
      await page.screenshot({
        path: test.info().outputPath(`${template}-source-edit-painted.png`)
      });

      await page.reload();
      await expect(heading).toHaveText(replacement, { timeout: 15_000 });
      expect((await page.evaluate(() => window.selene.designer.snapshot())).source.files).toEqual(
        edited.source.files
      );
      await page.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
      const history = page.locator('.conversation-history');
      await history.getByRole('button', { name: 'Undo manual change', exact: true }).click();
      await expect(heading).toHaveText(initialHeading, { timeout: 15_000 });
      expect((await page.evaluate(() => window.selene.designer.snapshot())).source.files).toEqual(
        initial.source.files
      );
      await history.getByRole('button', { name: 'Redo manual change', exact: true }).click();
      await expect(heading).toHaveText(replacement, { timeout: 15_000 });
      expect((await page.evaluate(() => window.selene.designer.snapshot())).source.files).toEqual(
        edited.source.files
      );
      await page.reload();
      await expect(heading).toHaveText(replacement, { timeout: 15_000 });
      expect((await page.evaluate(() => window.selene.designer.snapshot())).source.files).toEqual(
        edited.source.files
      );
      await test.info().attach(`${template}-durable-source-outcome.json`, {
        body: JSON.stringify(
          {
            projectId: edited.source.projectId,
            originalRevision: initial.source.revision.id,
            editedRevision: edited.source.revision.id,
            originalHeading: initialHeading,
            replacement
          },
          null,
          2
        ),
        contentType: 'application/json'
      });
    } finally {
      await closeStudio(studio);
    }
  });
}

test('contextual actions leave adjacent authored text physically selectable on the actual native surface', async () => {
  const studio = await openStudio();
  try {
    const { page, application } = studio;
    await page.locator('input[name="project-template"][value="dashboard"]').check();
    await page
      .getByRole('textbox', { name: 'Project name', exact: true })
      .fill('Adjacent text review');
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const iframe = page.locator('iframe[title="Generated React preview frame"]');
    const preview = page.frameLocator('iframe[title="Generated React preview frame"]');
    await expect(preview.locator('[data-selene-node-id="designer.title"]')).toBeVisible({
      timeout: 15_000
    });
    const settleShownNativeSurface = async () => {
      let previousSurface: string | undefined;
      let stableSurfaceSamples = 0;
      let acceptedSurface: { width: number; height: number } | undefined;
      await expect
        .poll(
          async () => {
            const surface = await application.evaluate(({ BrowserWindow }) => {
              const window = BrowserWindow.getAllWindows()[0];
              if (!window) throw new Error('The actual native selection window is unavailable.');
              return { shown: window.isVisible(), bounds: window.getContentBounds() };
            });
            const sample = JSON.stringify(surface);
            stableSurfaceSamples =
              surface.shown && sample === previousSurface ? stableSurfaceSamples + 1 : 0;
            previousSurface = sample;
            acceptedSurface = surface.bounds;
            return stableSurfaceSamples;
          },
          { intervals: [80, 120, 160] }
        )
        .toBeGreaterThanOrEqual(2);
      if (!acceptedSurface) throw new Error('The native selection surface did not settle.');
      return { width: acceptedSurface.width, height: acceptedSurface.height };
    };
    let actualViewport = await settleShownNativeSurface();
    await page.setViewportSize(actualViewport);
    const navigation = page.getByRole('toolbar', { name: 'Canvas navigation', exact: true });
    await navigation.getByRole('button', { name: 'Selection', exact: true }).click();
    await navigation.getByRole('button', { name: 'Fit selection', exact: true }).click();
    await expectSettledAuthoringCapture(page, application, 'adjacent-text-native');
    const initial = await page.evaluate(() => window.selene.designer.snapshot());
    const initialUrl = await iframe.getAttribute('src');
    const initialNonce = await preview.locator('html').getAttribute('data-preview-nonce');
    const actions = page.getByRole('toolbar', {
      name: 'Selected React element actions',
      exact: true
    });
    const designer = page.getByRole('main', { name: 'Selene desktop designer', exact: true });

    const physicallySelect = async (nodeId: string, index: number) => {
      const target = preview.locator(`[data-selene-node-id="${nodeId}"]`);
      const local = await target.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const x = bounds.x + bounds.width / 2;
        const y = bounds.y + bounds.height / 2;
        return {
          bounds: bounds.toJSON(),
          x,
          y,
          viewport: { width: innerWidth, height: innerHeight },
          hitNodeId: document
            .elementFromPoint(x, y)
            ?.closest('[data-selene-node-id]')
            ?.getAttribute('data-selene-node-id')
        };
      });
      const frameBounds = await iframe.boundingBox();
      if (!frameBounds) throw new Error('The authored frame has no physical bounds.');
      const point = {
        x: frameBounds.x + (local.x / local.viewport.width) * frameBounds.width,
        y: frameBounds.y + (local.y / local.viewport.height) * frameBounds.height
      };
      const native = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        return { shown: window.isVisible(), bounds: window.getContentBounds() };
      });
      const parent = await iframe.evaluate((activeFrame, mappedPoint) => {
        const hit = document.elementFromPoint(mappedPoint.x, mappedPoint.y);
        const bridge = activeFrame.parentElement?.querySelector(
          '[data-selene-native-input-bridge]'
        );
        return {
          nativeSurface:
            hit === activeFrame || (bridge !== null && bridge !== undefined && hit === bridge),
          hitTag: hit?.tagName,
          hitClass: hit?.getAttribute('class'),
          artifactInert: activeFrame.closest('[inert]') !== null,
          toolbarBounds: document
            .querySelector('[aria-label="Selected React element actions"]')
            ?.getBoundingClientRect()
            .toJSON(),
          viewport: { width: innerWidth, height: innerHeight }
        };
      }, point);
      await test.info().attach(`adjacent-text-${index}-${nodeId}-physical-point.json`, {
        body: JSON.stringify({ nodeId, local, frameBounds, point, native, parent }, null, 2),
        contentType: 'application/json'
      });
      expect(native.shown).toBe(true);
      expect(native.bounds).toMatchObject(actualViewport);
      expect(parent.viewport).toEqual(actualViewport);
      expect(local.hitNodeId).toBe(nodeId);
      expect(local.bounds.left).toBeGreaterThanOrEqual(0);
      expect(local.bounds.top).toBeGreaterThanOrEqual(0);
      expect(local.bounds.right).toBeLessThanOrEqual(local.viewport.width);
      expect(local.bounds.bottom).toBeLessThanOrEqual(local.viewport.height);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThan(native.bounds.width);
      expect(point.y).toBeLessThan(native.bounds.height);
      expect(parent.artifactInert).toBe(false);
      expect(
        parent.nativeSurface,
        'The adjacent text center must remain exposed without clearing its contextual actions.'
      ).toBe(true);
      await page.mouse.click(point.x, point.y);
      await expect(designer).toHaveAttribute('data-selene-preview-direct-authorized', 'true');
      await expect
        .poll(
          async () => (await page.evaluate(() => window.selene.designer.snapshot())).selectedNodeId,
          { timeout: 5_000 }
        )
        .toBe(nodeId);
      await expect(designer).toHaveAttribute('data-selene-preview-selection-stage', 'authorized');
      await expect(designer).toHaveAttribute('data-selene-preview-direct-authorized', 'true');
      await expect(actions.getByRole('button', { name: 'Edit text', exact: true })).toBeEnabled();
      const selected = await page.evaluate(() => window.selene.designer.snapshot());
      expect(selected.source).toEqual(initial.source);
      await expect(iframe).toHaveAttribute('src', initialUrl!);
      await expect(preview.locator('html')).toHaveAttribute('data-preview-nonce', initialNonce!);
      await page.screenshot({
        path: test.info().outputPath(`adjacent-text-${index}-${nodeId}-selected.png`)
      });
    };
    await physicallySelect('designer.title', 0);
    await physicallySelect('designer.summary', 1);
    await physicallySelect('designer.title', 2);
    await physicallySelect('designer.summary', 3);

    // Resize only this owned app window. The accepted native dimensions,
    // not the requested size or a CDP-only viewport, govern every click.
    await application.evaluate(({ BrowserWindow }, height) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('The owned native selection window is unavailable.');
      window.setContentSize(768, height);
    }, actualViewport.height);
    actualViewport = await settleShownNativeSurface();
    expect(
      actualViewport.width,
      'The owned window must grant a genuinely compact content surface.'
    ).toBeLessThanOrEqual(780);
    await page.setViewportSize(actualViewport);
    await navigation.getByRole('button', { name: 'Fit selection', exact: true }).click();
    await expectSettledAuthoringCapture(page, application, 'adjacent-text-native-compact');
    await physicallySelect('designer.title', 4);
    await physicallySelect('designer.summary', 5);
    await physicallySelect('designer.title', 6);
    await physicallySelect('designer.summary', 7);
  } finally {
    await closeStudio(studio);
  }
});

test('pending presentation blocks departed artifact input until the real committed frame is ready', async () => {
  const studio = await openStudio();
  try {
    const { application, page } = studio;
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByLabel('Project name', { exact: true }).fill('Pending presentation review');
    await page.locator('input[name="project-template"][value="dashboard"]').check();
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const iframe = page.locator('iframe[title="Generated React preview frame"]');
    const preview = page.frameLocator('iframe[title="Generated React preview frame"]');
    const action = preview.getByRole('button', { name: 'View orders', exact: true });
    await expect(action).toBeVisible({ timeout: 15_000 });
    const original = await page.evaluate(() => window.selene.designer.snapshot());
    const authoringUrl = await iframe.getAttribute('src');
    const authoringNonce = await preview.locator('html').getAttribute('data-preview-nonce');
    const bounds = await iframe.boundingBox();
    if (!bounds) throw new Error('The real authoring preview has no physical bounds.');
    const local = await action.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        width: innerWidth,
        height: innerHeight
      };
    });
    const point = {
      x: bounds.x + (local.x / local.width) * bounds.width,
      y: bounds.y + (local.y / local.height) * bounds.height
    };
    await holdNextPreviewBuild(application);

    await page
      .getByLabel('Design canvas', { exact: true })
      .getByRole('button', { name: 'Present', exact: true })
      .click();
    const presentation = page.getByLabel('Prototype presentation', { exact: true });
    await expect.poll(async () => (await readPreviewGate(application))?.requested).toBe(true);
    await expect(presentation).toHaveAttribute('aria-busy', 'true');
    await expect(presentation.locator('.canvas-presentation__artifact')).toHaveAttribute(
      'inert',
      ''
    );
    await expect(presentation.getByRole('button', { name: /Exit/ })).toBeEnabled();
    await expect(presentation.getByRole('status')).toHaveText(
      'Preparing the prototype… You can exit while it loads.'
    );
    const pendingOwner = await page.evaluate(({ x, y }) => {
      const artifact = document.querySelector<HTMLElement>('.canvas-presentation__artifact');
      const hit = document.elementFromPoint(x, y);
      return {
        hitTag: hit?.tagName,
        hitIsFrame: hit?.tagName === 'IFRAME',
        artifactInert: artifact?.inert,
        artifactPointerEvents: artifact ? getComputedStyle(artifact).pointerEvents : undefined
      };
    }, point);
    expect(pendingOwner.hitIsFrame).toBe(false);
    expect(pendingOwner.artifactInert).toBe(true);
    expect(pendingOwner.artifactPointerEvents).toBe('none');
    const pendingHost = await page.evaluate(() => window.selene.designer.snapshot());
    expect(pendingHost.editablePrototype.mode).toBe('run');
    expect(pendingHost.editablePrototype.runtime?.activeNodeId).toBe('dashboard');
    await page.mouse.click(point.x, point.y);
    const afterPendingClick = await page.evaluate(() => window.selene.designer.snapshot());
    expect(afterPendingClick.editablePrototype.runtime).toEqual(
      pendingHost.editablePrototype.runtime
    );
    expect(afterPendingClick.source).toEqual(original.source);
    await page.screenshot({
      path: test.info().outputPath('presentation-pending-input-fenced.png')
    });
    await test.info().attach('presentation-pending-input-fence.json', {
      body: JSON.stringify(
        {
          point,
          pendingOwner,
          activeNodeId: afterPendingClick.editablePrototype.runtime?.activeNodeId
        },
        null,
        2
      ),
      contentType: 'application/json'
    });
    await releasePreviewGate(application);
    await expect(iframe).not.toHaveAttribute('src', authoringUrl!);
    await expect(preview.locator('html')).not.toHaveAttribute(
      'data-preview-nonce',
      authoringNonce!
    );
    await expect(preview.locator('html')).toHaveAttribute(
      'data-selene-canvas-navigation',
      'prototype'
    );
    await expect(presentation).not.toHaveAttribute('aria-busy', 'true');
    await expect(presentation.getByRole('button', { name: /Exit/ })).toBeEnabled();
    await action.click();
    await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Orders to watch');
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.selene.designer.snapshot())).editablePrototype.runtime
            ?.activeNodeId
      )
      .toBe('orders');
    await preview.locator('button[data-selene-action-port="back"]').click();
    await expect(preview.getByRole('heading', { level: 1 })).toHaveText('Good work, in view.');
    expect((await page.evaluate(() => window.selene.designer.snapshot())).source.files).toEqual(
      original.source.files
    );
  } finally {
    try {
      await releasePreviewGate(studio.application, true);
    } finally {
      await closeStudio(studio);
    }
  }
});

test('pending presentation Exit, Escape, same-project reopen and deadline fence late real build completion', async () => {
  test.setTimeout(75_000);
  const studio = await openStudio();
  try {
    const { application, page } = studio;
    await page.getByLabel('Project name', { exact: true }).fill('Interrupted presentation review');
    await page.locator('input[name="project-template"][value="dashboard"]').check();
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    const canvas = page.getByLabel('Design canvas', { exact: true });
    const iframe = page.locator('iframe[title="Generated React preview frame"]');
    const preview = page.frameLocator('iframe[title="Generated React preview frame"]');
    const heading = preview.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText('Good work, in view.', { timeout: 15_000 });
    const original = await page.evaluate(() => window.selene.designer.snapshot());
    const exerciseInterruption = async (
      interruption: 'Exit' | 'Escape' | 'Reopen' | 'Deadline'
    ) => {
      await holdNextPreviewBuild(application);
      try {
        const started = performance.now();
        await canvas.getByRole('button', { name: 'Present', exact: true }).click();
        await expect.poll(async () => (await readPreviewGate(application))?.requested).toBe(true);
        const presentation = page.getByLabel('Prototype presentation', { exact: true });
        const exit = presentation.getByRole('button', { name: /Exit/ });
        await expect(presentation).toHaveAttribute('aria-busy', 'true');
        await expect(exit).toBeEnabled();
        if (interruption === 'Exit') await exit.click();
        if (interruption === 'Escape') {
          await exit.focus();
          await page.keyboard.press('Escape');
        }
        if (interruption === 'Reopen') {
          // Presentation intentionally covers the topbar. Cancel through its
          // available Exit control before using Projects, keeping the old IPC
          // held through the same-project reopen and late-completion checks.
          await exit.click();
          await expect(canvas).toBeVisible({ timeout: 5_000 });
          await page.getByRole('button', { name: 'Projects', exact: true }).click();
          await page
            .getByRole('button', { name: 'Interrupted presentation review', exact: true })
            .click();
        }
        await expect(canvas).toBeVisible({ timeout: interruption === 'Deadline' ? 20_000 : 5_000 });
        await expect(heading).toHaveText('Good work, in view.', { timeout: 5_000 });
        await expect(preview.locator('html')).toHaveAttribute(
          'data-selene-canvas-navigation',
          'design'
        );
        const elapsedMs = performance.now() - started;
        expect(elapsedMs).toBeLessThan(interruption === 'Deadline' ? 22_000 : 7_000);
        if (interruption === 'Deadline') expect(elapsedMs).toBeGreaterThanOrEqual(14_000);
        const restored = await page.evaluate(() => window.selene.designer.snapshot());
        expect(restored.source).toEqual(original.source);
        expect(restored.editablePrototype.mode).toBe('edit');
        expect(restored.editablePrototype.runtime).toBeUndefined();
        await expect(canvas.getByRole('button', { name: 'Present', exact: true })).toBeEnabled();
        const restoredUrl = await iframe.getAttribute('src');
        const restoredNonce = await preview.locator('html').getAttribute('data-preview-nonce');
        await releasePreviewGate(application);
        await expect.poll(async () => (await readPreviewGate(application))?.completed).toBe(true);
        const lateOutcome = await readPreviewGate(application);
        expect(lateOutcome?.outcome).toBe('rejected');
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
            )
        );
        await expect(iframe).toHaveAttribute('src', restoredUrl!);
        await expect(preview.locator('html')).toHaveAttribute('data-preview-nonce', restoredNonce!);
        await expect(heading).toHaveText('Good work, in view.');
        const afterLate = await page.evaluate(() => window.selene.designer.snapshot());
        expect(afterLate.source).toEqual(original.source);
        expect(afterLate.editablePrototype.mode).toBe('edit');
        expect(afterLate.editablePrototype.runtime).toBeUndefined();
        await page.screenshot({
          path: test
            .info()
            .outputPath(`presentation-${interruption.toLowerCase()}-late-build-fenced.png`)
        });
        await test
          .info()
          .attach(`presentation-${interruption.toLowerCase()}-late-build-fence.json`, {
            body: JSON.stringify(
              {
                interruption,
                elapsedMs,
                lateOutcome,
                projectId: restored.source.projectId,
                revisionId: restored.source.revision.id,
                restoredUrl,
                restoredNonce
              },
              null,
              2
            ),
            contentType: 'application/json'
          });
      } finally {
        await releasePreviewGate(application, true);
      }
    };
    await exerciseInterruption('Exit');
    await exerciseInterruption('Escape');
    await exerciseInterruption('Reopen');
    await exerciseInterruption('Deadline');
  } finally {
    try {
      await releasePreviewGate(studio.application, true);
    } finally {
      await closeStudio(studio);
    }
  }
});

for (const extension of ['js', 'css'] as const) {
  test(`a saved project recovers its real ${extension} cockpit resource after one explicit reopen`, async () => {
    const studio = await openStudio();
    const assetDirectory = join(rendererDirectory, 'assets');
    let originalPath: string | undefined;
    let withheldPath: string | undefined;
    let originalIdentity: { inode: number; bytes: number; sha256: string } | undefined;
    const fileIdentity = async (path: string) => {
      const metadata = await stat(path);
      return {
        inode: metadata.ino,
        bytes: metadata.size,
        sha256: createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      };
    };
    try {
      const { page } = studio;
      await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled();
      const native = await studio.application.evaluate(({ safeStorage, BrowserWindow }) => ({
        protectedStorage: safeStorage.isEncryptionAvailable(),
        backend:
          process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform,
        windows: BrowserWindow.getAllWindows().map((window) => {
          const readPreferences: unknown = Reflect.get(window.webContents, 'getLastWebPreferences');
          if (typeof readPreferences !== 'function')
            throw new Error('Native web preferences are unavailable.');
          const preferences = Reflect.apply(readPreferences, window.webContents, []) as {
            sandbox?: boolean;
            contextIsolation?: boolean;
            nodeIntegration?: boolean;
          };
          return {
            sandbox: preferences.sandbox,
            contextIsolation: preferences.contextIsolation,
            nodeIntegration: preferences.nodeIntegration
          };
        })
      }));
      expect(native.protectedStorage).toBe(true);
      expect(native.backend).not.toBe('basic_text');
      expect(native.windows.length).toBeGreaterThan(0);
      expect(
        native.windows.every(
          (window) => window.sandbox && window.contextIsolation && !window.nodeIntegration
        )
      ).toBe(true);
      const assets = (await readdir(assetDirectory)).filter(
        (name) => name.startsWith('desktop-cockpit-') && name.endsWith(`.${extension}`)
      );
      expect(assets).toHaveLength(1);
      const assetName = assets[0]!;
      originalPath = join(assetDirectory, assetName);
      originalIdentity = await fileIdentity(originalPath);
      withheldPath = `${originalPath}.selene-native-resource-refusal`;
      const originalDocument = await page.evaluate(() => performance.timeOrigin);
      // Native file resources bypass page.route. Move only this generated build
      // asset reversibly, then restore its exact inode/bytes/hash before retry.
      await rename(originalPath, withheldPath);
      const projectName = `Saved ${extension} resource retry`;
      await page.getByRole('textbox', { name: 'Project name', exact: true }).fill(projectName);
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      const launchpad = page.getByRole('main', { name: 'Selene project launchpad', exact: true });
      await expect(launchpad).toContainText(projectPresentationFailure, { timeout: 15_000 });
      await expect(page.locator('iframe')).toHaveCount(0);
      await expect(page.locator('.project-kicker')).toHaveCount(0);
      const saved = await page.evaluate(() => window.selene.designer.snapshot());
      const recent = await page.evaluate(() => window.selene.designer.listRecentProjects());
      expect(recent.filter((project) => project.name === projectName)).toHaveLength(1);
      await page.screenshot({
        path: test.info().outputPath(`${extension}-cockpit-resource-refused.png`)
      });
      await rename(withheldPath, originalPath);
      withheldPath = undefined;
      expect(await fileIdentity(originalPath)).toEqual(originalIdentity);
      await launchpad.getByRole('button', { name: projectName, exact: true }).click();
      await expect(
        page.getByRole('main', { name: 'Selene desktop designer', exact: true })
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.frameLocator('iframe[title="Generated React preview frame"]').locator('main')
      ).toBeVisible({ timeout: 15_000 });
      expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(originalDocument);
      const reopened = await page.evaluate(() => window.selene.designer.snapshot());
      expect(reopened.source).toEqual(saved.source);
      const stylesheets = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
          .filter((link) => link.href.includes('desktop-cockpit-'))
          .map((link) => ({ href: link.href, loaded: link.sheet !== null }))
      );
      expect(stylesheets.some((stylesheet) => stylesheet.loaded)).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`${extension}-cockpit-resource-recovered.png`)
      });
      await test.info().attach(`${extension}-cockpit-resource-recovery.json`, {
        body: JSON.stringify(
          {
            mode: 'reversible emitted-file absence, followed by explicit saved-project reopen',
            assetName,
            originalIdentity,
            restoredIdentity: await fileIdentity(originalPath),
            native,
            projectId: reopened.source.projectId,
            sourceRevisionId: reopened.source.revision.id,
            stylesheets
          },
          null,
          2
        ),
        contentType: 'application/json'
      });
    } finally {
      try {
        if (withheldPath && originalPath) await rename(withheldPath, originalPath);
        if (originalPath && originalIdentity)
          expect(await fileIdentity(originalPath)).toEqual(originalIdentity);
      } finally {
        await closeStudio(studio);
      }
    }
  });
}
