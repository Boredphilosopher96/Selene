import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { assertNativeElectronTestAllowed } from '../../../scripts/playwright-harness.mjs';

const require = createRequire(import.meta.url);
const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const previewSelector = 'iframe[title="Generated React preview frame"]';
const templates = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    heading: 'Good work, in view.',
    action: 'View orders',
    nextHeading: 'Orders to watch'
  },
  {
    id: 'review',
    label: 'Review',
    heading: 'A calmer first hello.',
    action: 'Open decision',
    nextHeading: 'Make the next step clear.'
  },
  { id: 'blank', label: 'Blank', heading: 'Your next idea' }
] as const;

test.beforeAll(() => assertNativeElectronTestAllowed());

async function openStudio(userData: string) {
  const directory = dirname(require.resolve('electron'));
  const executable = (await readFile(join(directory, 'path.txt'), 'utf8')).trim();
  const application = await electron.launch({
    executablePath: join(directory, 'dist', executable),
    args: [mainEntry, `--user-data-dir=${userData}`]
  });
  const page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: 'Start a local project' })).toBeVisible();
  const initialNativeBounds = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getContentBounds()
  );
  const requestedContentSize = { width: 1180, height: 812 };
  // The window manager may clamp this request to its usable display. Only
  // the shown, settled real content surface can define our input viewport.
  await application.evaluate(
    ({ BrowserWindow }, requested) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(requested.width, requested.height),
    requestedContentSize
  );
  let acceptedNativeBounds = initialNativeBounds;
  let previousSignature: string | undefined;
  let stableSince = Date.now();
  await expect
    .poll(async () => {
      const native = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        return {
          shown: window.isVisible(),
          minimized: window.isMinimized(),
          bounds: window.getContentBounds()
        };
      });
      const usable =
        native.shown &&
        !native.minimized &&
        Object.values(native.bounds).every(Number.isFinite) &&
        native.bounds.width > 0 &&
        native.bounds.height > 0;
      const signature = JSON.stringify(native.bounds);
      if (!usable || signature !== previousSignature) {
        previousSignature = usable ? signature : undefined;
        stableSince = Date.now();
      }
      acceptedNativeBounds = native.bounds;
      return usable && Date.now() - stableSince >= 200;
    })
    .toBe(true);
  await page.setViewportSize({
    width: acceptedNativeBounds.width,
    height: acceptedNativeBounds.height
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  });
  const alignedNative = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    return {
      shown: window.isVisible(),
      minimized: window.isMinimized(),
      bounds: window.getContentBounds()
    };
  });
  expect(alignedNative).toEqual({ shown: true, minimized: false, bounds: acceptedNativeBounds });
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(viewport).toEqual({
    width: acceptedNativeBounds.width,
    height: acceptedNativeBounds.height
  });
  await test.info().attach('native-window-viewport.json', {
    body: JSON.stringify(
      { requestedContentSize, initialNativeBounds, acceptedNativeBounds, viewport },
      null,
      2
    ),
    contentType: 'application/json'
  });
  return { application, page };
}

async function alignViewportWithNativeSurface(studio: Awaited<ReturnType<typeof openStudio>>) {
  const accepted = await studio.application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getContentBounds()
  );
  // A window manager can settle native bounds after show/reopen. Input uses
  // that accepted surface, never a larger CDP-only emulated layout.
  await studio.page.setViewportSize({ width: accepted.width, height: accepted.height });
  await studio.page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  });
  const settled = await studio.application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.getContentBounds()
  );
  expect(settled).toEqual(accepted);
  expect(await studio.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
    width: settled.width,
    height: settled.height
  });
  await test.info().attach('accepted-native-input-viewport.json', {
    body: JSON.stringify(settled, null, 2),
    contentType: 'application/json'
  });
}

