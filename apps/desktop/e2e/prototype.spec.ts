import { _electron as electron, expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { harnessIdentity } from '../../../scripts/playwright-harness.mjs';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const agentFixture = fileURLToPath(new URL('./designer-agent.fixture.mjs', import.meta.url));
const require = createRequire(import.meta.url);
// Match the production preview coordinator's compile, authenticated-init,
// React-commit, and paint receipt budget without relaxing interaction waits.
const previewPresentationTimeout = 15_000;
const directSelectionBudgetMs = 5_000;
const directEditRoundTripBudgetMs = previewPresentationTimeout;

function desktopArgs(userData: string): string[] {
  return [mainEntry, `--user-data-dir=${userData}`];
}

async function electronExecutable(): Promise<string> {
  const electronEntry = require.resolve('electron');
  const electronDirectory = dirname(electronEntry);
  const executable = (await readFile(join(electronDirectory, 'path.txt'), 'utf8')).trim();
  return join(electronDirectory, 'dist', executable);
}

async function closeElectron(
  application: Awaited<ReturnType<typeof electron.launch>>
): Promise<void> {
  const process = application.process();
  const closed = application.waitForEvent('close', { timeout: 2_000 });
  try {
    await application.evaluate(({ app }) => {
      app.quit();
      return true;
    });
    await closed;
  } catch {
    if (process.exitCode !== null) return;
    const forcedClose = application.waitForEvent('close', { timeout: 2_000 });
    process.kill('SIGKILL');
    await forcedClose;
  }
}

/** Trigger Electron's real fatal-process path without adding a production-only test switch. */
async function crashElectron(
  application: Awaited<ReturnType<typeof electron.launch>>
): Promise<void> {
  const process = application.process();
  const closed = application.waitForEvent('close', { timeout: 5_000 });
  await application
    .evaluate(() => {
      process.emit('uncaughtException', new Error('desktop e2e fatal crash'));
      return true;
    })
    .catch(() => undefined);
  await closed;
  expect(process.exitCode).toBe(1);
}

async function crashAndRestart(userData: string, remaining: number): Promise<void> {
  if (remaining === 0) return;
  const crashing = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  await crashing.firstWindow({ timeout: 5_000 });
  await crashElectron(crashing);
  await crashAndRestart(userData, remaining - 1);
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Second Electron instance did not exit after single-instance rejection.'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function openProjectFromLaunchpad(window: Page, projectName: string): Promise<void> {
  const projectNameInput = window.getByLabel('Project name');
  await expect(projectNameInput).toBeVisible({ timeout: 5_000 });
  await projectNameInput.fill(projectName);
  await window.getByRole('button', { name: 'Create project' }).click({ timeout: 5_000 });
  await expect(window.getByRole('main', { name: 'Selene desktop designer' })).toBeVisible({
    timeout: 5_000
  });
}

type ToolbarDiagnosticsState = {
  readonly busy: string | undefined;
  readonly consent: string | undefined;
  readonly consentChecked: boolean | undefined;
  readonly consentDisabled: boolean | undefined;
  readonly recovery: string | undefined;
  readonly saving: string | undefined;
};

const PACKAGED_DIAGNOSTICS_READ_DEADLINE_MS = 1_000;

async function toolbarDiagnosticsState(window: Page): Promise<ToolbarDiagnosticsState> {
  return window.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('[data-diagnostics-consent]');
    const consent = document.querySelector<HTMLInputElement>('.workspace-toolbar__consent input');
    return {
      busy: panel?.dataset.diagnosticsBusy,
      consent: panel?.dataset.diagnosticsConsent,
      consentChecked: consent?.checked,
      consentDisabled: consent?.disabled,
      recovery: panel?.dataset.diagnosticsRecovery,
      saving: panel?.dataset.diagnosticsSaving
    };
  });
}

async function readBoundedDeviceGlobalDiagnostics<Value>(
  window: Page,
  operation: 'consent' | 'recovery',
  read: () => Promise<Value>
): Promise<Value> {
  const outcome = await new Promise<
    | { readonly kind: 'fulfilled'; readonly value: Value }
    | { readonly kind: 'failed'; readonly message: string }
    | { readonly kind: 'pending' }
  >((resolve) => {
    const deadline = setTimeout(
      () => resolve({ kind: 'pending' }),
      PACKAGED_DIAGNOSTICS_READ_DEADLINE_MS
    );
    void Promise.resolve()
      .then(read)
      .then(
        (value) => {
          clearTimeout(deadline);
          resolve({ kind: 'fulfilled', value });
        },
        (error: unknown) => {
          clearTimeout(deadline);
          resolve({
            kind: 'failed',
            message: error instanceof Error ? error.message : 'unknown diagnostics bridge error'
          });
        }
      );
  });
  if (outcome.kind === 'fulfilled') return outcome.value;
  const toolbar = await toolbarDiagnosticsState(window);
  throw new Error(
    `Device-global diagnostics ${operation} read ${outcome.kind}${
      outcome.kind === 'failed' ? `: ${outcome.message}` : ''
    }; toolbar=${JSON.stringify(toolbar)}`
  );
}

