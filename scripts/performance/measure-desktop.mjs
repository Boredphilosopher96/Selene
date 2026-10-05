// Sequential samples intentionally observe one real app and its single-instance lock.
/* oxlint-disable no-await-in-loop */
import { _electron as electron, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { assertNativeElectronTestAllowed } from '../playwright-harness.mjs';

assertNativeElectronTestAllowed();
if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
  throw new Error('A real native cloud desktop display is required.');
const root = resolvePath(process.argv[2] ?? process.cwd());
const output = resolvePath(process.argv[3] ?? join(root, 'desktop-performance.json'));
const samples = Number(process.env.SELENE_PERFORMANCE_SAMPLES ?? 5);
const sessionMs = Number(process.env.SELENE_PERFORMANCE_SESSION_MS ?? 180000);
const noticeCalls = Number(process.env.SELENE_PERFORMANCE_NOTICE_CALLS ?? 10000);
const diagnosticGc = process.env.SELENE_PERFORMANCE_DIAGNOSTIC_GC === 'true';
const largeSourceProbe = process.env.SELENE_PERFORMANCE_LARGE_SOURCE === 'true';
if (!Number.isSafeInteger(noticeCalls) || noticeCalls < 0 || noticeCalls > 20000)
  throw new Error('Use a notice burst from 0 to 20000 calls.');
if (!Number.isSafeInteger(samples) || samples < 3 || samples > 20)
  throw new Error('Use between 3 and 20 launch samples.');
if (!Number.isSafeInteger(sessionMs) || sessionMs < 0 || sessionMs > 3600000)
  throw new Error('Use a sustained session duration from 0 to 3600000 milliseconds.');
const require = createRequire(join(root, 'apps/desktop/package.json'));
const electronDirectory = dirname(require.resolve('electron'));
const executablePath = join(
  electronDirectory,
  'dist',
  (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim()
);
const profile = await mkdtemp(join(tmpdir(), 'selene-performance-profile-'));
async function buildInventory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const inventory = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) inventory.push(...(await buildInventory(file)));
    else if (entry.isFile()) {
      const bytes = await readFile(file);
      inventory.push({
        path: relative(root, file),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      });
    }
  }
  return inventory;
}
let sourceCommit;
let trackedSourceDiffSha256;
try {
  sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  trackedSourceDiffSha256 = createHash('sha256')
    .update(execFileSync('git', ['-C', root, 'diff', '--binary', 'HEAD']))
    .digest('hex');
} catch {
  sourceCommit = 'unavailable';
}
const launches = [];
const cleanup = [];
const reports = {
  methodology: {
    platform: process.platform,
    sourceCommit,
    trackedSourceDiffSha256,
    builtFiles: await buildInventory(join(root, 'apps/desktop/out')),
    node: process.version,
    timestamp: new Date().toISOString(),
    productionMainSha256: createHash('sha256')
      .update(await readFile(join(root, 'apps/desktop/out/main/index.js')))
      .digest('hex'),
    harnessSha256: createHash('sha256')
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest('hex'),
    profile: 'isolated temporary profile, retained between clean launches',
    cache: 'first-profile and warm-profile launches; OS page cache is not flushed',
    clock:
      'monotonic wall clock; UI operations include Playwright dispatch and two animation-frame callbacks',
    previewDocumentFence:
      'new bootstrap nonce and current host revision, unhidden visible content, original navigation URL when available, child frame callbacks and unchanged parent src; authored history routing is allowed',
    selectionInput:
      'explicit Selection tool; fonts and authoring camera observed settled before batches; an exposed point of the same exact child target is observed and mapped to physical iframe bounds before click timer; real native mouse input, authorized stage and exact host-selected node required',
    percentile:
      'nearest-rank; small launch/project samples are descriptive observations, not population guarantees',
    frameMeaning: 'renderer animation-frame scheduling gaps; not physical display FPS',
    workingSetUnit: 'KiB from Electron, may include shared pages',
    memoryMeaning:
      'sampled resident/JS heaps, without forced garbage collection; no exact peak claim',
    scope: 'production build, native sandbox and protected storage required',
    sustainedSessionRequestedMs: sessionMs,
    noticeBurstCalls: noticeCalls,
    diagnosticForcedGc: diagnosticGc,
    largeSourceProbe
  },
  launches,
  cleanup,
  rendererEvents: []
};
let saveTail = Promise.resolve();
const save = () => {
  const contents = `${JSON.stringify(reports, null, 2)}\n`;
  saveTail = saveTail.then(() => writeFile(output, contents));
  return saveTail;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const painted = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
const summary = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    samples: values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null
  };
};
async function currentPreviewFrame(page) {
  const handle = await page
    .locator('iframe[title="Generated React preview frame"]')
    .elementHandle();
  if (!handle) throw new Error('Current preview element is unavailable.');
  try {
    const live = await handle.contentFrame();
    if (!live) throw new Error('Current preview document is unavailable.');
    return live;
  } finally {
    await handle.dispose();
  }
}
async function currentPreviewNonce(page) {
  const live = await currentPreviewFrame(page);
  return live.evaluate(() =>
    decodeURIComponent(document.documentElement.dataset.previewNonce ?? '')
  );
}
async function waitForCurrentPreview(page, departingNonce) {
  const deadline = performance.now() + 30000;
  const iframe = page.locator('iframe[title="Generated React preview frame"]');
  const revisionId = await page.evaluate(() =>
    window.selene.designer.snapshot().then((snapshot) => snapshot.source.revision.id)
  );
  while (performance.now() < deadline) {
    const requested = await iframe.getAttribute('src');
    if (!requested?.startsWith('selene-preview://local/'))
      throw new Error('Current preview URL is invalid.');
    const live = await currentPreviewFrame(page);
    let observed;
    try {
      observed = await live.evaluate(
        ({
          requested: requestedUrl,
          revisionId: expectedRevision,
          departingNonce: previousNonce
        }) => {
          const html = document.documentElement;
          const nonce = decodeURIComponent(html.dataset.previewNonce ?? '');
          const currentRevision = decodeURIComponent(html.dataset.previewRevisionId ?? '');
          const navigation = performance.getEntriesByType('navigation')[0]?.name;
          const previewRoot = document.getElementById('root');
          const title = document.querySelector('[data-selene-node-id="designer.title"]');
          if (
            !/^[A-Za-z0-9_-]{16,128}$/u.test(nonce) ||
            nonce === previousNonce ||
            currentRevision !== expectedRevision ||
            (navigation && navigation !== requestedUrl) ||
            !previewRoot ||
            previewRoot.hidden ||
            !title
          )
            return undefined;
          const style = getComputedStyle(title);
          const bounds = title.getBoundingClientRect();
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            bounds.width > 0 &&
            bounds.height > 0
            ? { nonce, revisionId: currentRevision }
            : undefined;
        },
        { requested, revisionId, departingNonce }
      );
      if (observed) {
        await live.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
        const accepted = await live.evaluate(
          ({ nonce, revisionId: acceptedRevision }) =>
            decodeURIComponent(document.documentElement.dataset.previewNonce ?? '') === nonce &&
            decodeURIComponent(document.documentElement.dataset.previewRevisionId ?? '') ===
              acceptedRevision,
          observed
        );
        if (accepted && requested === (await iframe.getAttribute('src'))) return;
      }
    } catch (error) {
      if (
        !/Execution context was destroyed|Cannot find context|Frame was detached/iu.test(
          error.message
        )
      )
        throw error;
    }
    await page.waitForTimeout(16);
  }
  throw new Error('The current preview document did not become visible in 30000ms.');
}
async function waitForSettledAuthoringCamera(page) {
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
  });
  await page
    .frameLocator('iframe[title="Generated React preview frame"]')
    .locator('html')
    .evaluate(async (element) => {
      if (element.ownerDocument.fonts) await element.ownerDocument.fonts.ready;
    });
  let previousTransform;
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const transform = await page
          .locator('.react-flow__viewport')
          .evaluate((element) => getComputedStyle(element).transform);
        stableSamples = transform === previousTransform ? stableSamples + 1 : 0;
        previousTransform = transform;
        return stableSamples;
      },
      { intervals: [80, 120, 160], timeout: 5000 }
    )
    .toBeGreaterThanOrEqual(2);
}
const metrics = (application) =>
  application.evaluate(({ app, safeStorage, BrowserWindow }) => ({
    processMetrics: app.getAppMetrics(),
    encryptedStorage: safeStorage.isEncryptionAvailable(),
    storageBackend:
      process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform,
    mainMemoryBytes: process.memoryUsage(),
    electron: process.versions.electron,
    windows: BrowserWindow.getAllWindows().map((window) => {
      const preferences = window.webContents.getLastWebPreferences();
      return {
        sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        contentBounds: window.getContentBounds()
      };
    })
  }));