async function clickNativePresentationAction(
  studio: Awaited<ReturnType<typeof openStudio>>,
  action: Locator,
  evidenceName: string
) {
  await alignViewportWithNativeSurface(studio);
  const frame = studio.page.locator(previewSelector);
  const [bounds, metrics, target, nativeBounds] = await Promise.all([
    frame.boundingBox(),
    frame.evaluate((element) => ({
      offsetWidth: element.offsetWidth,
      offsetHeight: element.offsetHeight,
      clientLeft: element.clientLeft,
      clientTop: element.clientTop,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight
    })),
    action.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(point.x, point.y);
      const witness = window as typeof window & { seleneNativeActionWitness?: unknown[] };
      witness.seleneNativeActionWitness = [];
      const observe = (event: Event) => {
        const node =
          event.target instanceof Element
            ? event.target.closest('[data-selene-action-port]')
            : null;
        witness.seleneNativeActionWitness!.push({
          type: event.type,
          trusted: event.isTrusted,
          nodeId: node?.getAttribute('data-selene-flow-node'),
          portId: node?.getAttribute('data-selene-action-port')
        });
      };
      window.addEventListener('pointerdown', observe, { capture: true, once: true });
      window.addEventListener('click', observe, { capture: true, once: true });
      return {
        point,
        rect: rect.toJSON(),
        viewport: { width: innerWidth, height: innerHeight },
        hitIsTarget: hit === element || element.contains(hit),
        nodeId: element.getAttribute('data-selene-flow-node'),
        portId: element.getAttribute('data-selene-action-port')
      };
    }),
    studio.application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getContentBounds()
    )
  ]);
  if (!bounds) throw new Error('The live presentation frame has no native bounds');
  expect(target.hitIsTarget).toBe(true);
  const point = {
    x:
      bounds.x +
      ((metrics.clientLeft + (target.point.x * metrics.clientWidth) / target.viewport.width) *
        bounds.width) /
        metrics.offsetWidth,
    y:
      bounds.y +
      ((metrics.clientTop + (target.point.y * metrics.clientHeight) / target.viewport.height) *
        bounds.height) /
        metrics.offsetHeight
  };
  expect(point.x).toBeGreaterThanOrEqual(0);
  expect(point.y).toBeGreaterThanOrEqual(0);
  expect(point.x).toBeLessThan(nativeBounds.width);
  expect(point.y).toBeLessThan(nativeBounds.height);
  const owner = await frame.evaluate((element, input) => {
    const hit = document.elementFromPoint(input.x, input.y);
    return {
      hitIsFrame: hit === element,
      tag: hit?.tagName,
      inert: element.closest('[inert]') !== null,
      pointerEvents: getComputedStyle(element).pointerEvents
    };
  }, point);
  await test.info().attach(`${evidenceName}-physical-point.json`, {
    body: JSON.stringify({ bounds, metrics, target, nativeBounds, point, owner }, null, 2),
    contentType: 'application/json'
  });
  expect(owner).toEqual({ hitIsFrame: true, tag: 'IFRAME', inert: false, pointerEvents: 'auto' });
  await studio.page.mouse.click(point.x, point.y);
  const witness = await studio.page
    .frameLocator(previewSelector)
    .locator('html')
    .evaluate(
      () =>
        (window as typeof window & { seleneNativeActionWitness?: unknown[] })
          .seleneNativeActionWitness
    );
  await test.info().attach(`${evidenceName}-trusted-input.json`, {
    body: JSON.stringify(witness ?? [], null, 2),
    contentType: 'application/json'
  });
  expect(witness).toEqual([
    { type: 'pointerdown', trusted: true, nodeId: target.nodeId, portId: target.portId },
    { type: 'click', trusted: true, nodeId: target.nodeId, portId: target.portId }
  ]);
}

async function selectNativeHeading(page: Page, heading: Locator) {
  const frame = page.locator(previewSelector);
  const [bounds, metrics, local] = await Promise.all([
    frame.boundingBox(),
    frame.evaluate((element) => ({
      offsetWidth: element.offsetWidth,
      offsetHeight: element.offsetHeight,
      clientLeft: element.clientLeft,
      clientTop: element.clientTop,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight
    })),
    heading.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      return {
        point,
        viewport: { width: innerWidth, height: innerHeight },
        hit: document.elementFromPoint(point.x, point.y) === element
      };
    })
  ]);
  if (!bounds) throw new Error('The actual preview frame is not visible');
  expect(local.hit).toBe(true);
  const point = {
    x:
      bounds.x +
      ((metrics.clientLeft + (local.point.x * metrics.clientWidth) / local.viewport.width) *
        bounds.width) /
        metrics.offsetWidth,
    y:
      bounds.y +
      ((metrics.clientTop + (local.point.y * metrics.clientHeight) / local.viewport.height) *
        bounds.height) /
        metrics.offsetHeight
  };
  const owner = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return {
      tag: element?.tagName,
      bridge: element?.hasAttribute('data-selene-native-input-bridge')
    };
  }, point);
  expect(owner).toEqual({ tag: 'DIV', bridge: true });
  await test.info().attach('native-heading-selection.json', {
    body: JSON.stringify({ bounds, metrics, local, point, owner }, null, 2),
    contentType: 'application/json'
  });
  await page.mouse.click(point.x, point.y);
  const actions = page.getByRole('toolbar', { name: 'Selected React element actions' });
  await expect(actions.getByRole('button', { name: 'Edit text', exact: true })).toBeEnabled();
  await expect
    .poll(() => page.evaluate(async () => (await window.selene.designer.snapshot()).selectedNodeId))
    .toBe('designer.title');
  await actions.getByRole('button', { name: 'Edit text', exact: true }).click();
}