test('rejects a second Electron process for the same local user-data owner', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-single-instance-'));
  const first = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  let second: ChildProcess | undefined;
  try {
    await first.firstWindow({ timeout: 5_000 });
    second = spawn(await electronExecutable(), desktopArgs(userData), {
      stdio: 'ignore'
    });
    expect(await waitForExit(second)).toBe(0);
    expect(first.process().exitCode).toBeNull();
  } finally {
    if (second?.exitCode === null) second.kill('SIGKILL');
    await closeElectron(first);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('survives real fatal restarts, enters durable recovery, and resumes previews only on request', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-recovery-'));
  try {
    await crashAndRestart(userData, 2);
    // This is deliberately a fresh-process assertion, not a mocked codec: fatal starts survive
    // a kill/restart cycle as encrypted private disk evidence.
    const crashEvidence = await readFile(
      join(userData, 'private-diagnostics-v1', 'crash-starts.json'),
      'utf8'
    );
    expect(crashEvidence).toMatch(/^selene-safe-storage\/v1:/);
    expect(crashEvidence).not.toContain('[');
    expect(crashEvidence).not.toContain('desktop e2e fatal crash');
    const application = await electron.launch({
      executablePath: await electronExecutable(),
      args: desktopArgs(userData)
    });
    const window = await application.firstWindow({ timeout: 5_000 });
    try {
      const recoveryProjectName = 'Recovery resume test';
      await expect(window.getByRole('main', { name: 'Selene project launchpad' })).toBeVisible();
      await expect(window.getByRole('alert')).toContainText(
        'Recovery is active after 3 startup attempts. Project actions are unavailable.'
      );
      await window.getByLabel('Project name').fill(recoveryProjectName);
      await expect(window.getByRole('button', { name: 'Create project' })).toBeDisabled();
      await window.getByRole('button', { name: 'Resume previews' }).click();
      await expect(window.getByRole('alert')).toBeHidden();
      await expect(window.getByRole('status')).toContainText('Preview execution resumed.');
      await openProjectFromLaunchpad(window, recoveryProjectName);
      await expect(window.getByRole('button', { name: 'Render' })).toBeEnabled();
    } finally {
      await closeElectron(application);
    }
  } finally {
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('fails closed in a separate desktop process when safeStorage is unavailable', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-safe-storage-denied-'));
  const privateDirectory = join(userData, 'private-diagnostics-v1');
  let denied: ChildProcess | undefined;
  try {
    denied = spawn(await electronExecutable(), desktopArgs(userData), {
      stdio: 'ignore',
      env: { ...process.env, SELENE_DIAGNOSTICS_FORCE_SAFE_STORAGE_UNAVAILABLE: '1' }
    });
    expect(await waitForExit(denied)).toBe(1);
    await expect(access(privateDirectory)).rejects.toThrow();
  } finally {
    if (denied?.exitCode === null) denied.kill('SIGKILL');
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('keeps privacy controls explicit and local in the desktop recovery-capable shell', async ({
  browserName: _browserName
}, testInfo) => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-privacy-'));
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  const evidencePath = testInfo.outputPath('desktop-privacy-diagnostics-evidence.json');
  const evidence: unknown[] = [];
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    window.on('console', (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
    window.on('pageerror', (error) => pageErrors.push(error.message));
    const recordEvidence = async (
      checkpoint: string,
      hostReads?: {
        readonly consent: 'unknown' | 'granted' | 'denied';
        readonly recoveryActive: boolean;
      }
    ) => {
      evidence.push({
        checkpoint,
        component: await toolbarDiagnosticsState(window),
        ...(hostReads === undefined ? {} : { hostReads }),
        console: [...consoleMessages],
        pageErrors: [...pageErrors]
      });
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    };
    await recordEvidence('launched');
    await openProjectFromLaunchpad(window, 'Privacy controls test');
    await window.getByRole('button', { name: 'More' }).click();
    const operations = window.getByRole('dialog', { name: 'Workspace operations' });
    await expect(operations).toBeVisible();
    const consent = operations.getByLabel('Store local crash diagnostics on this device');
    await recordEvidence('project opened before privacy controls settle');
    const consentState = await readBoundedDeviceGlobalDiagnostics(window, 'consent', () =>
      window.evaluate(() => window.selene.diagnostics.consent())
    );
    const recoveryState = await readBoundedDeviceGlobalDiagnostics(window, 'recovery', () =>
      window.evaluate(() => window.selene.diagnostics.recovery())
    );
    const hostReads = { consent: consentState.user, recoveryActive: recoveryState.active };
    await recordEvidence('packaged device-global consent and recovery reads settled', hostReads);
    await expect
      .poll(() => toolbarDiagnosticsState(window))
      .toMatchObject({
        busy: 'false',
        consent: consentState.user,
        consentChecked: consentState.user === 'granted',
        consentDisabled: false,
        recovery: recoveryState.active ? 'active' : 'clear',
        saving: 'false'
      });
    await expect(consent).toBeEnabled();
    await recordEvidence('host reads settled and consent is available');
    await consent.check();
    await expect(window.getByText('Local diagnostics enabled.')).toBeVisible();
    await expect(consent).toBeChecked();
    await recordEvidence('granted preference settled');
    await consent.uncheck();
    await expect(window.getByText('Local diagnostics disabled.')).toBeVisible();
    await expect(consent).not.toBeChecked();
    await recordEvidence('denied preference settled');
    await operations.getByRole('button', { name: 'Delete diagnostics' }).click();
    await expect(window.getByText('Deleted local diagnostics.')).toBeVisible();
    await recordEvidence('local diagnostics deleted');
  } finally {
    await testInfo.attach('desktop-privacy-diagnostics-evidence', {
      path: evidencePath,
      contentType: 'application/json'
    });
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('reloads the designer through the capability-limited workspace bridge', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-workspace-reload-'));
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    await openProjectFromLaunchpad(window, 'Workspace reload test');
    const designer = window.getByRole('main', { name: 'Selene desktop designer' });
    await expect(designer).toBeVisible();
    const reloaded = window.waitForEvent('domcontentloaded');
    await window.evaluate(() => window.selene.workspace.reload());
    await reloaded;
    await expect(designer).toBeVisible({ timeout: 5_000 });
    await expect(window.getByRole('main', { name: 'Selene project launchpad' })).toHaveCount(0);
    await expect
      .poll(() => window.evaluate(() => window.selene.apiVersion))
      .toBe('selene-desktop-preload/v10');
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('configured JSONL agent revises, renders, baselines, and exports a stale handoff', async () => {
  test.setTimeout(60_000);
  const userData = await mkdtemp(join(tmpdir(), `selene-${harnessIdentity()}-desktop-e2e-`));
  const diagnostics: string[] = [];
  await writeFile(
    join(userData, 'designer-agents.json'),
    JSON.stringify({
      version: 'selene-desktop-agents/v1',
      agents: [
        {
          id: 'configured-jsonl-agent',
          label: 'Configured JSONL agent',
          command: process.execPath,
          args: [agentFixture, 'success'],
          workspaceRoot: process.cwd(),
          readOnly: true,
          capabilityGrants: ['react.revise'],
          designOperation: 'react.revise',
          requestTimeoutMs: 10_000
        }
      ]
    })
  );
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  application
    .process()
    .stdout?.on('data', (chunk: Buffer) =>
      diagnostics.push(`desktop stdout: ${chunk.toString().trim()}`)
    );
  application
    .process()
    .stderr?.on('data', (chunk: Buffer) =>
      diagnostics.push(`desktop stderr: ${chunk.toString().trim()}`)
    );
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    await window.setViewportSize({ width: 1280, height: 900 });
    window.on('console', (message) =>
      diagnostics.push(`console ${message.type()}: ${message.text()}`)
    );
    window.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
    window.on('requestfailed', (request) =>
      diagnostics.push(
        `requestfailed ${request.url()}: ${request.failure()?.errorText ?? 'unknown'}`
      )
    );
    const failure = (error: unknown) =>
      new Error(
        `${error instanceof Error ? error.message : 'Desktop E2E assertion failed.'}\nDiagnostics:\n${diagnostics.join('\n') || '(none)'}`
      );

    try {
      await openProjectFromLaunchpad(window, 'Configured agent test');
      await expect(window.getByLabel('Compiled React artboard')).toBeVisible({ timeout: 5_000 });
      await expect(
        window
          .frameLocator('iframe[title="Generated React preview frame"]')
          .getByRole('heading', { name: 'Dashboard' })
      ).toBeVisible({ timeout: previewPresentationTimeout });
      expect(diagnostics.filter((entry) => entry.startsWith('pageerror '))).toEqual([]);
      await window.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
      const inspectorTabList = window.getByRole('tablist', {
        name: 'Workspace inspector',
        exact: true
      });
      await expect(inspectorTabList).toBeVisible();
      const inspectorTabGeometry = await inspectorTabList.evaluate((list) => {
        const bounds = list.getBoundingClientRect();
        const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')].map((tab) => {
          const rect = tab.getBoundingClientRect();
          const style = getComputedStyle(tab);
          return {
            bottom: rect.bottom,
            height: rect.height,
            label: tab.textContent?.trim(),
            left: rect.left,
            right: rect.right,
            scrollHeight: tab.scrollHeight,
            scrollWidth: tab.scrollWidth,
            top: rect.top,
            visible: style.display !== 'none' && style.visibility !== 'hidden',
            width: rect.width
          };
        });
        const overlaps = tabs.flatMap((tab, index) =>
          tabs
            .slice(index + 1)
            .flatMap((other) =>
              tab.left < other.right &&
              tab.right > other.left &&
              tab.top < other.bottom &&
              tab.bottom > other.top
                ? [[tab.label, other.label]]
                : []
            )
        );
        return { bounds: bounds.toJSON(), overlaps, tabs };
      });
      await test.info().attach('workspace-inspector-wide-tab-geometry.json', {
        body: JSON.stringify(inspectorTabGeometry, null, 2),
        contentType: 'application/json'
      });
      expect(inspectorTabGeometry.tabs.map((tab) => tab.label)).toEqual([
        'Inspect',
        'Reviews',
        'Handoff',
        'Setup'
      ]);
      expect(inspectorTabGeometry.overlaps).toEqual([]);
      expect(
        inspectorTabGeometry.tabs.every(
          (tab) =>
            tab.visible &&
            tab.width >= 100 &&
            tab.height >= 34 &&
            tab.scrollWidth <= tab.width &&
            tab.scrollHeight <= tab.height
        )
      ).toBe(true);
      const primaryTargetPosition = { x: 0.28, y: 0.32 };
      const selectedThreadTargetPosition = { x: 0.12, y: 0.12 };
      const reviewTargetEvidence: unknown[] = [];
      const selectNormalizedReviewTarget = async (
        reviewTarget: Locator,
        normalized: { readonly x: number; readonly y: number }
      ) => {
        const targetRect = () =>
          reviewTarget.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return { height: bounds.height, width: bounds.width, x: bounds.x, y: bounds.y };
          });
        const armedRect = await targetRect();
        const bounds = await reviewTarget.boundingBox();
        if (!bounds || bounds.width <= 0 || bounds.height <= 0)
          throw new Error('Review target layer must expose a physical artifact plane.');
        const gesture = {
          bounds: { height: bounds.height, width: bounds.width },
          normalized,
          position: {
            x: bounds.x + bounds.width * normalized.x,
            y: bounds.y + bounds.height * normalized.y
          }
        };
        const hitOwnership = await reviewTarget.evaluate((element, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            hitAriaLabel: hit?.getAttribute('aria-label') ?? null,
            hitClass: hit instanceof HTMLElement ? hit.className : null,
            hitTag: hit?.tagName ?? null,
            ownedByTarget: hit !== null && (hit === element || element.contains(hit))
          };
        }, gesture.position);
        expect(hitOwnership.ownedByTarget, JSON.stringify(hitOwnership)).toBe(true);
        await window.mouse.move(gesture.position.x, gesture.position.y);
        const beforePointerDownRect = await targetRect();
        await window.mouse.down();
        const beforePointerUpRect = await targetRect();
        for (const rect of [beforePointerDownRect, beforePointerUpRect]) {
          expect(Math.abs(rect.x - armedRect.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(rect.y - armedRect.y)).toBeLessThanOrEqual(1);
          expect(Math.abs(rect.width - armedRect.width)).toBeLessThanOrEqual(1);
          expect(Math.abs(rect.height - armedRect.height)).toBeLessThanOrEqual(1);
        }
        await window.mouse.up();
        const delivery = await window.evaluate(() => ({
          activeTargetLayers: document.querySelectorAll('.preview-target-layer').length,
          selectionMarkers: document.querySelectorAll('.artifact-selection-marker').length,
          aiMarkers: document.querySelectorAll('[aria-label="Saved AI target"]').length,
          reviewMarkers: document.querySelectorAll('[aria-label="Saved stakeholder review target"]')
            .length,
          status: [
            ...document.querySelectorAll<HTMLElement>('[aria-live], [role="status"], output')
          ]
            .map((element) => element.textContent?.trim())
            .filter((value): value is string => Boolean(value))
        }));
        await test.info().attach('review-target-delivery-evidence.json', {
          body: JSON.stringify(
            {
              armedRect,
              beforePointerDownRect,
              beforePointerUpRect,
              delivery,
              gesture,
              hitOwnership
            },
            null,
            2
          ),
          contentType: 'application/json'
        });
        const marker = window.getByLabel('Selected artifact area');
        await expect(marker).toBeVisible();
        const selection = await marker.evaluate(
          (element, target) => ({
            normalized: {
              x: Number.parseFloat(element.style.left) / 100,
              y: Number.parseFloat(element.style.top) / 100
            },
            target
          }),
          normalized
        );
        expect(
          Math.abs(selection.normalized.x - normalized.x) * gesture.bounds.width
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(selection.normalized.y - normalized.y) * gesture.bounds.height
        ).toBeLessThanOrEqual(1);
        return { gesture, selection };
      };
      const createReviewThread = async (
        normalized: { readonly x: number; readonly y: number },
        body: string
      ) => {
        await window
          .getByLabel('Review actions')
          .getByRole('button', { name: 'Select on canvas', exact: true })
          .click();
        const reviewTarget = window.getByRole('button', {
          name: 'Select a point or region on the artifact',
          exact: true
        });
        await expect(reviewTarget).toBeVisible();
        await expect(reviewTarget).toBeEnabled();
        await expect(reviewTarget).toHaveAttribute('data-selection-plane-priority', 'true');
        const selectedTarget = await selectNormalizedReviewTarget(reviewTarget, normalized);
        await window.getByRole('button', { name: 'Comment', exact: true }).click();
        await expect(
          window.getByText('Review target: Point near the top-left.', { exact: true })
        ).toBeVisible();
        await window.getByLabel('Stakeholder review thread body').fill(body);
        const startThread = window.getByRole('button', {
          name: 'Start stakeholder thread',
          exact: true
        });
        await expect(startThread).toBeEnabled();
        reviewTargetEvidence.push({ body, selectedTarget });
        await startThread.click();
        await expect(
          window.getByText('Added and selected the new stakeholder review thread.')
        ).toBeVisible();
        await expect(
          window.getByRole('button', {
            name: `View stakeholder review thread: ${body.replace(/[.!?]+$/u, '')}. Point near the top-left.`,
            exact: true
          })
        ).toBeVisible();
      };
      await window.getByRole('tab', { name: 'Reviews', exact: true }).click();
      await createReviewThread(primaryTargetPosition, 'Saved pin over the AI target.');
      await createReviewThread(
        selectedThreadTargetPosition,
        'Selected review thread over the AI target.'
      );
      await test.info().attach('configured-review-target-normalized-selection.json', {
        body: JSON.stringify(reviewTargetEvidence, null, 2),
        contentType: 'application/json'
      });
      const savedPin = window.getByRole('button', {
        name: 'Select artifact pin marker: Saved pin over the AI target.',
        exact: true
      });
      const selectedPin = window.getByRole('button', {
        name: 'Select artifact pin marker: Selected review thread over the AI target.',
        exact: true
      });
      const savedThreadRow = window.getByRole('button', {
        name: 'View stakeholder review thread: Saved pin over the AI target. Point near the top-left.',
        exact: true
      });
      const savedInspectorPin = window.getByRole('button', {
        name: 'Select artifact pin from inspector: Saved pin over the AI target. Point near the top-left.',
        exact: true
      });
      const selectedThreadCard = window.getByRole('dialog', { name: /Review thread from/ });
      await expect(savedPin).toBeVisible();
      await expect(selectedPin).toBeVisible();
      await expect(savedThreadRow).toBeVisible();
      await expect(savedInspectorPin).toBeVisible();
      await expect(selectedThreadCard).toContainText('Selected review thread over the AI target.');
      const screenSpaceThreadEvidence = await selectedThreadCard.evaluate((card) => {
        const canvas = card.closest<HTMLElement>('.canvas-workspace');
        const artifact = canvas?.querySelector<HTMLElement>('.canvas-artboard__compiled');
        if (!canvas || !artifact)
          throw new Error(
            'Selected review thread must remain owned by the design canvas artifact.'
          );
        const bounds = card.getBoundingClientRect();
        const canvasBounds = canvas.getBoundingClientRect();
        const artifactBounds = artifact.getBoundingClientRect();
        return {
          artifact: artifactBounds.toJSON(),
          canvas: canvasBounds.toJSON(),
          card: bounds.toJSON(),
          computed: {
            overflow: getComputedStyle(artifact).overflow,
            transform: getComputedStyle(card).transform
          },
          withinCanvas:
            bounds.left >= canvasBounds.left &&
            bounds.right <= canvasBounds.right &&
            bounds.top >= canvasBounds.top &&
            bounds.bottom <= canvasBounds.bottom
        };
      });
      await test.info().attach('screen-space-review-thread.json', {
        body: JSON.stringify(screenSpaceThreadEvidence, null, 2),
        contentType: 'application/json'
      });
      await test.info().attach('screen-space-review-thread.png', {
        body: await window.screenshot(),
        contentType: 'image/png'
      });
      expect(screenSpaceThreadEvidence.card.width).toBeGreaterThanOrEqual(280);
      expect(screenSpaceThreadEvidence.card.width).toBeLessThanOrEqual(340);
      expect(screenSpaceThreadEvidence.withinCanvas).toBe(true);
      expect(screenSpaceThreadEvidence.computed.overflow).toBe('visible');
      const artifactReply = selectedThreadCard.getByRole('textbox', {
        name: 'Reply to stakeholder thread',
        exact: true
      });
      await selectedThreadCard
        .getByRole('button', { name: 'Insert @AI mention', exact: true })
        .click();
      const mentionInteractionEvidence = await window.evaluate(() => ({
        activeArtboards: document.querySelectorAll('.react-flow__node[data-selected="true"]')
          .length,
        conversationDialogs: document.querySelectorAll(
          '[data-screen-space-overlay="review-thread"] [role="dialog"]'
        ).length,
        conversationToolbars: document.querySelectorAll(
          '[data-screen-space-overlay="review-thread"]'
        ).length,
        pressedPins: document.querySelectorAll('.preview-pin[aria-pressed="true"]').length,
        selectedReviewRows: Array.from(
          document.querySelectorAll<HTMLElement>(
            '[aria-label^="View stakeholder review thread:"][aria-pressed="true"]'
          )
        ).map((row) => row.getAttribute('aria-label'))
      }));
      await test.info().attach('artifact-conversation-after-ai-mention.json', {
        body: JSON.stringify(mentionInteractionEvidence, null, 2),
        contentType: 'application/json'
      });
      await test.info().attach('artifact-conversation-after-ai-mention.png', {
        body: await window.screenshot(),
        contentType: 'image/png'
      });
      await expect(artifactReply).toHaveValue('@AI ');
      await artifactReply.fill('Agree—keep the primary action visually dominant.');
      await selectedThreadCard.getByRole('button', { name: 'Reply', exact: true }).click();
      await expect(selectedThreadCard).toContainText('Stakeholder reply saved.');
      await expect(selectedThreadCard).toContainText(
        'Agree—keep the primary action visually dominant.'
      );
      await expect(selectedThreadCard).toContainText('1 reply');
      await expect(
        selectedThreadCard.getByRole('button', { name: 'Ask AI', exact: true })
      ).toBeEnabled();
      await selectedThreadCard.getByRole('button', { name: 'Resolve', exact: true }).click();
      await expect(selectedThreadCard).toContainText('Resolved review');
      await expect(selectedThreadCard).toContainText('Stakeholder thread resolved.');
      await selectedThreadCard.getByRole('button', { name: 'Reopen', exact: true }).click();
      await expect(selectedThreadCard).toContainText('Stakeholder review');
      await expect(selectedThreadCard).toContainText('Stakeholder thread reopened.');
      await window.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
      await window.getByLabel('Configured agent').selectOption('configured-jsonl-agent');
      await window.getByLabel('AI change instruction').fill('Make the primary action explicit.');
      const targetAiChange = window
        .getByLabel('Targeted change actions')
        .getByRole('button', { name: 'Select on canvas', exact: true });
      await expect(targetAiChange).toBeEnabled();
      const targetAiDiagnostics = await targetAiChange.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        const describe = (element: Element) => {
          const style = getComputedStyle(element);
          return {
            tag: element.tagName,
            className: element.getAttribute('class'),
            ariaLabel: element.getAttribute('aria-label'),
            pointerEvents: style.pointerEvents,
            zIndex: style.zIndex,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            position: style.position
          };
        };
        const layout = button.closest<HTMLElement>('.workspace-layout');
        return {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          center,
          elementsAtCenter: document.elementsFromPoint(center.x, center.y).map(describe),
          button: describe(button),
          activeElement: document.activeElement ? describe(document.activeElement) : null,
          workspace: layout
            ? {
                centerStage: layout.dataset.centerStage,
                layoutMode: layout.dataset.layoutMode,
                inspectorDrawerOpen: layout.dataset.inspectorDrawerOpen
              }
            : null
        };
      });
      await test.info().attach('target-ai-change-pre-click.json', {
        body: JSON.stringify(targetAiDiagnostics, null, 2),
        contentType: 'application/json'
      });
      await test.info().attach('target-ai-change-pre-click.png', {
        body: await window.screenshot(),
        contentType: 'image/png'
      });
      await targetAiChange.click();
      const spatialTarget = window.getByRole('button', {
        name: 'Select a point or region on the artifact',
        exact: true
      });
      await expect(spatialTarget).toBeVisible();
      await expect(spatialTarget).toBeEnabled();
      const targetPosition = await spatialTarget.evaluate((layer, normalized) => {
        const bounds = layer.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0)
          throw new Error('AI target layer must expose a physical artifact plane.');
        return {
          x: Math.round(bounds.width * normalized.x),
          y: Math.round(bounds.height * normalized.y)
        };
      }, primaryTargetPosition);
      const clickSpatialTarget = async () => {
        const bounds = await spatialTarget.boundingBox();
        if (!bounds) throw new Error('AI target layer must expose a physical artifact plane.');
        await window.mouse.click(bounds.x + targetPosition.x, bounds.y + targetPosition.y);
      };
      const targetLayerDiagnostics = await spatialTarget.evaluate((layer, position) => {
        const bounds = layer.getBoundingClientRect();
        const viewport = layer.closest<HTMLElement>('.canvas-workspace');
        const stage = layer.closest<HTMLElement>('.preview-artifact-content');
        const frame = stage?.querySelector<HTMLIFrameElement>(
          'iframe[title="Generated React preview frame"]'
        );
        if (!viewport || !stage || !frame)
          throw new Error('Target layer is missing the artifact frame containment.');
        const point = { x: bounds.left + position.x, y: bounds.top + position.y };
        const describe = (element: Element) => {
          const style = getComputedStyle(element);
          return {
            tag: element.tagName,
            className: element.getAttribute('class'),
            ariaLabel: element.getAttribute('aria-label'),
            pointerEvents: style.pointerEvents,
            zIndex: style.zIndex,
            display: style.display,
            visibility: style.visibility
          };
        };
        const viewportBounds = viewport.getBoundingClientRect();
        const hitStack = document.elementsFromPoint(point.x, point.y);
        const describeArtifact = (element: HTMLElement) => {
          const artifactBounds = element.getBoundingClientRect();
          return {
            label: element.getAttribute('aria-label'),
            text: element.textContent?.trim(),
            bounds: artifactBounds.toJSON(),
            inert: element.inert,
            pointerEvents: getComputedStyle(element).pointerEvents,
            overlapsPoint:
              point.x >= artifactBounds.left &&
              point.x <= artifactBounds.right &&
              point.y >= artifactBounds.top &&
              point.y <= artifactBounds.bottom
          };
        };
        const pins = Array.from(stage.querySelectorAll<HTMLElement>('.preview-pin')).map(
          describeArtifact
        );
        const selectedThread = viewport.querySelector<HTMLElement>(
          '[data-screen-space-overlay="review-thread"] .spatial-thread-card'
        );
        if (!selectedThread)
          throw new Error('Expected the saved review thread to remain visible before selection.');
        return {
          layer: {
            bounds: bounds.toJSON(),
            position,
            normalized: { x: position.x / bounds.width, y: position.y / bounds.height }
          },
          frame: frame.getBoundingClientRect().toJSON(),
          stage: stage.getBoundingClientRect().toJSON(),
          viewport: {
            bounds: viewportBounds.toJSON(),
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop,
            scrollWidth: viewport.scrollWidth,
            scrollHeight: viewport.scrollHeight
          },
          hit: {
            point,
            insideLayer:
              point.x >= bounds.left &&
              point.x <= bounds.right &&
              point.y >= bounds.top &&
              point.y <= bounds.bottom,
            insideViewport:
              point.x >= viewportBounds.left &&
              point.x <= viewportBounds.right &&
              point.y >= viewportBounds.top &&
              point.y <= viewportBounds.bottom,
            topIsTargetLayer: hitStack[0] === layer,
            stack: hitStack.slice(0, 8).map(describe)
          },
          artifacts: {
            pins,
            selectedThread: describeArtifact(selectedThread)
          }
        };
      }, targetPosition);
      expect(targetLayerDiagnostics.layer.bounds.width).toBeGreaterThan(targetPosition.x);
      expect(targetLayerDiagnostics.layer.bounds.height).toBeGreaterThan(targetPosition.y);
      expect(targetLayerDiagnostics.hit).toMatchObject({
        insideLayer: true,
        insideViewport: true,
        topIsTargetLayer: true
      });
      const savedPinEvidence = targetLayerDiagnostics.artifacts.pins.find(
        (pin) => pin.label === 'Select artifact pin marker: Saved pin over the AI target.'
      );
      expect(savedPinEvidence).toMatchObject({ inert: false });
      expect(savedPinEvidence?.pointerEvents).not.toBe('none');
      expect(targetLayerDiagnostics.artifacts.selectedThread).toMatchObject({
        inert: false,
        overlapsPoint: false,
        text: expect.stringContaining('Selected review thread over the AI target.')
      });
      expect(targetLayerDiagnostics.artifacts.selectedThread.pointerEvents).not.toBe('none');
      await test.info().attach('target-ai-layer-pre-click.json', {
        body: JSON.stringify(targetLayerDiagnostics, null, 2),
        contentType: 'application/json'
      });
      await clickSpatialTarget();
      await expect(spatialTarget).toBeHidden();
      await expect(
        window.getByRole('toolbar', { name: 'Selected artifact actions' })
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expect(spatialTarget).toHaveCount(0);
      await expect(selectedPin).toBeEnabled();
      await selectedPin.click();
      await expect(selectedPin).toHaveAttribute('aria-pressed', 'true');
      await expect(selectedThreadCard.getByLabel('Close selected review thread')).toBeFocused();
      await expect(spatialTarget).toHaveCount(0);
      await targetAiChange.click();
      await expect(spatialTarget).toHaveAttribute('data-selection-plane-priority', 'true');
      await clickSpatialTarget();
      await window
        .getByRole('toolbar', { name: 'Selected artifact actions' })
        .getByRole('button', { name: 'Ask AI', exact: true })
        .click();
      await expect(window.getByRole('toolbar', { name: 'Selected artifact actions' })).toBeHidden();
      await expect(
        window.getByText('Selected artifact anchor is ready for the next AI edit request.')
      ).toBeVisible();
      await window.getByRole('button', { name: 'Send targeted change' }).click();
      await expect(window.getByText('AI update in progress…')).toBeVisible({
        timeout: 5_000
      });
      const conversationHistory = window.getByLabel('AI conversation history');
      const reviewingRequest = conversationHistory
        .locator('[data-status="reviewing"]')
        .filter({ hasText: 'Make the primary action explicit.' });
      await expect(reviewingRequest).toBeVisible({ timeout: previewPresentationTimeout });
      const proposalComparison = window.getByLabel('AI proposal comparison');
      await expect(proposalComparison).toBeVisible();
      await expect(proposalComparison).toHaveAttribute('data-active', 'proposal');
      await expect(
        window.getByRole('button', { name: 'Add a comment anywhere on the artifact' })
      ).toBeDisabled();
      const currentDesign = proposalComparison.getByRole('button', { name: /^Current/ });
      const proposedDesign = proposalComparison.getByRole('button', { name: /^Proposal/ });
      await currentDesign.click();
      await expect(proposalComparison).toHaveAttribute('data-active', 'current');
      await expect(
        window.getByRole('button', { name: 'Add a comment anywhere on the artifact' })
      ).toBeEnabled();
      await expect(
        window
          .getByRole('toolbar', { name: 'Canvas tools' })
          .getByRole('button', { name: '@ Ask AI', exact: true })
      ).toBeDisabled();
      await proposedDesign.click();
      await expect(proposalComparison).toHaveAttribute('data-active', 'proposal');
      await expect(
        reviewingRequest.getByRole('button', {
          name: 'Preview AI proposal: Make the primary action explicit.',
          exact: true
        })
      ).toBeVisible();
      await reviewingRequest
        .getByRole('button', {
          name: 'Accept AI proposal: Make the primary action explicit.',
          exact: true
        })
        .click();
      const appliedRequest = conversationHistory
        .locator('[data-status="applied"]')
        .filter({ hasText: 'Make the primary action explicit.' });
      await expect(appliedRequest).toBeVisible({
        timeout: 5_000
      });
      await expect(appliedRequest.getByLabel('Request context')).toContainText(
        'Point near the top-left'
      );
      const appliedInstruction = appliedRequest.getByText('Make the primary action explicit.', {
        exact: true
      });
      const appliedStatus = appliedRequest.getByText('applied', { exact: true });
      await expect(appliedInstruction).toBeVisible();
      await expect(appliedStatus).toBeVisible();
      const unifiedCanvas = window.getByLabel('Design canvas');
      const compiledArtboard = unifiedCanvas.getByLabel('Compiled React artboard');
      const postSendDiagnostics = {
        conversation: {
          article: await appliedRequest.locator('article').innerText(),
          instruction: await appliedInstruction.innerText(),
          status: await appliedStatus.innerText(),
          context: await appliedRequest.locator('.conversation-context').innerText(),
          outcome: await appliedRequest
            .locator('.conversation-message--agent > p')
            .nth(1)
            .innerText()
        },
        preview: {
          canvasMode: await unifiedCanvas.getAttribute('data-mode'),
          saveStatus: await unifiedCanvas.locator('.canvas-workspace__toolbar output').innerText(),
          state: await compiledArtboard.getAttribute('data-preview-state'),
          buildUrl: await compiledArtboard
            .locator('iframe[title="Generated React preview frame"]')
            .getAttribute('src')
        }
      };
      await test.info().attach('target-ai-change-post-send.json', {
        body: JSON.stringify(postSendDiagnostics, null, 2),
        contentType: 'application/json'
      });
      await test.info().attach('target-ai-change-post-send.png', {
        body: await window.screenshot(),
        contentType: 'image/png'
      });
      const previewFrame = window.locator('iframe[title="Generated React preview frame"]');
      const prototype = window.frameLocator('iframe[title="Generated React preview frame"]');
      const prototypeHeading = prototype.locator('h1[data-selene-node-id="designer.title"]');
      const expectPrototypeHeading = async (label: string) => {
        await expect(prototypeHeading).toBeVisible({ timeout: previewPresentationTimeout });
        await expect(prototypeHeading).toHaveText(label);
      };
      await expectPrototypeHeading('Configured agent dashboard');
      const previewFrameAction = async (expectedAction: {
        readonly label: string;
        readonly nodeId: string;
        readonly portId: string;
      }) => {
        await expect(previewFrame).toBeVisible({ timeout: previewPresentationTimeout });
        const action = prototype.locator(
          `button[data-selene-flow-node="${expectedAction.nodeId}"][data-selene-action-port="${expectedAction.portId}"]`
        );
        await expect(action).toBeVisible({ timeout: previewPresentationTimeout });
        await expect(action).toHaveText(expectedAction.label);
        const actionGeometry = await action.evaluate((button) => {
          const bounds = button.getBoundingClientRect();
          return {
            actionPort: button.getAttribute('data-selene-action-port'),
            bounds: bounds.toJSON(),
            nodeId: button.getAttribute('data-selene-flow-node'),
            tagName: button.tagName,
            text: button.textContent?.trim()
          };
        });
        const geometry = await previewFrame.evaluate((frame, actionDetails) => {
          const bounds = frame.getBoundingClientRect();
          const viewport = frame.closest<HTMLElement>('.canvas-workspace, .canvas-presentation');
          const stage = frame.closest('.preview-artifact-content');
          const artifact = frame.closest<HTMLElement>(
            '.canvas-artboard__compiled, .canvas-presentation__artifact'
          );
          if (
            !(viewport instanceof HTMLElement) ||
            !(stage instanceof HTMLElement) ||
            !(artifact instanceof HTMLElement)
          )
            throw new Error('Generated preview frame is missing its canvas containment.');
          const stageStyle = getComputedStyle(stage);
          const transform = stageStyle.transform;
          const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
          const matrixValues = matrix?.[1]?.split(',').map(Number);
          const viewportBounds = viewport.getBoundingClientRect();
          const stageBounds = stage.getBoundingClientRect();
          const canvasBounds = artifact.getBoundingClientRect();
          const center = {
            x:
              bounds.left +
              (actionDetails.bounds.x + actionDetails.bounds.width / 2) *
                (bounds.width / frame.clientWidth),
            y:
              bounds.top +
              (actionDetails.bounds.y + actionDetails.bounds.height / 2) *
                (bounds.height / frame.clientHeight)
          };
          const actionHitStack = document.elementsFromPoint(center.x, center.y);
          const describe = (element: Element) => ({
            tag: element.tagName,
            className: element.getAttribute('class'),
            title: element.getAttribute('title'),
            ariaLabel: element.getAttribute('aria-label')
          });
          return {
            width: bounds.width,
            height: bounds.height,
            visibility: getComputedStyle(frame).visibility,
            display: getComputedStyle(frame).display,
            stageTransform: transform,
            stageTransformScaleX: matrixValues?.[0] ?? 1,
            stageTransformScaleY: matrixValues?.[3] ?? 1,
            stageZoom: stageStyle.getPropertyValue('zoom').trim(),
            viewport: {
              bounds: viewportBounds.toJSON(),
              scrollbarGutter: getComputedStyle(viewport).scrollbarGutter,
              scrollLeft: viewport.scrollLeft,
              scrollTop: viewport.scrollTop,
              scrollWidth: viewport.scrollWidth,
              scrollHeight: viewport.scrollHeight
            },
            canvas: canvasBounds?.toJSON(),
            stage: stageBounds.toJSON(),
            action: {
              ...actionDetails,
              center,
              withinViewport:
                center.x >= viewportBounds.left &&
                center.x <= viewportBounds.right &&
                center.y >= viewportBounds.top &&
                center.y <= viewportBounds.bottom,
              frameReceivesPointer: actionHitStack[0] === frame,
              hitStack: actionHitStack.map(describe)
            }
          };
        }, actionGeometry);
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.height).toBeGreaterThan(0);
        expect(geometry.visibility).toBe('visible');
        expect(geometry.display).not.toBe('none');
        expect(geometry.stageTransformScaleX).toBe(1);
        expect(geometry.stageTransformScaleY).toBe(1);
        expect(['', 'normal', '1']).toContain(geometry.stageZoom);
        expect(geometry.viewport.scrollbarGutter).toBe('auto');
        expect(geometry.action).toMatchObject({
          actionPort: expectedAction.portId,
          nodeId: expectedAction.nodeId,
          tagName: 'BUTTON',
          text: expectedAction.label,
          withinViewport: true,
          frameReceivesPointer: true
        });
        return { action, geometry };
      };
      const previewNavigationEvidence = async () =>
        prototype.locator('main').evaluate((main) => ({
          route: window.location.pathname,
          location: window.location.href,
          historyState: window.history.state,
          dom: main.innerHTML,
          text: main.textContent,
          heading: main.querySelector('h1')?.textContent,
          action: main.querySelector('button')?.textContent
        }));
      const initialNavigation = await previewNavigationEvidence();
      expect(initialNavigation).toMatchObject({
        route: '/',
        historyState: { screen: 'dashboard' },
        heading: 'Configured agent dashboard'
      });
      const initialFrameGeometry = (
        await previewFrameAction({
          label: 'Open orders',
          nodeId: 'dashboard',
          portId: 'open-orders'
        })
      ).geometry;
      await test.info().attach('target-ai-preview-navigation-before.json', {
        body: JSON.stringify(
          { preview: initialNavigation, frame: initialFrameGeometry, diagnostics },
          null,
          2
        ),
        contentType: 'application/json'
      });
      await test.info().attach('target-ai-preview-navigation-before.png', {
        body: await previewFrame.screenshot({
          animations: 'disabled',
          caret: 'hide',
          timeout: 5_000
        }),
        contentType: 'image/png'
      });
      const flowViewport = window.locator('.react-flow__viewport');
      const readCanvasViewport = () =>
        flowViewport.evaluate((element) => {
          const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
          return { x: matrix.m41, y: matrix.m42, zoom: matrix.m11 };
        });
      const [previewBounds, flowBounds, viewportBeforePan] = await Promise.all([
        previewFrame.boundingBox(),
        window.locator('.react-flow').boundingBox(),
        readCanvasViewport()
      ]);
      if (!previewBounds || !flowBounds)
        throw new Error('Live preview gesture evidence requires physical frame and canvas bounds.');
      // Use a physical point in a generated React button, not the iframe
      // chrome, so the bridge proves that component hit-testing remains live.
      const gesturePoint = initialFrameGeometry.action.center;
      await window.mouse.move(gesturePoint.x, gesturePoint.y);
      const localPointer = {
        x: gesturePoint.x - flowBounds.x,
        y: gesturePoint.y - flowBounds.y
      };
      await window.mouse.wheel(48, 72);
      await expect
        .poll(async () => (await readCanvasViewport()).y)
        .toBeLessThan(viewportBeforePan.y);
      const viewportAfterPan = await readCanvasViewport();
      expect(viewportAfterPan.x).toBeLessThan(viewportBeforePan.x);
      expect(viewportAfterPan.zoom).toBeCloseTo(viewportBeforePan.zoom);
      const viewportBeforePinch = viewportAfterPan;
      const worldBeforePinch = {
        x: (localPointer.x - viewportBeforePinch.x) / viewportBeforePinch.zoom,
        y: (localPointer.y - viewportBeforePinch.y) / viewportBeforePinch.zoom
      };
      await window.keyboard.down('Control');
      try {
        await window.mouse.wheel(0, -120);
      } finally {
        await window.keyboard.up('Control');
      }
      await expect
        .poll(async () => (await readCanvasViewport()).zoom)
        .toBeGreaterThan(viewportBeforePinch.zoom);
      const viewportAfterPinch = await readCanvasViewport();
      const worldAfterPinch = {
        x: (localPointer.x - viewportAfterPinch.x) / viewportAfterPinch.zoom,
        y: (localPointer.y - viewportAfterPinch.y) / viewportAfterPinch.zoom
      };
      expect(Math.abs(worldAfterPinch.x - worldBeforePinch.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(worldAfterPinch.y - worldBeforePinch.y)).toBeLessThanOrEqual(1);
      await test.info().attach('live-preview-canvas-gesture-evidence.json', {
        body: JSON.stringify(
          {
            gesturePoint,
            viewportBeforePan,
            viewportAfterPan,
            viewportBeforePinch,
            viewportAfterPinch,
            worldBeforePinch,
            worldAfterPinch
          },
          null,
          2
        ),
        contentType: 'application/json'
      });
      await unifiedCanvas
        .getByRole('toolbar', { name: 'Canvas tools' })
        .getByRole('button', { name: 'Fit selection', exact: true })
        .click();
      // The unrelated review conversation was closed when the designer made
      // the targeted AI selection. Fitting the current preview selection must
      // not silently resurrect that durable thread.
      await expect(selectedThreadCard).toHaveCount(0);
      await window.keyboard.press('Escape');
      await expect(selectedThreadCard).toHaveCount(0);
      await expect(selectedPin).toHaveAttribute('aria-pressed', 'false');
      let previousFitViewport: Awaited<ReturnType<typeof readCanvasViewport>> | undefined;
      let stableFitSamples = 0;
      await expect
        .poll(
          async () => {
            const current = await readCanvasViewport();
            const settled =
              previousFitViewport !== undefined &&
              Math.abs(current.x - previousFitViewport.x) < 0.25 &&
              Math.abs(current.y - previousFitViewport.y) < 0.25 &&
              Math.abs(current.zoom - previousFitViewport.zoom) < 0.001;
            previousFitViewport = current;
            stableFitSamples = settled ? stableFitSamples + 1 : 0;
            return stableFitSamples >= 2;
          },
          {
            intervals: [80, 80, 120, 160],
            message: 'Selection fit should settle before the artifact receives another click.'
          }
        )
        .toBe(true);
      await expect
        .poll(async () => {
          const [frameBounds, canvasBounds] = await Promise.all([
            previewFrame.boundingBox(),
            window.locator('.react-flow').boundingBox()
          ]);
          if (!frameBounds || !canvasBounds) return false;
          return (
            frameBounds.x >= canvasBounds.x - 1 &&
            frameBounds.y >= canvasBounds.y - 1 &&
            frameBounds.x + frameBounds.width <= canvasBounds.x + canvasBounds.width + 1 &&
            frameBounds.y + frameBounds.height <= canvasBounds.y + canvasBounds.height + 1
          );
        })
        .toBe(true);
      const initialAction = await previewFrameAction({
        label: 'Open orders',
        nodeId: 'dashboard',
        portId: 'open-orders'
      });
      const initialActionHit = await window.evaluate((point) => {
        const stack = document.elementsFromPoint(point.x, point.y);
        return stack.slice(0, 6).map((element) => ({
          ariaLabel: element.getAttribute('aria-label'),
          className: element.getAttribute('class'),
          tagName: element.tagName
        }));
      }, initialAction.geometry.action.center);
      expect(initialActionHit[0]?.tagName, JSON.stringify(initialActionHit, null, 2)).toBe(
        'IFRAME'
      );
      const directSelectionStartedAt = Date.now();
      await window.mouse.click(
        initialAction.geometry.action.center.x,
        initialAction.geometry.action.center.y
      );
      expect(await previewNavigationEvidence()).toMatchObject({
        route: '/',
        historyState: { screen: 'dashboard' },
        heading: 'Configured agent dashboard'
      });
      const selectedElementActions = window.getByRole('toolbar', {
        name: 'Selected React element actions'
      });
      await expect(selectedElementActions).toBeVisible();
      await expect(selectedElementActions.getByRole('button', { name: 'Comment' })).toBeVisible();
      await expect(selectedElementActions.getByRole('button', { name: 'Ask AI' })).toBeVisible();
      await expect(selectedElementActions.getByRole('button', { name: 'Inspect' })).toBeVisible();
      const directManipulationPerformance = {
        budgets: {
          editRoundTripMs: directEditRoundTripBudgetMs,
          selectionMs: directSelectionBudgetMs
        },
        selectionMs: Date.now() - directSelectionStartedAt,
        textEditMs: 0,
        layoutEditMs: 0,
        resizeEditMs: 0,
        moveEditMs: 0
      };
      expect(directManipulationPerformance.selectionMs).toBeLessThanOrEqual(
        directSelectionBudgetMs
      );
      const preDirectTextRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      const preDirectTextFrame = await previewFrame.getAttribute('src');
      const directTextStartedAt = Date.now();
      await selectedElementActions.getByRole('button', { name: 'Edit text' }).click();
      const directTextEditor = window.getByLabel('Edit selected React text');
      await expect(directTextEditor).toBeVisible();
      const directTextArea = directTextEditor.getByLabel('React text');
      await expect(directTextArea).toHaveValue('Open orders');
      await directTextArea.fill('Review orders');
      await directTextEditor.getByRole('button', { name: 'Save text' }).click();
      await expect
        .poll(() =>
          window.evaluate(async () => {
            const current = await window.selene.designer.snapshot();
            return current.source.revision.id;
          })
        )
        .not.toBe(preDirectTextRevision);
      const appliedDirectTextRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      expect(appliedDirectTextRevision).not.toBe(preDirectTextRevision);
      await expect
        .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
        .not.toBe(preDirectTextFrame);
      await expect(prototype.getByRole('button', { name: 'Review orders' })).toBeVisible();
      directManipulationPerformance.textEditMs = Date.now() - directTextStartedAt;
      expect(directManipulationPerformance.textEditMs).toBeLessThanOrEqual(
        directEditRoundTripBudgetMs
      );
      diagnostics.push(
        `artifact direct text source revision: ${preDirectTextRevision} -> ${appliedDirectTextRevision}`
      );
      await window
        .getByRole('toolbar', { name: 'Selected React element actions' })
        .getByRole('button', { name: 'Inspect' })
        .click();
      await window.getByRole('tab', { name: 'Inspect', exact: true }).click();
      const developerDetails = window.getByLabel('Selection developer details');
      await expect(
        developerDetails.getByText('Frame-verified rendered DOM', { exact: true })
      ).toBeVisible();
      await expect(developerDetails.getByText('button', { exact: true })).toBeVisible();
      const layoutEditor = developerDetails.getByLabel('Manual React layout edit');
      await expect(layoutEditor).toBeVisible();
      const initialLayoutRevision = await previewFrame.getAttribute('src');
      const initialLayoutSourceRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      await layoutEditor.getByLabel('Gap', { exact: true }).fill('4px');
      const layoutEditStartedAt = Date.now();
      await layoutEditor.getByRole('button', { name: 'Apply gap', exact: true }).click();
      const layoutEditStatus = window.getByLabel('Manual React edit status');
      await expect(layoutEditStatus).toHaveText('gap updated in the React artifact.');
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              const current = await window.selene.designer.snapshot();
              return current.source.revision.id;
            }),
          { timeout: previewPresentationTimeout }
        )
        .not.toBe(initialLayoutSourceRevision);
      const layoutEditStatusText = await layoutEditStatus.textContent();
      const appliedLayoutSourceRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      diagnostics.push(
        `manual layout status: ${layoutEditStatusText ?? '(missing)'}`,
        `manual layout source revision: ${initialLayoutSourceRevision} -> ${appliedLayoutSourceRevision}`
      );
      expect(layoutEditStatusText).toBe('gap updated in the React artifact.');
      expect(appliedLayoutSourceRevision).not.toBe(initialLayoutSourceRevision);
      await expect
        .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
        .not.toBe(initialLayoutRevision);
      await expectPrototypeHeading('Configured agent dashboard');
      directManipulationPerformance.layoutEditMs = Date.now() - layoutEditStartedAt;
      expect(directManipulationPerformance.layoutEditMs).toBeLessThanOrEqual(
        directEditRoundTripBudgetMs
      );
      const autoLayoutToolbar = window.getByRole('toolbar', {
        name: 'Selected container auto layout'
      });
      await expect(autoLayoutToolbar).toBeVisible();
      await expect(autoLayoutToolbar.getByLabel('Current container gap')).toHaveText('Gap 4px');
      const increaseGapButton = autoLayoutToolbar.getByRole('button', {
        name: 'Increase container gap'
      });
      const desktopViewport = window.viewportSize();
      if (!desktopViewport) throw new Error('The desktop viewport has no rendered geometry.');
      const readAutoLayoutGeometry = async () => {
        const [toolbar, control, canvas] = await Promise.all([
          autoLayoutToolbar.boundingBox(),
          increaseGapButton.boundingBox(),
          window.locator('.react-flow').first().boundingBox()
        ]);
        if (!toolbar || !control || !canvas) return undefined;
        return {
          canvas,
          control,
          toolbar,
          visibleLeft: Math.max(0, canvas.x) + 8,
          visibleRight: Math.min(desktopViewport.width, canvas.x + canvas.width) - 8
        };
      };
      let autoLayoutGeometrySignature = '';
      await expect
        .poll(
          async () => {
            const geometry = await readAutoLayoutGeometry();
            const signature = JSON.stringify(geometry);
            if (signature !== autoLayoutGeometrySignature) {
              autoLayoutGeometrySignature = signature;
              diagnostics.push(`artifact auto layout poll geometry: ${signature}`);
            }
            return (
              geometry !== undefined &&
              geometry.toolbar.x >= geometry.visibleLeft - 1 &&
              geometry.toolbar.x + geometry.toolbar.width <= geometry.visibleRight + 1 &&
              geometry.control.x >= geometry.visibleLeft - 1 &&
              geometry.control.x + geometry.control.width <= geometry.visibleRight + 1
            );
          },
          { timeout: previewPresentationTimeout }
        )
        .toBe(true);
      const autoLayoutGeometry = await readAutoLayoutGeometry();
      if (!autoLayoutGeometry)
        throw new Error('The artifact auto-layout surface has no rendered viewport geometry.');
      diagnostics.push(
        `artifact auto layout geometry: ${JSON.stringify({
          canvas: autoLayoutGeometry.canvas,
          control: autoLayoutGeometry.control,
          toolbar: autoLayoutGeometry.toolbar,
          viewport: desktopViewport
        })}`
      );
      const preAutoLayoutRevision = appliedLayoutSourceRevision;
      const preAutoLayoutFrame = await previewFrame.getAttribute('src');
      await increaseGapButton.click();
      await expect(layoutEditStatus).toContainText('Gap updated to 5px');
      const appliedAutoLayoutSourceRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      expect(appliedAutoLayoutSourceRevision).not.toBe(preAutoLayoutRevision);
      await expect
        .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
        .not.toBe(preAutoLayoutFrame);
      await expect(autoLayoutToolbar.getByLabel('Current container gap')).toHaveText('Gap 5px');
      diagnostics.push(
        `artifact auto layout source revision: ${preAutoLayoutRevision} -> ${appliedAutoLayoutSourceRevision}`
      );
      const resizeHandle = window.getByRole('button', {
        name: /Resize selected element width, currently \d+ pixels/
      });
      await expect(resizeHandle).toBeVisible();
      const resizeHandleBefore = await resizeHandle.getAttribute('aria-label');
      const preResizeRevision = appliedAutoLayoutSourceRevision;
      const preResizeFrame = await previewFrame.getAttribute('src');
      await resizeHandle.hover();
      const resizeBounds = await resizeHandle.boundingBox();
      if (!resizeBounds) throw new Error('Selected React width handle has no rendered bounds.');
      const resizeStart = {
        x: resizeBounds.x + resizeBounds.width / 2,
        y: resizeBounds.y + resizeBounds.height / 2
      };
      const resizeHit = await window.evaluate((point) => {
        const target = document.elementFromPoint(point.x, point.y);
        return {
          ariaLabel: target?.getAttribute('aria-label') ?? null,
          className: target?.getAttribute('class') ?? null,
          tagName: target?.tagName ?? null
        };
      }, resizeStart);
      diagnostics.push(`direct resize hit: ${JSON.stringify(resizeHit)}`);
      expect(resizeHit.ariaLabel).toMatch(/^Resize selected element width, currently \d+ pixels$/);
      const resizeEditStartedAt = Date.now();
      await window.mouse.down();
      await window.mouse.move(resizeStart.x + 48, resizeStart.y, { steps: 4 });
      await window.mouse.up();
      await expect(layoutEditStatus).toContainText('Width updated to');
      const appliedResizeSourceRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      expect(appliedResizeSourceRevision).not.toBe(preResizeRevision);
      await expect
        .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
        .not.toBe(preResizeFrame);
      await expect(resizeHandle).toBeVisible();
      await expect(resizeHandle).not.toHaveAttribute('aria-label', resizeHandleBefore ?? '');
      directManipulationPerformance.resizeEditMs = Date.now() - resizeEditStartedAt;
      expect(directManipulationPerformance.resizeEditMs).toBeLessThanOrEqual(
        directEditRoundTripBudgetMs
      );
      diagnostics.push(
        `direct resize source revision: ${preResizeRevision} -> ${appliedResizeSourceRevision}`
      );
      const moveHandle = window.getByRole('button', { name: 'Move selected element', exact: true });
      await expect(moveHandle).toBeVisible();
      const moveBounds = await moveHandle.boundingBox();
      if (!moveBounds) throw new Error('Selected React move surface has no rendered bounds.');
      expect(moveBounds.width).toBeLessThanOrEqual(36);
      expect(moveBounds.height).toBeLessThanOrEqual(36);
      const moveStart = {
        x: moveBounds.x + moveBounds.width / 2,
        y: moveBounds.y + moveBounds.height / 2
      };
      const moveHit = await window.evaluate((point) => {
        const target = document.elementFromPoint(point.x, point.y);
        return {
          ariaLabel: target?.getAttribute('aria-label') ?? null,
          className: target?.getAttribute('class') ?? null,
          tagName: target?.tagName ?? null
        };
      }, moveStart);
      diagnostics.push(`direct move hit: ${JSON.stringify(moveHit)}`);
      expect(moveHit).toMatchObject({
        ariaLabel: 'Move selected element',
        className: 'artifact-move-handle',
        tagName: 'BUTTON'
      });
      const viewportBeforeSelectionWheel = await readCanvasViewport();
      await window.mouse.move(moveStart.x, moveStart.y);
      await window.mouse.wheel(0, 24);
      await expect
        .poll(async () => (await readCanvasViewport()).y)
        .toBeLessThan(viewportBeforeSelectionWheel.y);
      const viewportAfterSelectionWheel = await readCanvasViewport();
      expect(viewportAfterSelectionWheel.zoom).toBeCloseTo(viewportBeforeSelectionWheel.zoom);
      diagnostics.push(
        `selection wheel viewport: ${JSON.stringify(viewportBeforeSelectionWheel)} -> ${JSON.stringify(viewportAfterSelectionWheel)}`
      );

      const preKeyboardMoveRevision = appliedResizeSourceRevision;
      const preKeyboardMoveFrame = await previewFrame.getAttribute('src');
      await expect(moveHandle).toBeEnabled();
      await moveHandle.focus();
      await expect(moveHandle).toBeFocused();
      await moveHandle.press('ArrowRight');
      await expect(layoutEditStatus).toContainText('Position updated by 1, 0px');
      const keyboardMoveSourceRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      expect(keyboardMoveSourceRevision).not.toBe(preKeyboardMoveRevision);
      await expect
        .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
        .not.toBe(preKeyboardMoveFrame);
      await expect(moveHandle).toBeVisible();

      const preCancelledMoveRevision = keyboardMoveSourceRevision;
      const cancelBounds = await moveHandle.boundingBox();
      if (!cancelBounds)
        throw new Error('Selected React move surface disappeared before cancellation.');
      const cancelStart = {
        x: cancelBounds.x + 8,
        y: cancelBounds.y + cancelBounds.height / 2
      };
      const artifactSurfaceBounds = await window.locator('.preview-artifact-content').boundingBox();
      if (!artifactSurfaceBounds)
        throw new Error('React artifact surface disappeared before alignment evidence.');
      const selectedElementBounds = await window
        .locator('.artifact-direct-selection')
        .boundingBox();
      if (!selectedElementBounds)
        throw new Error('Selected React element disappeared before alignment evidence.');
      const centerAlignmentDelta =
        artifactSurfaceBounds.x +
        artifactSurfaceBounds.width / 2 -
        (selectedElementBounds.x + selectedElementBounds.width / 2);
      await window.mouse.move(cancelStart.x, cancelStart.y);
      await window.mouse.down();
      await window.mouse.move(cancelStart.x + centerAlignmentDelta, cancelStart.y + 16, {
        steps: 3
      });
      const manipulationGuides = window.locator('.artifact-manipulation-guides');
      await expect(manipulationGuides).toBeVisible();
      await expect(manipulationGuides).toHaveAttribute('data-guide-mode', 'move');
      await expect(
        manipulationGuides.locator('.artifact-manipulation-guides__coordinate')
      ).toContainText(/X -?\d+ · Y -?\d+/);
      await expect(
        manipulationGuides.locator('.artifact-alignment-guide--vertical')
      ).toHaveAttribute('data-alignment', 'center');
      await window.keyboard.press('Escape');
      await window.mouse.up();
      await expect(manipulationGuides).toBeHidden();
      await expect(window.getByLabel('Direct manipulation status')).toContainText('Move cancelled');
      const cancelledMoveSourceRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      expect(cancelledMoveSourceRevision).toBe(preCancelledMoveRevision);

      const preMoveRevision = cancelledMoveSourceRevision;
      const preMoveFrame = await previewFrame.getAttribute('src');
      const nativeMoveBounds = await moveHandle.boundingBox();
      if (!nativeMoveBounds)
        throw new Error('Selected React move surface disappeared before drag.');
      const nativeMoveStart = {
        x: nativeMoveBounds.x + 8,
        y: nativeMoveBounds.y + nativeMoveBounds.height / 2
      };
      const nativeMoveDelta = { x: -31, y: 17 };
      await window.mouse.move(nativeMoveStart.x, nativeMoveStart.y);
      const moveEditStartedAt = Date.now();
      await window.mouse.down();
      // Continue outside the transparent selected-rect hit plane; this exercises the
      // native window mouse fallback used when Electron stops React pointer delivery.
      await window.mouse.move(
        nativeMoveStart.x + nativeMoveDelta.x,
        nativeMoveStart.y + nativeMoveDelta.y,
        { steps: 4 }
      );
      await expect(manipulationGuides).toHaveAttribute('data-guide-mode', 'move');
      const expectedNativeMove = await manipulationGuides.evaluate((guides) => {
        const x = Number(guides.dataset.moveX);
        const y = Number(guides.dataset.moveY);
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error('The active move guides did not expose finite snapped movement.');
        return { x, y };
      });
      await expect(
        manipulationGuides
          .locator('.artifact-alignment-guide[data-alignment-source="element"]')
          .first()
      ).toBeVisible();
      await window.mouse.up();
      await expect(layoutEditStatus).toContainText(
        `Position updated by ${expectedNativeMove.x}, ${expectedNativeMove.y}px`
      );
      const appliedMoveSourceRevision = await window.evaluate(async () => {
        const current = await window.selene.designer.snapshot();
        return current.source.revision.id;
      });
      expect(appliedMoveSourceRevision).not.toBe(preMoveRevision);
      await expect
        .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
        .not.toBe(preMoveFrame);
      await expect(moveHandle).toBeVisible();
      await expect(resizeHandle).toBeVisible();
      directManipulationPerformance.moveEditMs = Date.now() - moveEditStartedAt;
      expect(directManipulationPerformance.moveEditMs).toBeLessThanOrEqual(
        directEditRoundTripBudgetMs
      );
      await test.info().attach('direct-manipulation-performance.json', {
        body: JSON.stringify(directManipulationPerformance, null, 2),
        contentType: 'application/json'
      });
      const directManipulationResources = await window.evaluate(() => ({
        compiledFrames: document.querySelectorAll('iframe[title="Generated React preview frame"]')
          .length,
        moveHandles: document.querySelectorAll('.artifact-move-handle').length,
        resizeHandles: document.querySelectorAll('.artifact-resize-handle').length,
        resizeShields: document.querySelectorAll('.artifact-resize-shield').length,
        selectedElementToolbars: document.querySelectorAll(
          '[aria-label="Selected React element actions"]'
        ).length
      }));
      expect(directManipulationResources).toEqual({
        compiledFrames: 1,
        moveHandles: 1,
        resizeHandles: 2,
        resizeShields: 0,
        selectedElementToolbars: 1
      });
      await test.info().attach('direct-manipulation-resource-envelope.json', {
        body: JSON.stringify(directManipulationResources, null, 2),
        contentType: 'application/json'
      });
      diagnostics.push(
        `direct move source revision: ${preMoveRevision} -> ${appliedMoveSourceRevision}`
      );
      await unifiedCanvas
        .getByRole('toolbar', { name: 'Canvas tools' })
        .getByRole('button', { name: 'Present', exact: true })
        .click();
      const presentation = window.getByLabel('Prototype presentation', { exact: true });
      await expect(presentation).toBeVisible();
      await expect(presentation.getByRole('button', { name: /Exit/ })).toBeVisible();
      await expect(unifiedCanvas).toHaveCount(0);
      const presentedAction = await previewFrameAction({
        label: 'Review orders',
        nodeId: 'dashboard',
        portId: 'open-orders'
      });
      await window.mouse.click(
        presentedAction.geometry.action.center.x,
        presentedAction.geometry.action.center.y
      );
      await expectPrototypeHeading('Orders');
      const ordersNavigation = await previewNavigationEvidence();
      expect(ordersNavigation).toMatchObject({
        route: '/orders',
        historyState: { screen: 'orders' },
        heading: 'Orders'
      });
      const ordersFrameGeometry = (
        await previewFrameAction({
          label: 'Back to dashboard',
          nodeId: 'orders',
          portId: 'back'
        })
      ).geometry;
      await test.info().attach('target-ai-preview-navigation-after.json', {
        body: JSON.stringify(
          { preview: ordersNavigation, frame: ordersFrameGeometry, diagnostics },
          null,
          2
        ),
        contentType: 'application/json'
      });
      await test.info().attach('target-ai-preview-navigation-after.png', {
        body: await previewFrame.screenshot({
          animations: 'disabled',
          caret: 'hide',
          timeout: 5_000
        }),
        contentType: 'image/png'
      });
      await prototype.locator('main').evaluate(() => window.history.back());
      await expectPrototypeHeading('Configured agent dashboard');
      const browserBackNavigation = await previewNavigationEvidence();
      expect(browserBackNavigation).toMatchObject({
        route: '/',
        historyState: { screen: 'dashboard' },
        heading: 'Configured agent dashboard'
      });
      const browserBackFrameGeometry = (
        await previewFrameAction({
          label: 'Review orders',
          nodeId: 'dashboard',
          portId: 'open-orders'
        })
      ).geometry;
      await test.info().attach('target-ai-preview-navigation-browser-back.json', {
        body: JSON.stringify(
          { preview: browserBackNavigation, frame: browserBackFrameGeometry, diagnostics },
          null,
          2
        ),
        contentType: 'application/json'
      });
      await test.info().attach('target-ai-preview-navigation-browser-back.png', {
        body: await previewFrame.screenshot({
          animations: 'disabled',
          caret: 'hide',
          timeout: 5_000
        }),
        contentType: 'image/png'
      });
      const browserBackAction = await previewFrameAction({
        label: 'Review orders',
        nodeId: 'dashboard',
        portId: 'open-orders'
      });
      await window.mouse.click(
        browserBackAction.geometry.action.center.x,
        browserBackAction.geometry.action.center.y
      );
      await expectPrototypeHeading('Orders');
      const secondOrdersAction = await previewFrameAction({
        label: 'Back to dashboard',
        nodeId: 'orders',
        portId: 'back'
      });
      await window.mouse.click(
        secondOrdersAction.geometry.action.center.x,
        secondOrdersAction.geometry.action.center.y
      );
      await expectPrototypeHeading('Configured agent dashboard');
      const actionBackNavigation = await previewNavigationEvidence();
      expect(actionBackNavigation).toMatchObject({
        route: '/',
        historyState: { screen: 'dashboard' },
        heading: 'Configured agent dashboard'
      });
      const actionBackFrameGeometry = (
        await previewFrameAction({
          label: 'Review orders',
          nodeId: 'dashboard',
          portId: 'open-orders'
        })
      ).geometry;
      await test.info().attach('target-ai-preview-navigation-action-back.json', {
        body: JSON.stringify(
          { preview: actionBackNavigation, frame: actionBackFrameGeometry, diagnostics },
          null,
          2
        ),
        contentType: 'application/json'
      });
      await test.info().attach('target-ai-preview-navigation-action-back.png', {
        body: await previewFrame.screenshot({
          animations: 'disabled',
          caret: 'hide',
          timeout: 5_000
        }),
        contentType: 'image/png'
      });
      await presentation.getByRole('button', { name: /Exit/ }).click();
      await expect(presentation).toBeHidden();
      await expect(unifiedCanvas).toBeVisible();
      await expect(
        unifiedCanvas
          .getByRole('toolbar', { name: 'Canvas tools' })
          .getByRole('button', { name: 'Present', exact: true })
      ).toBeVisible();

      const reviewHandoffTrigger = window
        .locator('.workspace-toolbar > .sl-popover')
        .getByRole('button', { name: 'Review & handoff', exact: true });
      const reviewHandoffPopover = window.getByRole('dialog', {
        name: 'Review and developer handoff',
        exact: true
      });
      const openReviewHandoff = async (): Promise<Locator> => {
        if (await reviewHandoffPopover.isVisible()) {
          await reviewHandoffTrigger.click();
          await expect(reviewHandoffPopover).toBeHidden();
        }
        await reviewHandoffTrigger.click();
        await expect(reviewHandoffPopover).toBeVisible();
        return reviewHandoffPopover;
      };
      const handoffValue = (panel: Locator, label: string): Locator =>
        panel.getByText(label, { exact: true }).locator('..').locator('dd');

      const initialReviewHandoff = await openReviewHandoff();
      await expect(
        initialReviewHandoff.getByRole('heading', {
          name: 'Local project portfolio',
          exact: true
        })
      ).toBeVisible();
      await expect(
        initialReviewHandoff.getByText(
          'These workspaces are independent. No product shell currently claims their routes or source.',
          { exact: true }
        )
      ).toBeVisible();
      await initialReviewHandoff
        .getByRole('button', { name: 'Ready for review', exact: true })
        .click();
      const readyForReview = await openReviewHandoff();
      await expect(handoffValue(readyForReview, 'Readiness')).toHaveText('Ready for review');
      await expect(handoffValue(readyForReview, 'Baseline')).toHaveText('Review · Current');
      await expect(handoffValue(readyForReview, 'Changes')).toHaveText('0 since baseline');
      await (
        await openReviewHandoff()
      )
        .getByRole('button', { name: 'Ready for handoff', exact: true })
        .click();
      const readyForHandoff = await openReviewHandoff();
      await expect(handoffValue(readyForHandoff, 'Readiness')).toHaveText('Ready for handoff');
      await expect(handoffValue(readyForHandoff, 'Baseline')).toHaveText('Handoff · Current');
      await expect(handoffValue(readyForHandoff, 'Changes')).toHaveText('0 since baseline');
      await reviewHandoffTrigger.click();
      await expect(reviewHandoffPopover).toBeHidden();

      await window.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
      await window.getByLabel('AI change instruction').fill('Record the post-baseline update.');
      await expect(targetAiChange).toBeVisible();
      await expect(targetAiChange).toBeEnabled();
      await targetAiChange.click();
      await expect(spatialTarget).toBeVisible();
      await expect(spatialTarget).toBeEnabled();
      await expect(spatialTarget).toHaveAttribute('data-selection-plane-priority', 'true');
      await expect(selectedElementActions).toBeHidden();
      await clickSpatialTarget();
      await expect(
        window.getByRole('toolbar', { name: 'Selected artifact actions' })
      ).toBeVisible();
      await window
        .getByRole('toolbar', { name: 'Selected artifact actions' })
        .getByRole('button', { name: 'Ask AI', exact: true })
        .click();
      await expect(
        window.getByText('Selected artifact anchor is ready for the next AI edit request.', {
          exact: true
        })
      ).toBeVisible();
      await expect(
        window.getByText('AI target: Point near the top-left.', { exact: true })
      ).toBeVisible();
      const sendPostBaselineChange = window.getByRole('button', {
        name: 'Send targeted change',
        exact: true
      });
      await expect(sendPostBaselineChange).toBeEnabled();
      await sendPostBaselineChange.click();
      await expect
        .poll(
          async () => {
            const current = await window.evaluate(() => window.selene.designer.snapshot());
            return current.aiChangeRequests.at(-1)?.status;
          },
          { timeout: previewPresentationTimeout }
        )
        .toBe('reviewing');
      const postBaselineProposal = window
        .getByLabel('AI conversation history')
        .locator('[data-status="reviewing"]')
        .filter({ hasText: 'Record the post-baseline update.' });
      await postBaselineProposal
        .getByRole('button', {
          name: 'Reject and revise AI proposal: Record the post-baseline update.',
          exact: true
        })
        .click();
      await expect(window.getByLabel('AI change instruction')).toHaveValue(
        'Record the post-baseline update.'
      );
      const sendRevisedPostBaselineChange = window.getByRole('button', {
        name: 'Send targeted change',
        exact: true
      });
      await expect(sendRevisedPostBaselineChange).toBeEnabled();
      await sendRevisedPostBaselineChange.click();
      await expect
        .poll(
          async () => {
            const current = await window.evaluate(() => window.selene.designer.snapshot());
            return current.aiChangeRequests.at(-1)?.status;
          },
          { timeout: previewPresentationTimeout }
        )
        .toBe('reviewing');
      await window
        .getByLabel('AI conversation history')
        .locator('[data-status="reviewing"]')
        .filter({ hasText: 'Record the post-baseline update.' })
        .getByRole('button', {
          name: 'Accept AI proposal: Record the post-baseline update.',
          exact: true
        })
        .click();
      await expect
        .poll(
          async () => {
            const current = await window.evaluate(() => window.selene.designer.snapshot());
            return current.aiChangeRequests.at(-1)?.status;
          },
          { timeout: previewPresentationTimeout }
        )
        .toBe('applied');
      const staleHandoff = await openReviewHandoff();
      await expect(handoffValue(staleHandoff, 'Readiness')).toHaveText('Ready for handoff');
      await expect(handoffValue(staleHandoff, 'Baseline')).toHaveText('Handoff · Changed');
      await expect(handoffValue(staleHandoff, 'Changes')).toHaveText('1 since baseline');
      await expect(
        staleHandoff.getByText(
          'Prior approvals are stale; the host will evaluate readiness for the next step.',
          { exact: true }
        )
      ).toBeVisible();

      const exportHandoffPanel = await openReviewHandoff();
      await exportHandoffPanel.getByRole('button', { name: 'Export handoff', exact: true }).click();
      await expect(reviewHandoffPopover).toBeHidden();
      const handoff = JSON.parse(
        await window.evaluate(() => window.selene.designer.exportHandoff())
      ) as {
        readonly baseline: {
          readonly currency: string;
          readonly exactChangesToRecheck: readonly unknown[];
        };
      };
      expect(handoff.baseline.currency).toBe('stale');
      expect(handoff.baseline.exactChangesToRecheck).toHaveLength(1);

      const designMode = window.getByRole('button', { name: 'Design', exact: true });
      await expect(designMode).toHaveAttribute('aria-pressed', 'true');
      await window.setViewportSize({ width: 620, height: 760 });
      await expect(window.locator('.workspace-layout')).toHaveAttribute(
        'data-layout-mode',
        'inspector-drawer'
      );
      await expect
        .poll(async () => (await window.getByLabel('Design canvas').boundingBox())?.width ?? 0, {
          message: 'Compact layout should settle with a usable canvas before artifact interaction.'
        })
        .toBeGreaterThanOrEqual(300);
      await savedPin.scrollIntoViewIfNeeded();
      await savedPin.click();
      await expect(selectedThreadCard).toBeVisible();
      const compactThreadEvidence = await selectedThreadCard.evaluate((card) => {
        const canvas = card.closest<HTMLElement>('.canvas-workspace');
        if (!canvas) throw new Error('Compact review thread must remain inside the design canvas.');
        const bounds = card.getBoundingClientRect();
        const canvasBounds = canvas.getBoundingClientRect();
        return {
          canvas: canvasBounds.toJSON(),
          card: bounds.toJSON(),
          withinCanvas:
            bounds.left >= canvasBounds.left &&
            bounds.right <= canvasBounds.right &&
            bounds.top >= canvasBounds.top &&
            bounds.bottom <= canvasBounds.bottom
        };
      });
      await test.info().attach('compact-screen-space-review-thread.json', {
        body: JSON.stringify(compactThreadEvidence, null, 2),
        contentType: 'application/json'
      });
      expect(compactThreadEvidence.card.width).toBeLessThanOrEqual(340);
      expect(compactThreadEvidence.withinCanvas).toBe(true);
      await test.info().attach('compact-screen-space-review-thread.png', {
        body: await window.screenshot(),
        contentType: 'image/png'
      });
      const compactThreadReply = selectedThreadCard.getByRole('textbox', {
        name: 'Reply to stakeholder thread',
        exact: true
      });
      await compactThreadReply.focus();
      await window.keyboard.press('Escape');
      await expect(selectedThreadCard).toBeHidden();
      const openCompactAi = window.getByRole('button', {
        name: 'Open AI conversation',
        exact: true
      });
      await expect(openCompactAi).toBeVisible();
      await openCompactAi.click();
      const compactAiTarget = window.getByLabel('Targeted change actions').getByRole('button', {
        name: 'Select on canvas',
        exact: true
      });
      await expect(compactAiTarget).toBeVisible();
      await expect(compactAiTarget).toBeEnabled();
      await compactAiTarget.click();
      await expect(openCompactAi).toBeVisible();
      const compactTargetLayer = window.getByRole('button', {
        name: 'Select a point or region on the artifact',
        exact: true
      });
      await expect(compactTargetLayer).toBeVisible();
      await test.step('checkpoint: compact preview retains one physical artifact plane', async () => {
        const compactPreviewGeometry = await compactTargetLayer.evaluate((layer) => {
          const content = layer.closest<HTMLElement>('.preview-artifact-content');
          const stage = content;
          const canvas = layer.closest<HTMLElement>('.canvas-workspace');
          const viewport = canvas;
          const layout = canvas?.closest<HTMLElement>('.workspace-layout');
          const frame = content?.querySelector<HTMLIFrameElement>(
            'iframe[title="Generated React preview frame"]'
          );
          const pin = content?.querySelector<HTMLElement>('.preview-pin');
          const thread = content?.querySelector<HTMLElement>('.spatial-thread-card');
          if (
            !(content instanceof HTMLElement) ||
            !(stage instanceof HTMLElement) ||
            !(canvas instanceof HTMLElement) ||
            !(viewport instanceof HTMLElement) ||
            !(layout instanceof HTMLElement) ||
            !(frame instanceof HTMLIFrameElement) ||
            !(pin instanceof HTMLElement)
          )
            throw new Error(
              'Compact preview must retain its artifact, target, and persisted pin plane.'
            );
          const stageStyle = getComputedStyle(stage);
          const stageBounds = stage.getBoundingClientRect();
          const contentBounds = content.getBoundingClientRect();
          const frameBounds = frame.getBoundingClientRect();
          const targetBounds = layer.getBoundingClientRect();
          return {
            layoutMode: layout.dataset.layoutMode,
            artifact: {
              width: contentBounds.width,
              height: contentBounds.height
            },
            rendered: {
              width: stageBounds.width,
              height: stageBounds.height
            },
            stage: {
              bounds: stageBounds.toJSON(),
              cssWidth: stageBounds.width,
              cssHeight: stageBounds.height,
              minHeight: stageStyle.minHeight,
              transform: stageStyle.transform,
              transformScaleX: 1,
              transformScaleY: 1
            },
            content: {
              bounds: contentBounds.toJSON(),
              cssWidth: contentBounds.width,
              cssHeight: contentBounds.height,
              zoom: 1
            },
            frame: frameBounds.toJSON(),
            target: targetBounds.toJSON(),
            canvas: canvas.getBoundingClientRect().toJSON(),
            viewport: { scrollbarGutter: getComputedStyle(viewport).scrollbarGutter },
            pinSharesContent: pin.parentElement === content,
            threadDismissed: thread === null,
            targetSharesContent: layer.parentElement === content,
            targetHitStack: document
              .elementsFromPoint(
                targetBounds.left + targetBounds.width / 2,
                targetBounds.top + targetBounds.height / 2
              )
              .map((element) => ({
                ariaLabel: element.getAttribute('aria-label'),
                className: element.getAttribute('class'),
                tagName: element.tagName,
                text: element.textContent?.trim().slice(0, 80)
              })),
            targetIsTopmost:
              document.elementsFromPoint(
                targetBounds.left + targetBounds.width / 2,
                targetBounds.top + targetBounds.height / 2
              )[0] === layer
          };
        });
        await test.info().attach('compact-preview-physical-stage-geometry.json', {
          body: JSON.stringify(compactPreviewGeometry, null, 2),
          contentType: 'application/json'
        });
        expect(compactPreviewGeometry.layoutMode).toBe('inspector-drawer');
        expect(compactPreviewGeometry.viewport.scrollbarGutter).toBe('auto');
        expect(compactPreviewGeometry.stage.cssWidth).toBeCloseTo(
          compactPreviewGeometry.rendered.width,
          1
        );
        expect(compactPreviewGeometry.stage.cssHeight).toBeCloseTo(
          compactPreviewGeometry.rendered.height,
          1
        );
        expect(compactPreviewGeometry.stage.minHeight).toBe('0px');
        expect(compactPreviewGeometry.stage.transformScaleX).toBe(1);
        expect(compactPreviewGeometry.stage.transformScaleY).toBe(1);
        expect(compactPreviewGeometry.content.cssWidth).toBeCloseTo(
          compactPreviewGeometry.artifact.width,
          1
        );
        // Chromium quantizes the zoomed box to a 1/64 CSS-pixel layout unit.
        // Compare the physical error instead of amplifying it back into artifact coordinates.
        expect(
          Math.abs(
            compactPreviewGeometry.content.cssHeight - compactPreviewGeometry.artifact.height
          ) * compactPreviewGeometry.content.zoom
        ).toBeLessThanOrEqual(1 / 64);
        expect(compactPreviewGeometry.content.zoom).toBeGreaterThan(0);
        expect(compactPreviewGeometry.stage.bounds.width).toBeCloseTo(
          compactPreviewGeometry.rendered.width,
          1
        );
        expect(compactPreviewGeometry.stage.bounds.height).toBeCloseTo(
          compactPreviewGeometry.rendered.height,
          1
        );
        expect(compactPreviewGeometry.frame.width).toBeCloseTo(
          compactPreviewGeometry.stage.bounds.width,
          1
        );
        expect(compactPreviewGeometry.frame.height).toBeCloseTo(
          compactPreviewGeometry.stage.bounds.height,
          1
        );
        expect(compactPreviewGeometry.target.width).toBeCloseTo(
          compactPreviewGeometry.stage.bounds.width,
          1
        );
        expect(compactPreviewGeometry.target.height).toBeCloseTo(
          compactPreviewGeometry.stage.bounds.height,
          1
        );
        expect(compactPreviewGeometry.targetSharesContent).toBe(true);
        expect(compactPreviewGeometry.pinSharesContent).toBe(true);
        expect(compactPreviewGeometry.threadDismissed).toBe(true);
        expect(
          compactPreviewGeometry.targetIsTopmost,
          JSON.stringify(compactPreviewGeometry.targetHitStack, null, 2)
        ).toBe(true);
      });
      await expect(selectedPin).not.toHaveAttribute('inert', '');
      await compactTargetLayer.hover();
      const compactPointGesture = await compactTargetLayer.evaluate((layer) => {
        const bounds = layer.getBoundingClientRect();
        const position = {
          x: Math.round(bounds.width * 0.36),
          y: Math.round(bounds.height * 0.42)
        };
        return {
          position,
          normalized: { x: position.x / bounds.width, y: position.y / bounds.height },
          physical: { x: bounds.left + position.x, y: bounds.top + position.y }
        };
      });
      await window.mouse.click(compactPointGesture.physical.x, compactPointGesture.physical.y);
      await expect(compactTargetLayer).toBeHidden();
      await window.getByRole('button', { name: 'Ask AI', exact: true }).click();
      const savedAiTarget = window.getByLabel('Saved AI target');
      await expect(savedAiTarget).toBeVisible();
      const compactPointRoundTrip = await savedAiTarget.evaluate((overlay, expected) => {
        const bounds = overlay.getBoundingClientRect();
        return {
          persisted: {
            x: Number.parseFloat(overlay.style.left) / 100,
            y: Number.parseFloat(overlay.style.top) / 100
          },
          physical: { x: bounds.left, y: bounds.top },
          expected
        };
      }, compactPointGesture);
      expect(compactPointRoundTrip.persisted.x).toBeCloseTo(
        compactPointRoundTrip.expected.normalized.x,
        3
      );
      expect(compactPointRoundTrip.persisted.y).toBeCloseTo(
        compactPointRoundTrip.expected.normalized.y,
        3
      );
      expect(
        Math.abs(compactPointRoundTrip.physical.x - compactPointRoundTrip.expected.physical.x)
      ).toBeLessThanOrEqual(3);
      expect(
        Math.abs(compactPointRoundTrip.physical.y - compactPointRoundTrip.expected.physical.y)
      ).toBeLessThanOrEqual(3);
      await window
        .getByLabel('Targeted change actions')
        .getByRole('button', { name: 'Clear target', exact: true })
        .click();
      await expect(savedAiTarget).toBeHidden();

      await window.setViewportSize({ width: 1280, height: 900 });
      await expect(window.locator('.workspace-layout')).toHaveAttribute(
        'data-layout-mode',
        'split-pane'
      );
      await window.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
      await window.getByRole('tab', { name: 'Inspect', exact: true }).click();
      const useInReview = window.getByRole('button', {
        name: 'Use in review comment',
        exact: true
      });
      await expect(useInReview).toBeDisabled();
      await window.getByRole('tab', { name: 'Reviews', exact: true }).click();
      await window
        .getByLabel('Review actions')
        .getByRole('button', { name: 'Select on canvas', exact: true })
        .click();
      const compactReviewLayer = window.getByRole('button', {
        name: 'Select a point or region on the artifact',
        exact: true
      });
      await expect(compactReviewLayer).toBeVisible();
      await expect(compactReviewLayer).toHaveAttribute('data-selection-plane-priority', 'true');
      expect(
        await compactReviewLayer.evaluate((layer) => {
          const viewport = layer.closest<HTMLElement>('.canvas-workspace');
          if (!viewport) throw new Error('Compact review selection requires its preview viewport.');
          return getComputedStyle(viewport).scrollbarGutter;
        })
      ).toBe('auto');
      await compactReviewLayer.hover();
      const compactRegionGesture = await compactReviewLayer.evaluate((layer) => {
        const bounds = layer.getBoundingClientRect();
        const start = {
          x: bounds.left + bounds.width * 0.22,
          y: bounds.top + bounds.height * 0.28
        };
        const end = {
          x: bounds.left + bounds.width * 0.62,
          y: bounds.top + bounds.height * 0.57
        };
        return {
          start,
          end,
          normalized: {
            x: (start.x - bounds.left) / bounds.width,
            y: (start.y - bounds.top) / bounds.height,
            width: (end.x - start.x) / bounds.width,
            height: (end.y - start.y) / bounds.height
          },
          physical: {
            left: start.x,
            top: start.y,
            width: end.x - start.x,
            height: end.y - start.y
          }
        };
      });
      await window.mouse.move(compactRegionGesture.start.x, compactRegionGesture.start.y);
      await window.mouse.down();
      await window.mouse.move(compactRegionGesture.end.x, compactRegionGesture.end.y, {
        steps: 4
      });
      await window.mouse.up();
      await expect(compactReviewLayer).toBeHidden();
      await window.getByRole('button', { name: 'Comment', exact: true }).click();
      await expect(window.getByLabel('Stakeholder review thread body')).toBeFocused();
      const savedReviewTarget = window.getByLabel('Saved stakeholder review target');
      await expect(savedReviewTarget).toBeVisible();
      const compactRegionRoundTrip = await savedReviewTarget.evaluate((overlay, expected) => {
        const bounds = overlay.getBoundingClientRect();
        return {
          persisted: {
            x: Number.parseFloat(overlay.style.left) / 100,
            y: Number.parseFloat(overlay.style.top) / 100,
            width: Number.parseFloat(overlay.style.width) / 100,
            height: Number.parseFloat(overlay.style.height) / 100
          },
          physical: {
            left: bounds.left,
            top: bounds.top,
            width: bounds.width,
            height: bounds.height
          },
          expected
        };
      }, compactRegionGesture);
      await test.info().attach('compact-preview-target-round-trip.json', {
        body: JSON.stringify(
          { point: compactPointRoundTrip, region: compactRegionRoundTrip },
          null,
          2
        ),
        contentType: 'application/json'
      });
      expect(compactRegionRoundTrip.persisted.x).toBeCloseTo(
        compactRegionRoundTrip.expected.normalized.x,
        3
      );
      expect(compactRegionRoundTrip.persisted.y).toBeCloseTo(
        compactRegionRoundTrip.expected.normalized.y,
        3
      );
      expect(compactRegionRoundTrip.persisted.width).toBeCloseTo(
        compactRegionRoundTrip.expected.normalized.width,
        3
      );
      expect(compactRegionRoundTrip.persisted.height).toBeCloseTo(
        compactRegionRoundTrip.expected.normalized.height,
        3
      );
      expect(
        Math.abs(
          compactRegionRoundTrip.physical.left - compactRegionRoundTrip.expected.physical.left
        )
      ).toBeLessThanOrEqual(4);
      expect(
        Math.abs(compactRegionRoundTrip.physical.top - compactRegionRoundTrip.expected.physical.top)
      ).toBeLessThanOrEqual(4);
      expect(
        Math.abs(
          compactRegionRoundTrip.physical.width - compactRegionRoundTrip.expected.physical.width
        )
      ).toBeLessThanOrEqual(4);
      expect(
        Math.abs(
          compactRegionRoundTrip.physical.height - compactRegionRoundTrip.expected.physical.height
        )
      ).toBeLessThanOrEqual(4);
    } catch (error) {
      throw failure(error);
    }
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('stages the governed catalog and applies source-backed manual editor operations', async () => {
  test.setTimeout(90_000);
  const userData = await mkdtemp(join(tmpdir(), `selene-${harnessIdentity()}-catalog-editor-`));
  await writeFile(
    join(userData, 'designer-agents.json'),
    JSON.stringify({
      version: 'selene-desktop-agents/v1',
      agents: [
        {
          id: 'catalog-jsonl-agent',
          label: 'Catalog JSONL agent',
          command: process.execPath,
          args: [agentFixture, 'catalog'],
          workspaceRoot: process.cwd(),
          readOnly: true,
          capabilityGrants: ['react.revise'],
          designOperation: 'react.revise',
          requestTimeoutMs: 10_000
        }
      ]
    })
  );
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    await window.setViewportSize({ width: 1280, height: 900 });
    await openProjectFromLaunchpad(window, 'Governed catalog editor test');

    await window.getByRole('button', { name: 'Open Dev Inspect', exact: true }).click();
    await window.getByRole('tab', { name: 'Setup', exact: true }).click();
    const setup = window.getByLabel('Guided local setup');
    await setup.getByLabel('Package name').fill('@selene/design-tokens');
    await setup.getByLabel('Exact version').fill('1.0.0');
    await setup.getByRole('button', { name: 'Inspect & stage package', exact: true }).click();
    await expect(setup).toContainText('desktop-local-catalog-fixture');
    await expect(setup.getByLabel('Component catalog')).toContainText('host-supplied entries');

    await window.getByRole('button', { name: 'Open AI conversation', exact: true }).click();
    await window.getByLabel('Configured agent').selectOption('catalog-jsonl-agent');
    await window
      .getByLabel('AI change instruction')
      .fill('Create a mapped flex layout for governed component insertion.');
    await window
      .getByLabel('Targeted change actions')
      .getByRole('button', { name: 'Select on canvas', exact: true })
      .click();
    const target = window.getByRole('button', {
      name: 'Select a point or region on the artifact',
      exact: true
    });
    await expect(target).toBeVisible();
    const targetBounds = await target.boundingBox();
    if (!targetBounds) throw new Error('AI target layer has no physical bounds.');
    await window.mouse.click(targetBounds.x + targetBounds.width * 0.3, targetBounds.y + 80);
    await window
      .getByRole('toolbar', { name: 'Selected artifact actions' })
      .getByRole('button', { name: 'Ask AI', exact: true })
      .click();
    await window.getByRole('button', { name: 'Send targeted change', exact: true }).click();
    const reviewingRequest = window
      .getByLabel('AI conversation history')
      .locator('[data-status="reviewing"]')
      .filter({ hasText: 'Create a mapped flex layout for governed component insertion.' });
    await expect(reviewingRequest).toBeVisible({ timeout: previewPresentationTimeout });
    await reviewingRequest
      .getByRole('button', {
        name: 'Accept AI proposal: Create a mapped flex layout for governed component insertion.',
        exact: true
      })
      .click();
    await expect(
      window
        .getByLabel('AI conversation history')
        .locator('[data-status="applied"]')
        .filter({ hasText: 'Create a mapped flex layout for governed component insertion.' })
    ).toBeVisible({ timeout: previewPresentationTimeout });
    await expect(
      window.getByText(/Accepted .+ and refreshed the canonical preview\./, { exact: false })
    ).toBeVisible({ timeout: previewPresentationTimeout });
    await window.getByRole('button', { name: 'Hide AI rail', exact: true }).click();

    const previewFrame = window.locator('iframe[title="Generated React preview frame"]');
    const prototype = window.frameLocator('iframe[title="Generated React preview frame"]');
    const root = prototype.locator('[data-selene-node-id="designer.root"]');
    await expect(root).toBeVisible({ timeout: previewPresentationTimeout });
    await expect(prototype.getByRole('heading', { name: 'Catalog-ready dashboard' })).toBeVisible();

    const selectRoot = async () => {
      // An accepted AI proposal may leave its transient targeting plane mounted until
      // the designer returns to an explicit canvas action. Do that before deriving
      // physical iframe geometry: otherwise the blank-root click exercises the
      // overlay, not the mapped React element beneath it.
      await window
        .getByRole('toolbar', { name: 'Canvas tools' })
        .getByRole('button', { name: 'Selection', exact: true })
        .click();
      await expect(
        window.getByRole('button', {
          name: 'Select a point or region on the artifact',
          exact: true
        })
      ).toHaveCount(0);
      await expect(
        window.getByRole('button', { name: 'Move selected element', exact: true })
      ).toHaveCount(0);
      const expectedFrameIdentity = await previewFrame.getAttribute('src');
      const expectedRevisionId = await window.evaluate(async () => {
        return (await window.selene.designer.snapshot()).source.revision.id;
      });
      let frameBounds: Awaited<ReturnType<typeof previewFrame.boundingBox>>;
      let frameMetrics: {
        readonly clientHeight: number;
        readonly clientLeft: number;
        readonly clientTop: number;
        readonly clientWidth: number;
        readonly offsetHeight: number;
        readonly offsetWidth: number;
      };
      let rootTarget: {
        readonly candidates: readonly {
          readonly candidate: Readonly<{ x: number; y: number }>;
          readonly hitNodeId: string;
        }[];
        readonly rootBounds: Readonly<{ height: number; left: number; top: number; width: number }>;
        readonly viewport: Readonly<{ height: number; width: number }>;
      };
      try {
        [frameBounds, frameMetrics, rootTarget] = await Promise.all([
          previewFrame.boundingBox(),
          previewFrame.evaluate((frame) => ({
            clientHeight: frame.clientHeight,
            clientLeft: frame.clientLeft,
            clientTop: frame.clientTop,
            clientWidth: frame.clientWidth,
            offsetHeight: frame.offsetHeight,
            offsetWidth: frame.offsetWidth
          })),
          root.evaluate((node) => {
            const rootBounds = node.getBoundingClientRect();
            const viewport = { width: window.innerWidth, height: window.innerHeight };
            if (viewport.width <= 0 || viewport.height <= 0)
              throw new Error('Preview frame has no usable viewport.');
            const insetX = Math.min(24, rootBounds.width / 4);
            const insetY = Math.min(24, rootBounds.height / 4);
            const candidates = [
              { x: rootBounds.left + insetX, y: rootBounds.top + insetY },
              { x: rootBounds.right - insetX, y: rootBounds.bottom - insetY },
              { x: rootBounds.left + insetX, y: rootBounds.bottom - insetY },
              { x: rootBounds.right - insetX, y: rootBounds.top + insetY }
            ];
            const sourceBoundCandidates = candidates.flatMap((candidate) => {
              const hit = document.elementFromPoint(candidate.x, candidate.y);
              const hitNodeId =
                hit?.closest('[data-selene-node-id]')?.getAttribute('data-selene-node-id') ?? null;
              return hitNodeId === 'designer.root' ? [{ candidate, hitNodeId }] : [];
            });
            if (!sourceBoundCandidates.length)
              throw new Error(
                'Mapped flex root has no source-bound in-frame blank selection point.'
              );
            return {
              candidates: sourceBoundCandidates,
              rootBounds: {
                height: rootBounds.height,
                left: rootBounds.left,
                top: rootBounds.top,
                width: rootBounds.width
              },
              viewport
            };
          })
        ]);
      } catch (error) {
        const observedFrameIdentity = await previewFrame.getAttribute('src').catch(() => null);
        await test.info().attach('manual-root-selection-stale-preview.json', {
          body: JSON.stringify(
            {
              error: error instanceof Error ? error.message : String(error),
              expectedFrameIdentity,
              expectedRevisionId,
              observedFrameIdentity
            },
            null,
            2
          ),
          contentType: 'application/json'
        });
        throw new Error('Canonical preview frame changed before physical root selection.', {
          cause: error
        });
      }
      if (!frameBounds) throw new Error('Mapped flex root preview frame is not measurable.');
      if (frameMetrics.offsetWidth <= 0 || frameMetrics.offsetHeight <= 0)
        throw new Error('Mapped flex root preview frame has no usable border box.');
      expect(rootTarget.viewport).toEqual({
        height: frameMetrics.clientHeight,
        width: frameMetrics.clientWidth
      });
      const frameScale = {
        x: frameBounds.width / frameMetrics.offsetWidth,
        y: frameBounds.height / frameMetrics.offsetHeight
      };
      const frameContentBounds = {
        height: frameMetrics.clientHeight * frameScale.y,
        left: frameBounds.x + frameMetrics.clientLeft * frameScale.x,
        top: frameBounds.y + frameMetrics.clientTop * frameScale.y,
        width: frameMetrics.clientWidth * frameScale.x
      };
      const mappedRootCandidates = await Promise.all(
        rootTarget.candidates.map(async ({ candidate, hitNodeId }) => {
          const point = {
            x:
              frameContentBounds.left +
              (candidate.x / rootTarget.viewport.width) * frameContentBounds.width,
            y:
              frameContentBounds.top +
              (candidate.y / rootTarget.viewport.height) * frameContentBounds.height
          };
          const iframeHit = await previewFrame.evaluate((frame, outerPoint) => {
            const hit = document.elementFromPoint(outerPoint.x, outerPoint.y);
            return { isExactPreviewFrame: hit === frame, tagName: hit?.tagName ?? null };
          }, point);
          return { candidate, hitNodeId, iframeHit, point };
        })
      );
      const selectedRootCandidate = mappedRootCandidates.find(
        (candidate) => candidate.iframeHit.isExactPreviewFrame
      );
      if (!selectedRootCandidate)
        throw new Error(
          'Mapped flex root has no source-bound candidate visible through the preview frame.'
        );
      const rootClickPoint = selectedRootCandidate.point;
      const rootClickIframeHit = selectedRootCandidate.iframeHit;
      const rootClickHitStack = await window.evaluate((point) => {
        return document
          .elementsFromPoint(point.x, point.y)
          .slice(0, 6)
          .map((element) => ({
            ariaLabel: element.getAttribute('aria-label'),
            className: element instanceof HTMLElement ? element.className : '',
            tagName: element.tagName
          }));
      }, rootClickPoint);
      await test.info().attach('manual-root-selection-hit-stack.json', {
        body: JSON.stringify(
          {
            frameBounds,
            frameContentBounds,
            frameMetrics,
            frameLocalTarget: rootTarget,
            frameScale,
            iframeHit: rootClickIframeHit,
            mappedCandidates: mappedRootCandidates,
            point: rootClickPoint,
            selectedCandidate: selectedRootCandidate,
            stack: rootClickHitStack
          },
          null,
          2
        ),
        contentType: 'application/json'
      });
      expect(rootClickIframeHit).toEqual({ isExactPreviewFrame: true, tagName: 'IFRAME' });
      expect(rootClickHitStack[0]?.tagName).toBe('IFRAME');
      expect(selectedRootCandidate.hitNodeId).toBe('designer.root');
      const captureKey = '__seleneManualRootPointerEvidence';
      await root.evaluate((_, key) => {
        const captured: {
          readonly button: number;
          readonly isPrimary: boolean;
          readonly isTrusted: boolean;
          readonly nodeId: string | null;
          readonly type: string;
        }[] = [];
        const capture = (event: PointerEvent | MouseEvent) => {
          if (captured.length >= 8) return;
          const eventTarget = event.target instanceof Element ? event.target : null;
          captured.push({
            button: event.button,
            isPrimary: event instanceof PointerEvent ? event.isPrimary : true,
            isTrusted: event.isTrusted,
            nodeId:
              eventTarget?.closest('[data-selene-node-id]')?.getAttribute('data-selene-node-id') ??
              null,
            type: event.type
          });
        };
        window.addEventListener('pointerdown', capture, true);
        window.addEventListener('pointerup', capture, true);
        window.addEventListener('click', capture, true);
        (window as typeof window & Record<string, unknown>)[key] = {
          captured,
          dispose: () => {
            window.removeEventListener('pointerdown', capture, true);
            window.removeEventListener('pointerup', capture, true);
            window.removeEventListener('click', capture, true);
          }
        };
      }, captureKey);
      const frameGeometryAt = async () =>
        previewFrame.evaluate((frame, point) => {
          const rect = frame.getBoundingClientRect();
          const hit = document.elementFromPoint(point.x, point.y);
          const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
          const activeNode = document.querySelector<HTMLElement>('.react-flow__node.selected');
          return {
            activeNodeClassName: activeNode?.className ?? null,
            height: rect.height,
            hitIsExactPreviewFrame: hit === frame,
            hitTagName: hit?.tagName ?? null,
            left: rect.left,
            stack: document
              .elementsFromPoint(point.x, point.y)
              .slice(0, 6)
              .map((element) => ({
                className: element instanceof HTMLElement ? element.className : '',
                tagName: element.tagName
              })),
            top: rect.top,
            viewportTransform: viewport?.style.transform ?? null,
            width: rect.width
          };
        }, rootClickPoint);
      const assertStableFrameGeometry = (
        armed: Awaited<ReturnType<typeof frameGeometryAt>>,
        current: Awaited<ReturnType<typeof frameGeometryAt>>
      ) => {
        const evidence = JSON.stringify({ armed, current });
        expect(current.hitIsExactPreviewFrame, evidence).toBe(true);
        expect(current.hitTagName, evidence).toBe('IFRAME');
        expect(Math.abs(current.left - armed.left), evidence).toBeLessThanOrEqual(1);
        expect(Math.abs(current.top - armed.top), evidence).toBeLessThanOrEqual(1);
        expect(Math.abs(current.width - armed.width), evidence).toBeLessThanOrEqual(1);
        expect(Math.abs(current.height - armed.height), evidence).toBeLessThanOrEqual(1);
      };
      const attachGeometryEvidence = async (
        armedFrameGeometry: Awaited<ReturnType<typeof frameGeometryAt>>,
        currentFrameGeometry: Awaited<ReturnType<typeof frameGeometryAt>>,
        stage: string
      ) => {
        await test.info().attach('manual-root-selection-geometry-failure.json', {
          body: JSON.stringify({ armedFrameGeometry, currentFrameGeometry, stage }, null, 2),
          contentType: 'application/json'
        });
      };
      const releaseFramePointerEvidence = () =>
        root.evaluate((_, key) => {
          const state = (window as typeof window & Record<string, unknown>)[key] as
            { readonly captured: unknown; readonly dispose: () => void } | undefined;
          state?.dispose();
          delete (window as typeof window & Record<string, unknown>)[key];
          return state?.captured ?? [];
        }, captureKey);
      let framePointerEvidence: unknown;
      try {
        const armedFrameGeometry = await frameGeometryAt();
        await window.mouse.move(rootClickPoint.x, rootClickPoint.y);
        const beforePointerDownFrameGeometry = await frameGeometryAt();
        try {
          assertStableFrameGeometry(armedFrameGeometry, beforePointerDownFrameGeometry);
        } catch (error) {
          await attachGeometryEvidence(
            armedFrameGeometry,
            beforePointerDownFrameGeometry,
            'before-pointerdown'
          );
          throw error;
        }
        await window.mouse.down();
        const beforePointerUpFrameGeometry = await frameGeometryAt();
        try {
          assertStableFrameGeometry(armedFrameGeometry, beforePointerUpFrameGeometry);
        } catch (error) {
          await attachGeometryEvidence(
            armedFrameGeometry,
            beforePointerUpFrameGeometry,
            'before-pointerup'
          );
          throw error;
        }
        await window.mouse.up();
        framePointerEvidence = await releaseFramePointerEvidence();
        expect(framePointerEvidence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              button: 0,
              isPrimary: true,
              isTrusted: true,
              nodeId: 'designer.root',
              type: 'pointerdown'
            }),
            expect.objectContaining({
              button: 0,
              isPrimary: true,
              isTrusted: true,
              nodeId: 'designer.root',
              type: 'pointerup'
            })
          ])
        );
        await test.info().attach('manual-root-selection-physical-input.json', {
          body: JSON.stringify(
            {
              armedFrameGeometry,
              beforePointerDownFrameGeometry,
              beforePointerUpFrameGeometry,
              framePointerEvidence
            },
            null,
            2
          ),
          contentType: 'application/json'
        });
      } finally {
        if (framePointerEvidence === undefined) await releaseFramePointerEvidence();
      }
      const rootSelectionDiagnostic = await window.evaluate(
        async ({ frameIdentity, revisionId }) => {
          const snapshot = await window.selene.designer.snapshot();
          const frame = document.querySelector<HTMLIFrameElement>(
            'iframe[title="Generated React preview frame"]'
          );
          return {
            frame: frame
              ? {
                  src: frame.getAttribute('src'),
                  title: frame.getAttribute('title')
                }
              : null,
            bindingNodeIds: snapshot.nodes.map((node) => node.nodeId),
            expectedFrameIdentity: frameIdentity,
            expectedRevisionId: revisionId,
            sourceRevisionId: snapshot.source.revision.id,
            selectedNodeId: snapshot.selectedNodeId ?? null,
            status: [...document.querySelectorAll<HTMLElement>('[role="status"], [aria-live]')]
              .map((element) => element.textContent?.trim())
              .filter((value): value is string => Boolean(value))
          };
        },
        { frameIdentity: expectedFrameIdentity, revisionId: expectedRevisionId }
      );
      await test.info().attach('manual-root-selection-reconciliation.json', {
        body: JSON.stringify(rootSelectionDiagnostic, null, 2),
        contentType: 'application/json'
      });
      expect(rootSelectionDiagnostic.selectedNodeId).toBe('designer.root');
      expect(rootSelectionDiagnostic.sourceRevisionId).toBe(expectedRevisionId);
      await expect(
        window.getByRole('toolbar', { name: 'Selected React element actions' })
      ).toBeVisible();
    };
    const mapVisiblePreviewPoint = async (element: Locator, evidenceName: string) => {
      const [frameBounds, frameMetrics, localTarget] = await Promise.all([
        previewFrame.boundingBox(),
        previewFrame.evaluate((frame) => ({
          clientHeight: frame.clientHeight,
          clientLeft: frame.clientLeft,
          clientTop: frame.clientTop,
          clientWidth: frame.clientWidth,
          offsetHeight: frame.offsetHeight,
          offsetWidth: frame.offsetWidth
        })),
        element.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
          const hit = document.elementFromPoint(point.x, point.y);
          return {
            hitIsWithinTarget: hit === node || node.contains(hit),
            point,
            viewport: { width: window.innerWidth, height: window.innerHeight }
          };
        })
      ]);
      if (!frameBounds || frameMetrics.offsetWidth <= 0 || frameMetrics.offsetHeight <= 0)
        throw new Error(`${evidenceName} preview frame is not measurable.`);
      expect(localTarget.viewport).toEqual({
        height: frameMetrics.clientHeight,
        width: frameMetrics.clientWidth
      });
      expect(localTarget.hitIsWithinTarget).toBe(true);
      const scale = {
        x: frameBounds.width / frameMetrics.offsetWidth,
        y: frameBounds.height / frameMetrics.offsetHeight
      };
      const point = {
        x:
          frameBounds.x +
          frameMetrics.clientLeft * scale.x +
          (localTarget.point.x / localTarget.viewport.width) * frameMetrics.clientWidth * scale.x,
        y:
          frameBounds.y +
          frameMetrics.clientTop * scale.y +
          (localTarget.point.y / localTarget.viewport.height) * frameMetrics.clientHeight * scale.y
      };
      const iframeHit = await previewFrame.evaluate((frame, outerPoint) => {
        const hit = document.elementFromPoint(outerPoint.x, outerPoint.y);
        return { isExactPreviewFrame: hit === frame, tagName: hit?.tagName ?? null };
      }, point);
      await test.info().attach(`${evidenceName}-mapped-preview-point.json`, {
        body: JSON.stringify(
          { frameBounds, frameMetrics, iframeHit, localTarget, point, scale },
          null,
          2
        ),
        contentType: 'application/json'
      });
      expect(iframeHit).toEqual({ isExactPreviewFrame: true, tagName: 'IFRAME' });
      return point;
    };
    await selectRoot();
    await window
      .getByRole('toolbar', { name: 'Canvas tools' })
      .getByRole('button', { name: 'Components' })
      .click();
    const catalogExplorer = window.getByLabel('Component and Storybook explorer');
    await expect(catalogExplorer.getByRole('article', { name: 'Button' })).toBeVisible();
    await catalogExplorer.getByRole('button', { name: 'Use in design', exact: true }).click();
    await expect(window.getByRole('group', { name: 'Canvas library' })).toBeVisible();
    await window
      .getByRole('group', { name: 'Canvas library' })
      .getByRole('button', { name: 'Assets', exact: true })
      .click();

    await selectRoot();
    const assetRail = window.getByLabel('Assets', { exact: true });
    await expect(assetRail).toContainText('Source-backed flex container selected');
    const buttonEntry = assetRail.locator('[data-catalog-component="Button"]');
    await expect(buttonEntry).toHaveAttribute('data-draggable', 'true');
    await buttonEntry.getByLabel('Label').fill('Place order');
    await buttonEntry.getByLabel('Tone').selectOption('secondary');
    const insert = buttonEntry.getByRole('button', {
      name: 'Insert Button into the selected React container',
      exact: true
    });
    await expect(insert).toBeEnabled();
    const insertionRevision = await window.evaluate(
      async () => (await window.selene.designer.snapshot()).source.revision.id
    );
    const insertionFrame = await previewFrame.getAttribute('src');
    const catalogDragEvidenceKey = `__seleneCatalogDragEvidence_${Date.now()}`;
    await window.evaluate((key) => {
      const events: unknown[] = [];
      const record = (event: DragEvent) => {
        const eventTarget = event.target instanceof Element ? event.target : null;
        events.push({
          type: event.type,
          targetClass: eventTarget?.getAttribute('class') ?? null,
          targetCatalogDragKey: (eventTarget as HTMLElement | null)?.dataset.catalogDragKey ?? null,
          targetLabel: eventTarget?.getAttribute('aria-label') ?? null,
          targetTag: eventTarget?.tagName ?? null,
          clientX: event.clientX,
          clientY: event.clientY,
          defaultPrevented: event.defaultPrevented,
          targetArtifact:
            eventTarget
              ?.closest('[aria-label="Compiled React artboard"]')
              ?.getAttribute('aria-label') ?? null,
          transferPresent: event.dataTransfer !== null,
          transferTypes: event.dataTransfer ? [...event.dataTransfer.types] : []
        });
      };
      const types = ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend'] as const;
      for (const type of types) document.addEventListener(type, record, true);
      (window as typeof window & Record<string, unknown>)[key] = {
        events,
        dispose: () => types.forEach((type) => document.removeEventListener(type, record, true))
      };
    }, catalogDragEvidenceKey);
    await buttonEntry
      .getByLabel('Drag Button onto the selected React container', { exact: true })
      .dragTo(window.locator('[data-catalog-drop-surface]'));
    const catalogDragEvidence = await window.evaluate(async (key) => {
      const state = (window as typeof window & Record<string, unknown>)[key] as
        { readonly events: readonly unknown[]; readonly dispose: () => void } | undefined;
      state?.dispose();
      delete (window as typeof window & Record<string, unknown>)[key];
      const snapshot = await window.selene.designer.snapshot();
      const plane = document.querySelector<HTMLElement>('.canvas-artboard__catalog-drop');
      return {
        events: state?.events ?? [],
        catalogInsertStatus:
          document.querySelector('.canvas-workspace__asset-status')?.textContent?.trim() ?? null,
        insertStatus: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
        manualEditStatus:
          document.querySelector('[aria-label="Manual React edit status"]')?.textContent?.trim() ??
          null,
        plane: plane
          ? {
              active: plane.dataset.active ?? null,
              ready: plane.dataset.ready ?? null,
              rect: plane.getBoundingClientRect().toJSON()
            }
          : null,
        selectedCatalogTarget: snapshot.catalogInsertTarget?.nodeId ?? null,
        sourceRevisionId: snapshot.source.revision.id
      };
    }, catalogDragEvidenceKey);
    await test.info().attach('catalog-native-drag-delivery.json', {
      body: JSON.stringify(catalogDragEvidence, null, 2),
      contentType: 'application/json'
    });
    // Catalog insertion refreshes the source-backed preview, which may close
    // the transient asset rail. Assert the durable host revision and rebuilt
    // frame below instead of an unmounted rail-local status message.
    try {
      await expect
        .poll(
          () =>
            window.evaluate(
              async () => (await window.selene.designer.snapshot()).source.revision.id
            ),
          { timeout: previewPresentationTimeout }
        )
        .not.toBe(insertionRevision);
    } catch (error) {
      const failure = await window.evaluate(async () => {
        const snapshot = await window.selene.designer.snapshot();
        return {
          catalogInsertStatus:
            document.querySelector('.canvas-workspace__asset-status')?.textContent?.trim() ?? null,
          manualEditStatus:
            document
              .querySelector('[aria-label="Manual React edit status"]')
              ?.textContent?.trim() ?? null,
          selectedCatalogTarget: snapshot.catalogInsertTarget?.nodeId ?? null,
          sourceRevisionId: snapshot.source.revision.id,
          statuses: [...document.querySelectorAll('[role="status"], [aria-live]')]
            .map((element) => element.textContent?.trim())
            .filter((value): value is string => Boolean(value))
        };
      });
      await test.info().attach('catalog-insertion-failure.json', {
        body: JSON.stringify(failure, null, 2),
        contentType: 'application/json'
      });
      throw error;
    }
    await expect
      .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
      .not.toBe(insertionFrame);
    const insertedButton = prototype.getByRole('button', { name: 'Place order', exact: true });
    await expect(insertedButton).toBeVisible({ timeout: previewPresentationTimeout });

    const insertedPoint = await mapVisiblePreviewPoint(insertedButton, 'inserted-catalog-button');
    await window.mouse.click(insertedPoint.x, insertedPoint.y);
    await window
      .getByRole('toolbar', { name: 'Selected React element actions' })
      .getByRole('button', { name: 'Inspect', exact: true })
      .click();
    await window.getByRole('tab', { name: 'Inspect', exact: true }).click();
    const componentProperties = window.getByLabel('Design-system component properties');
    await expect(componentProperties).toBeVisible();
    const toneRevision = await window.evaluate(
      async () => (await window.selene.designer.snapshot()).source.revision.id
    );
    const toneFrame = await previewFrame.getAttribute('src');
    await componentProperties.getByLabel('Tone', { exact: true }).selectOption('primary');
    await componentProperties.getByRole('button', { name: 'Apply Tone', exact: true }).click();
    await expect(componentProperties.getByRole('status')).toContainText(
      'Tone updated in the React artifact.'
    );
    await expect
      .poll(() =>
        window.evaluate(async () => (await window.selene.designer.snapshot()).source.revision.id)
      )
      .not.toBe(toneRevision);
    await expect
      .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
      .not.toBe(toneFrame);
    await expect(insertedButton).toHaveAttribute('data-tone', 'primary');

    await selectRoot();
    await window
      .getByRole('toolbar', { name: 'Selected React element actions' })
      .getByRole('button', { name: 'Inspect', exact: true })
      .click();
    await window.getByRole('tab', { name: 'Inspect', exact: true }).click();
    const appearance = window.getByLabel('Manual React appearance edit');
    await expect(appearance).toBeVisible();
    const fillToken = appearance.getByLabel('Design token for Fill');
    await expect(fillToken).toBeVisible();
    const actionPrimaryToken = fillToken
      .locator('option')
      .filter({ hasText: /^Action primary ·/u });
    const actionPrimaryTokenId = await actionPrimaryToken.getAttribute('value');
    if (!actionPrimaryTokenId) throw new Error('Action primary token has no governed identifier.');
    await fillToken.selectOption(actionPrimaryTokenId);
    const appearanceRevision = await window.evaluate(
      async () => (await window.selene.designer.snapshot()).source.revision.id
    );
    const appearanceFrame = await previewFrame.getAttribute('src');
    await appearance.getByRole('button', { name: 'Apply backgroundColor', exact: true }).click();
    await expect(appearance.getByRole('status')).toContainText(
      'Fill updated in the React artifact.'
    );
    await expect
      .poll(() =>
        window.evaluate(async () => (await window.selene.designer.snapshot()).source.revision.id)
      )
      .not.toBe(appearanceRevision);
    await expect
      .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
      .not.toBe(appearanceFrame);

    const action = prototype.getByRole('button', { name: 'Open orders', exact: true });
    const actionPoint = await mapVisiblePreviewPoint(action, 'mapped-open-orders-action');
    await window.mouse.click(actionPoint.x, actionPoint.y);
    const moveHandle = window.getByRole('button', { name: 'Move selected element', exact: true });
    await expect(moveHandle).toBeVisible();
    const orderBefore = await prototype
      .locator('[data-selene-node-id]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-selene-node-id'))
      );
    const reorderRevision = await window.evaluate(
      async () => (await window.selene.designer.snapshot()).source.revision.id
    );
    const reorderFrame = await previewFrame.getAttribute('src');
    await moveHandle.focus();
    await moveHandle.press('Alt+ArrowUp');
    const directStatus = window.getByLabel('Direct manipulation status');
    await expect(directStatus).toContainText(/Reordered|Moved to a compatible container/u);
    await expect
      .poll(() =>
        window.evaluate(async () => (await window.selene.designer.snapshot()).source.revision.id)
      )
      .not.toBe(reorderRevision);
    await expect
      .poll(() => previewFrame.getAttribute('src'), { timeout: previewPresentationTimeout })
      .not.toBe(reorderFrame);
    const orderAfter = await prototype
      .locator('[data-selene-node-id]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-selene-node-id'))
      );
    expect(orderAfter).not.toEqual(orderBefore);
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