const identities = new Map();
async function procIdentity(pid) {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = contents.slice(contents.lastIndexOf(')') + 2).split(' ');
    return { pid, state: fields[0], ppid: Number(fields[1]), start: fields[19] };
  } catch {
    return undefined;
  }
}
async function trackProcesses(native) {
  if (process.platform !== 'linux') return;
  const current = (
    await Promise.all(
      (await readdir('/proc'))
        .filter((entry) => /^\d+$/u.test(entry))
        .map((pid) => procIdentity(Number(pid)))
    )
  ).filter(Boolean);
  const owned = new Set(native.processMetrics.map(({ pid }) => pid));
  let added = true;
  while (added) {
    added = false;
    for (const identity of current) {
      if (owned.has(identity.ppid) && !owned.has(identity.pid)) {
        owned.add(identity.pid);
        added = true;
      }
    }
  }
  for (const identity of current) {
    if (owned.has(identity.pid)) identities.set(identity.pid, identity);
  }
}
async function closeAndCheck(application, label) {
  const native = await metrics(application);
  await trackProcesses(native);
  const owned = [...identities.values()];
  const start = performance.now();
  await application.close();
  let remaining = [];
  do {
    remaining = (
      await Promise.all(
        owned.map(async (identity) => {
          const current = await procIdentity(identity.pid);
          return current?.start === identity.start && current.state !== 'Z' ? current : undefined;
        })
      )
    ).filter(Boolean);
    if (remaining.length) await delay(100);
  } while (remaining.length && performance.now() - start < 10000);
  cleanup.push({
    label,
    observedProcessCount: owned.length,
    closeToNoLiveProcessesMs: performance.now() - start,
    liveProcesses: remaining
  });
  identities.clear();
  await save();
  if (remaining.length)
    throw new Error(
      `Owned native processes survived close: ${remaining.map(({ pid }) => pid).join(', ')}`
    );
}
async function resourceInventory(page) {
  const observed = await page.evaluate(() => {
    const timing = performance
      .getEntriesByType('resource')
      .filter((entry) => /\.(?:js|css)$/u.test(new URL(entry.name).pathname))
      .map((entry) => ({
        url: entry.name,
        duration: entry.duration,
        decodedBytes: entry.decodedBodySize
      }));
    if (timing.length > 0) return { coverage: 'resource-timing', entries: timing };
    const urls = Array.from(
      document.querySelectorAll('script[src],link[rel="stylesheet"],link[rel="modulepreload"]')
    )
      .map((element) => (element instanceof HTMLScriptElement ? element.src : element.href))
      .filter((url) => /\.(?:js|css)$/u.test(new URL(url).pathname));
    return {
      coverage:
        'DOM-linked-initial-assets-only; file ResourceTiming unavailable; not a complete dynamic-request inventory',
      entries: Array.from(new Set(urls)).map((url) => ({ url, duration: null, decodedBytes: null }))
    };
  });
  const entries = await Promise.all(
    observed.entries.map(async ({ url, ...resource }) => {
      const file = fileURLToPath(url);
      const path = relative(join(root, 'apps/desktop/out/renderer'), file);
      if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`))
        throw new Error('Unexpected renderer resource outside the production output.');
      return { ...resource, path, emittedBytes: (await stat(file)).size };
    })
  );
  return { coverage: observed.coverage, entries };
}

async function snapshotIpc(page, requestedCount = 100, selectScenarios = false) {
  const result = await page.evaluate(
    async ({ count, scenario }) => {
      const first = await window.selene.designer.snapshot();
      const times = [];
      let last = first;
      for (let index = 0; index < count; index += 1) {
        const start = performance.now();
        last = scenario
          ? await window.selene.designer.selectScenario(
              first.scenarios[index % first.scenarios.length].id
            )
          : await window.selene.designer.snapshot();
        times.push(performance.now() - start);
      }
      return {
        times,
        calls: count,
        transientNotices: last.activity.length,
        snapshotJsonCharacters: JSON.stringify(last).length
      };
    },
    { count: requestedCount, scenario: selectScenarios }
  );
  return { ...result, times: summary(result.times) };
}
async function memoryCheckpoint(application, page, cdp) {
  const native = await metrics(application);
  await trackProcesses(native);
  const renderer = await cdp.send('Performance.getMetrics');
  const dom = await cdp.send('Memory.getDOMCounters');
  return {
    native,
    renderer: Object.fromEntries(renderer.metrics.map(({ name, value }) => [name, value])),
    dom,
    previewFrames: page.frames().length - 1,
    snapshot: await snapshotIpc(page, 10)
  };
}
let application;
const watchdogMs = Math.max(120000, sessionMs + 180000);
const watchdog = setTimeout(async () => {
  reports.error = {
    name: 'NativePerformanceTimeout',
    message: `Native benchmark exceeded ${watchdogMs}ms; partial observations retained.`
  };
  await save();
  const main = application?.process();
  if (main && !main.killed) main.kill('SIGKILL');
  process.exitCode = 1;
}, watchdogMs);
watchdog.unref();
try {
  for (let launchIndex = 0; launchIndex < samples; launchIndex += 1) {
    const launchStart = performance.now();
    application = await electron.launch({
      executablePath,
      args: [
        join(root, 'apps/desktop/out/main/index.js'),
        `--user-data-dir=${profile}`,
        ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [])
      ]
    });
    const page = await application.firstWindow();
    for (const event of ['crash', 'close', 'pageerror']) {
      page.on(event, (error) => {
        if (reports.rendererEvents.length >= 100) return;
        reports.rendererEvents.push({
          event,
          sample: launchIndex + 1,
          timestamp: new Date().toISOString(),
          ...(error instanceof Error ? { message: error.message } : {})
        });
        void save();
      });
    }
    page.setDefaultTimeout(30000);
    await expect(page.getByRole('main', { name: 'Selene project launchpad' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project', exact: true })).toBeEnabled();
    await painted(page);
    const readyMs = performance.now() - launchStart;
    const native = await metrics(application);
    if (
      !native.encryptedStorage ||
      native.storageBackend === 'basic_text' ||
      native.windows.some(
        ({ sandbox, contextIsolation, nodeIntegration }) =>
          !sandbox || !contextIsolation || nodeIntegration
      )
    )
      throw new Error(
        'Native protected storage or sandbox is unavailable; performance run aborted.'
      );
    const resources = await resourceInventory(page);
    launches.push({
      kind: launchIndex === 0 ? 'first-profile' : 'warm-profile',
      readyMs,
      ...native,
      rendererViewport: await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      })),
      resourceCoverage: resources.coverage,
      resources: resources.entries
    });
    reports.launchReadyMs = summary(launches.map((launch) => launch.readyMs));
    await save();
    console.log(JSON.stringify({ stage: 'launch', sample: launchIndex + 1, readyMs }));
    if (launchIndex < samples - 1) {
      await closeAndCheck(application, `launch-${launchIndex + 1}`);
      application = undefined;
      continue;
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    // Seed a real second local project through the trusted public host contract.
    // The measured create, preview and reopen journeys still use real UI controls.
    await page.evaluate(() =>
      window.selene.designer.createProject({
        id: 'performance-second',
        name: 'Performance second',
        template: 'blank'
      })
    );
    await page.getByLabel('Project name', { exact: true }).fill('Performance fixture');
    const createStart = performance.now();
    await page.getByRole('button', { name: 'Create project', exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          window.selene.designer.snapshot().then((snapshot) => snapshot.source.projectId)
        )
      )
      .toBe('performance-fixture');
    const frame = page.frameLocator('iframe[title="Generated React preview frame"]');
    await waitForCurrentPreview(page);
    await painted(page);
    reports.projectCreateToPaintMs = performance.now() - createStart;
    await page.screenshot({ path: output.replace(/\.json$/u, '-workspace.png') });
    await page.evaluate(() => {
      window.selenePerformanceSample = {
        gaps: [],
        longTasks: [],
        last: performance.now(),
        running: true
      };
      const sample = (now) => {
        const state = window.selenePerformanceSample;
        if (!state.running) return;
        if (now >= state.last) state.gaps.push(now - state.last);
        state.last = now;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const observer = new PerformanceObserver((list) =>
        window.selenePerformanceSample.longTasks.push(
          ...list.getEntries().map((entry) => entry.duration)
        )
      );
      observer.observe({ type: 'longtask', buffered: false });
      window.selenePerformanceSample.observer = observer;
    });
    async function selections(count, offset = 0) {
      await page.getByRole('button', { name: 'Selection', exact: true }).click();
      await waitForSettledAuthoringCamera(page);
      const times = [];
      for (let selection = 0; selection < count; selection += 1) {
        const nodeId = (selection + offset) % 2 === 0 ? 'designer.title' : 'designer.summary';
        const target = frame.locator(`[data-selene-node-id="${nodeId}"]`);
        // Chromium locator input can misproject a CSS-transformed native iframe.
        // Map the observed child target to the actual parent iframe bounds, as
        // the independent first-user native test does, without fabricating IPC.
        const targetBounds = await target.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight
          };
        });
        const frameBounds = await page
          .locator('iframe[title="Generated React preview frame"]')
          .boundingBox();
        const nativeBounds = native.windows[0]?.contentBounds;
        if (
          !frameBounds ||
          !nativeBounds ||
          targetBounds.width <= 0 ||
          targetBounds.height <= 0 ||
          targetBounds.viewportWidth <= 0 ||
          targetBounds.viewportHeight <= 0
        )
          throw new Error('The authored selection target has no physical frame bounds.');
        const rejectedPoints = [];
        let physicalPoint;
        let inputOwner;
        // Preserve the same alternating authored node while avoiding its
        // contextual toolbar. Only observed points owned by that exact child
        // alias and the current native bridge/iframe are eligible for input.
        for (const [horizontal, vertical] of [
          [0.5, 0.5],
          [0.95, 0.5],
          [0.05, 0.5],
          [0.5, 0.95],
          [0.5, 0.05],
          [0.95, 0.95],
          [0.05, 0.95],
          [0.95, 0.05],
          [0.05, 0.05]
        ]) {
          const childPoint = {
            x: targetBounds.left + targetBounds.width * horizontal,
            y: targetBounds.top + targetBounds.height * vertical
          };
          const childOwned = await target.evaluate((element, point) => {
            const hit = element.ownerDocument.elementFromPoint(point.x, point.y);
            return hit?.closest('[data-selene-node-id]') === element;
          }, childPoint);
          const candidate = {
            x: frameBounds.x + (childPoint.x / targetBounds.viewportWidth) * frameBounds.width,
            y: frameBounds.y + (childPoint.y / targetBounds.viewportHeight) * frameBounds.height
          };
          if (
            !childOwned ||
            candidate.x < 0 ||
            candidate.y < 0 ||
            candidate.x >= nativeBounds.width ||
            candidate.y >= nativeBounds.height
          ) {
            rejectedPoints.push({ childPoint, physicalPoint: candidate, childOwned });
            continue;
          }
          const observed = await page.evaluate((point) => {
            const previewFrame = document.querySelector(
              'iframe[title="Generated React preview frame"]'
            );
            const bridge = previewFrame?.parentElement?.querySelector(
              '[data-selene-native-input-bridge]'
            );
            const hit = document.elementFromPoint(point.x, point.y);
            return {
              nativeSurfaceOwned: !!bridge && (hit === bridge || hit === previewFrame),
              hitClass: hit?.className,
              hitTagName: hit?.tagName,
              bridgeState: bridge?.getAttribute('data-selene-native-input-state'),
              bridgeHidden: bridge?.hasAttribute('hidden'),
              ...(!bridge || (hit !== bridge && hit !== previewFrame)
                ? {
                    hitHtml: hit?.outerHTML.slice(0, 1200),
                    selectedToolbars: Array.from(
                      document.querySelectorAll('.artifact-selection-toolbar-stack')
                    ).map((toolbar) => toolbar.getBoundingClientRect().toJSON())
                  }
                : {})
            };
          }, candidate);
          // Mirror the isolated preload's exact matcher: never accept another
          // overlay or fabricate a source-selection proof.
          if (observed.nativeSurfaceOwned) {
            physicalPoint = candidate;
            inputOwner = observed;
            break;
          }
          rejectedPoints.push({ childPoint, physicalPoint: candidate, inputOwner: observed });
        }
        if (!physicalPoint || !inputOwner)
          throw new Error(
            `The authored target has no exposed native input point: ${JSON.stringify({
              nodeId,
              targetBounds,
              frameBounds,
              nativeBounds,
              rejectedPoints
            })}`
          );
        await page.evaluate(() => {
          window.seleneSelectionReceipt = false;
          window.seleneSelectionObserver?.disconnect();
          const surface = document.querySelector('main[aria-label="Selene desktop designer"]');
          if (
            !surface?.hasAttribute('data-selene-preview-channel') ||
            !surface.querySelector('iframe[title="Generated React preview frame"]')
          )
            throw new Error('The live preview selection owner is unavailable.');
          const observer = new MutationObserver(() => {
            if (surface.getAttribute('data-selene-preview-selection-stage') === 'authorized') {
              window.seleneSelectionReceipt = true;
              observer.disconnect();
            }
          });
          observer.observe(surface, {
            attributes: true,
            attributeFilter: ['data-selene-preview-selection-stage']
          });
          window.seleneSelectionObserver = observer;
        });
        const selectStart = performance.now();
        await page.mouse.click(physicalPoint.x, physicalPoint.y);
        await page.waitForFunction(() => window.seleneSelectionReceipt === true);
        await expect(page.getByRole('main', { name: 'Selene desktop designer' })).toHaveAttribute(
          'data-selene-preview-direct-authorized',
          'true',
          { timeout: 5000 }
        );
        const selectedNodeId = await page.evaluate(() =>
          window.selene.designer.snapshot().then((snapshot) => snapshot.selectedNodeId)
        );
        expect(selectedNodeId).toBe(nodeId);
        await painted(page);
        const durationMs = performance.now() - selectStart;
        times.push(durationMs);
        if (!reports.firstAuthorizedSelection) {
          reports.firstAuthorizedSelection = { nodeId, physicalPoint, inputOwner, durationMs };
          console.log(
            JSON.stringify({
              stage: 'first-authorized-selection',
              ...reports.firstAuthorizedSelection
            })
          );
          await save();
        }
      }
      return times;
    }
    const initialSelections = await selections(60);
    reports.selectionToAuthorizedPaintMs = summary(initialSelections);
    reports.snapshotIpc = await snapshotIpc(page);
    reports.initialWorkspace = await memoryCheckpoint(application, page, cdp);
    const refreshes = [];
    async function refreshPreview() {
      const departingNonce = await currentPreviewNonce(page);
      const prior = await page
        .locator('iframe[title="Generated React preview frame"]')
        .getAttribute('src');
      const start = performance.now();
      await page.getByRole('button', { name: 'Render', exact: true }).click();
      await expect(
        page.locator('iframe[title="Generated React preview frame"]')
      ).not.toHaveAttribute('src', prior);
      await waitForCurrentPreview(page, departingNonce);
      await painted(page);
      return performance.now() - start;
    }
    for (let refresh = 0; refresh < 10; refresh += 1) refreshes.push(await refreshPreview());
    reports.warmPreviewRefreshToPaintMs = summary(refreshes);
    const modeRoundTrips = [];
    for (let modeIndex = 0; modeIndex < 10; modeIndex += 1) {
      const presentationNonce = await currentPreviewNonce(page);
      const start = performance.now();
      await page.getByRole('button', { name: 'Present', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Prototype presentation' })).toBeVisible();
      await waitForCurrentPreview(page, presentationNonce);
      const authoringNonce = await currentPreviewNonce(page);
      await page.getByRole('button', { name: /^Exit/ }).click();
      await expect(page.getByRole('region', { name: 'Design canvas' })).toBeVisible();
      await waitForCurrentPreview(page, authoringNonce);
      await painted(page);
      modeRoundTrips.push(performance.now() - start);
    }
    reports.presentReturnToPaintMs = summary(modeRoundTrips);
    async function reopenProject(index) {
      await page.getByRole('button', { name: 'Projects', exact: true }).click();
      const name = index % 2 === 0 ? 'Performance second' : 'Performance fixture';
      const projectId = index % 2 === 0 ? 'performance-second' : 'performance-fixture';
      const departingNonce = await currentPreviewNonce(page);
      const start = performance.now();
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.locator('.project-kicker')).toBeVisible();
      await expect(page.locator('.project-kicker')).toHaveAttribute(
        'aria-label',
        new RegExp(`^Active project: (?:${projectId}|${name})$`, 'u')
      );
      await expect
        .poll(async () =>
          page.evaluate(() =>
            window.selene.designer.snapshot().then((snapshot) => snapshot.source.projectId)
          )
        )
        .toBe(projectId);
      await waitForCurrentPreview(page, departingNonce);
      await painted(page);
      return performance.now() - start;
    }
    const projectReopens = [];
    for (let reopenIndex = 0; reopenIndex < 12; reopenIndex += 1)
      projectReopens.push(await reopenProject(reopenIndex));
    reports.warmProjectOpenToPaintMs = summary(projectReopens);
    await save();
    console.log(
      JSON.stringify({
        stage: 'initial-journeys',
        createMs: reports.projectCreateToPaintMs,
        selection: reports.selectionToAuthorizedPaintMs
      })
    );
    const sessionStart = performance.now();
    const sessionSelections = [];
    const sessionCheckpoints = [];
    const sustained = {
      elapsedMs: 0,
      cycles: 0,
      selectionToAuthorizedPaintMs: undefined,
      checkpoints: sessionCheckpoints
    };
    reports.sustainedSession = sustained;
    // This burst observes real main-process IPC and bounded/noncanonical notice history.
    // It is reported separately from UI selections and duration-based session evidence.
    reports.noticeBurst = await snapshotIpc(page, noticeCalls, true);
    reports.afterNoticeBurst = await memoryCheckpoint(application, page, cdp);
    if (diagnosticGc) {
      await cdp.send('HeapProfiler.collectGarbage');
      reports.diagnosticAfterNoticeBurstGc = await memoryCheckpoint(application, page, cdp);
    }
    await save();
    while (performance.now() - sessionStart < sessionMs) {
      sessionSelections.push(...(await selections(10)));
      await refreshPreview();
      await reopenProject(sustained.cycles);
      sustained.cycles += 1;
      sustained.elapsedMs = performance.now() - sessionStart;
      if (sustained.cycles % 5 === 0) {
        sessionCheckpoints.push({
          elapsedMs: sustained.elapsedMs,
          ...(await memoryCheckpoint(application, page, cdp))
        });
        sustained.selectionToAuthorizedPaintMs = summary(sessionSelections);
        await save();
      }
      await delay(500);
    }
    sustained.elapsedMs = performance.now() - sessionStart;
    sustained.selectionToAuthorizedPaintMs = summary(sessionSelections);
    reports.afterSession = await memoryCheckpoint(application, page, cdp);
    if (diagnosticGc) {
      await cdp.send('HeapProfiler.collectGarbage');
      reports.diagnosticAfterSessionGc = await memoryCheckpoint(application, page, cdp);
    }
    reports.afterSessionSelectionToAuthorizedPaintMs = summary(await selections(60));
    reports.rendererScheduling = await page.evaluate(() => {
      const state = window.selenePerformanceSample;
      state.running = false;
      state.observer.disconnect();
      window.seleneSelectionObserver?.disconnect();
      return { gaps: state.gaps, longTasks: state.longTasks };
    });
    reports.rendererScheduling.gaps = summary(reports.rendererScheduling.gaps);
    reports.rendererScheduling.longTasks = summary(reports.rendererScheduling.longTasks);
    if (largeSourceProbe) {
      const workspace = await page.evaluate(() =>
        window.selene.designer.snapshot().then((snapshot) => snapshot.source)
      );
      workspace.projectId = 'performance-large-source';
      const featureData = JSON.stringify(
        Array.from({ length: 600 }, (_, row) => ({
          id: `work-${row}`,
          label: `Product work item ${row}`,
          state: row % 3 === 0 ? 'complete' : 'in-review',
          detail:
            'A source-backed product design with local review notes and a documented interaction. '.repeat(
              2
            )
        }))
      );
      workspace.files.push({
        path: 'src/feature-data.json',
        language: 'json',
        content: featureData
      });
      const timestamp = workspace.revision.createdAt;
      const record = {
        format: 'selene-local-project/v2',
        schemaVersion: 2,
        versionSequence: 1,
        project: {
          id: workspace.projectId,
          name: 'Performance large source',
          origin: 'created',
          status: 'active',
          createdAt: timestamp,
          updatedAt: timestamp
        },
        current: workspace,
        versions: [
          {
            id: 'performance-initial-version',
            createdAt: timestamp,
            summary: workspace.revision.summary,
            workspace
          }
        ]
      };
      const importPath = join(profile, 'performance-large-source.json');
      await writeFile(importPath, JSON.stringify(record));
      // The native picker selects a controlled test record; the real host import,
      // lifecycle validation, compile and binding authority remain unchanged.
      await application.evaluate(({ dialog }, path) => {
        const original = dialog.showOpenDialog;
        dialog.showOpenDialog = async () => {
          dialog.showOpenDialog = original;
          return { canceled: false, filePaths: [path] };
        };
      }, importPath);
      await page.evaluate(() => window.selene.designer.chooseProjectToImport());
      // Reload the renderer to resume the host-imported current project. The
      // public setup call does not directly update the mounted React read model.
      await Promise.all([
        page.waitForEvent('domcontentloaded', { timeout: 30000 }),
        page.evaluate(() => window.selene.workspace.reload())
      ]);
      await expect(
        page.getByRole('main', { name: 'Selene desktop designer', exact: true })
      ).toBeVisible();
      await waitForCurrentPreview(page);
      await expect
        .poll(async () =>
          page.evaluate(() =>
            window.selene.designer.snapshot().then((snapshot) => snapshot.source.projectId)
          )
        )
        .toBe(workspace.projectId);
      reports.largeSource = {
        sourceUtf8Bytes: Buffer.byteLength(JSON.stringify(workspace), 'utf8'),
        sourceFiles: workspace.files.length,
        reachablePreviewMeaning:
          'The added feature-data file is legitimate inert project source; the unchanged visible dashboard isolates snapshot payload cost.',
        before: await memoryCheckpoint(application, page, cdp),
        snapshotIpc: await snapshotIpc(page, 1000),
        selectionToAuthorizedPaintMs: summary(await selections(60)),
        after: await memoryCheckpoint(application, page, cdp)
      };
      await save();
    }
    reports.activeMetrics = await metrics(application);
    await metrics(application); // Prime Electron's interval CPU sample before the idle window.
    const idleStart = performance.now();
    await delay(15000);
    reports.idleObservationMs = performance.now() - idleStart;
    reports.idleMetrics = await memoryCheckpoint(application, page, cdp);
    await page.screenshot({ path: output.replace(/\.json$/u, '-after-session.png') });
    await closeAndCheck(application, `session-${launchIndex + 1}`);
    application = undefined;
  }
  reports.complete = true;
  await save();
  console.log(
    JSON.stringify({
      output,
      launchReadyMs: reports.launchReadyMs,
      projectCreateToPaintMs: reports.projectCreateToPaintMs,
      selectionToAuthorizedPaintMs: reports.selectionToAuthorizedPaintMs,
      snapshotIpc: reports.snapshotIpc,
      sustainedSessionMs: reports.sustainedSession.elapsedMs,
      cleanupLiveProcesses: cleanup.flatMap(({ liveProcesses }) => liveProcesses)
    })
  );
} catch (error) {
  reports.error = { name: error.name, message: error.message };
  await save();
  throw error;
} finally {
  clearTimeout(watchdog);
  if (application)
    await closeAndCheck(application, 'failed-run').catch((error) => console.error(error.message));
  await rm(profile, { recursive: true, force: true });
}