async function expectPreviewAccessible(page: Page) {
  const handle = await page.locator(previewSelector).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('Preview frame unavailable');
  // DevTools evaluation instruments the test document without changing shipped CSP.
  await frame.evaluate(await readFile(require.resolve('axe-core/axe.min.js'), 'utf8'));
  const violations = await frame.evaluate(async () => {
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
  await test.info().attach('starter-accessibility.json', {
    body: JSON.stringify(violations, null, 2),
    contentType: 'application/json'
  });
  expect(violations).toEqual([]);
}

for (const template of templates) {
  test(`${template.label} starter creates, renders, physically selects, edits, reopens and undoes`, async () => {
    test.setTimeout(120_000);
    const userData = await mkdtemp(join(tmpdir(), `selene-starter-${template.id}-`));
    let studio = await openStudio(userData);
    const name = `Native ${template.label} starter`;
    try {
      const { page } = studio;
      await page.getByLabel('Project name').fill(name);
      await page.locator(`input[name="project-template"][value="${template.id}"]`).check();
      await page.getByRole('button', { name: 'Create project', exact: true }).click();
      const prototype = page.frameLocator(previewSelector);
      const heading = prototype.getByRole('heading', { level: 1 });
      await expect(heading).toHaveText(template.heading, { timeout: 15_000 });
      const before = await page.evaluate(() => window.selene.designer.snapshot());
      expect(before.scenarios).toHaveLength(1);
      expect(before.selectedScenarioId).toBe(`${template.id}-start`);
      expect(before.editablePrototype.graph.nodes).toHaveLength(template.id === 'blank' ? 1 : 2);
      await expectPreviewAccessible(page);
      await page.screenshot({ path: test.info().outputPath(`${template.id}-authored.png`) });
      await selectNativeHeading(page, heading);
      const editor = page.getByRole('form', { name: 'Edit selected React text', exact: true });
      const text = editor.getByRole('textbox', { name: 'React text', exact: true });
      await expect(text).toHaveValue(template.heading);
      const editedHeading = `${template.label} is really editable`;
      await text.fill(editedHeading);
      await editor.getByRole('button', { name: 'Save text', exact: true }).click();
      await expect(heading).toHaveText(editedHeading, { timeout: 15_000 });
      const edited = await page.evaluate(() => window.selene.designer.snapshot());
      expect(edited.source.revision.id).not.toBe(before.source.revision.id);
      expect(edited.source.files.find((file) => file.path === 'src/App.tsx')?.content).toContain(
        `>${editedHeading}</h1>`
      );
      expect(edited.source.files.filter((file) => file.language !== 'tsx')).toEqual(
        before.source.files.filter((file) => file.language !== 'tsx')
      );
      await page.screenshot({ path: test.info().outputPath(`${template.id}-literal-edit.png`) });
      await studio.application.close();
      studio = await openStudio(userData);
      await studio.page.getByRole('button', { name, exact: true }).click();
      const reopened = studio.page.frameLocator(previewSelector);
      await expect(reopened.getByRole('heading', { level: 1 })).toHaveText(editedHeading, {
        timeout: 15_000
      });
      expect(
        (await studio.page.evaluate(() => window.selene.designer.snapshot())).source.files
      ).toEqual(edited.source.files);
      await studio.page.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
      await studio.page
        .getByLabel('Design activity and AI conversation history', { exact: true })
        .getByRole('button', { name: 'Undo manual change', exact: true })
        .click();
      await expect(reopened.getByRole('heading', { level: 1 })).toHaveText(template.heading, {
        timeout: 15_000
      });
      expect(
        (await studio.page.evaluate(() => window.selene.designer.snapshot())).source.files
      ).toEqual(before.source.files);
      if ('action' in template) {
        const authoringUrl = await studio.page.locator(previewSelector).getAttribute('src');
        await studio.page
          .getByLabel('Design canvas', { exact: true })
          .getByRole('button', { name: 'Present', exact: true })
          .click();
        const presentation = studio.page.getByLabel('Prototype presentation', { exact: true });
        await expect(presentation).toBeVisible();
        await expect(presentation).not.toHaveAttribute('aria-busy', 'true');
        await expect(presentation.locator('.canvas-presentation__artifact')).not.toHaveAttribute(
          'inert'
        );
        await expect(studio.page.locator(previewSelector)).not.toHaveAttribute(
          'src',
          authoringUrl!
        );
        await expect(reopened.locator('html')).toHaveAttribute(
          'data-selene-canvas-navigation',
          'prototype'
        );
        await expect(presentation.getByRole('button', { name: /Exit/ })).toBeEnabled();
        await expect
          .poll(() =>
            studio.page.evaluate(async () => {
              const current = await window.selene.designer.snapshot();
              return {
                mode: current.editablePrototype.mode,
                activeNodeId: current.editablePrototype.runtime?.activeNodeId
              };
            })
          )
          .toEqual({ mode: 'run', activeNodeId: template.id });
        await expect(
          reopened.getByRole('button', { name: template.action, exact: true })
        ).toBeVisible({ timeout: 15_000 });
        await clickNativePresentationAction(
          studio,
          reopened.getByRole('button', { name: template.action, exact: true }),
          `${template.id}-forward`
        );
        const actionOutcome = await Promise.all([
          studio.page.evaluate(async () => {
            const current = await window.selene.designer.snapshot();
            const panel = document.querySelector<HTMLElement>('.canvas-presentation');
            const artifact = panel?.querySelector<HTMLElement>('.canvas-presentation__artifact');
            return {
              mode: current.editablePrototype.mode,
              runtime: current.editablePrototype.runtime,
              sourceRevision: current.source.revision.id,
              pending: panel?.getAttribute('aria-busy'),
              readOnly: panel?.dataset.readOnly,
              inert: artifact?.inert,
              status: panel?.querySelector('output')?.textContent
            };
          }),
          reopened.locator('html').evaluate((root) => ({
            navigation: root.dataset.seleneCanvasNavigation,
            heading: document.querySelector('h1')?.textContent,
            route: location.pathname,
            history: history.state
          }))
        ]);
        await test.info().attach('native-presentation-forward-outcome.json', {
          body: JSON.stringify(actionOutcome, null, 2),
          contentType: 'application/json'
        });
        await expect(reopened.getByRole('heading', { level: 1 })).toHaveText(template.nextHeading);
        await expect
          .poll(() =>
            studio.page.evaluate(
              async () =>
                (await window.selene.designer.snapshot()).editablePrototype.runtime?.activeNodeId
            )
          )
          .toBe(template.id === 'dashboard' ? 'orders' : 'decision');
        await expectPreviewAccessible(studio.page);
        await clickNativePresentationAction(
          studio,
          reopened.locator('button[data-selene-action-port="back"]'),
          `${template.id}-return`
        );
        await expect(reopened.getByRole('heading', { level: 1 })).toHaveText(template.heading);
        await expect
          .poll(() =>
            studio.page.evaluate(
              async () =>
                (await window.selene.designer.snapshot()).editablePrototype.runtime?.activeNodeId
            )
          )
          .toBe(template.id);
        await studio.page
          .getByLabel('Prototype presentation', { exact: true })
          .getByRole('button', { name: /Exit/ })
          .click();
        await expect(reopened.getByRole('heading', { level: 1 })).toHaveText(template.heading, {
          timeout: 15_000
        });
      }
      await studio.application.close();
      studio = await openStudio(userData);
      await studio.page.getByRole('button', { name, exact: true }).click();
      await expect(
        studio.page.frameLocator(previewSelector).getByRole('heading', { level: 1 })
      ).toHaveText(template.heading, { timeout: 15_000 });
      expect(
        (await studio.page.evaluate(() => window.selene.designer.snapshot())).source.files
      ).toEqual(before.source.files);
      await studio.page.screenshot({
        path: test.info().outputPath(`${template.id}-durable-undo.png`)
      });
    } finally {
      await studio.application.close();
      await rm(userData, { recursive: true, force: true });
    }
  });
}
