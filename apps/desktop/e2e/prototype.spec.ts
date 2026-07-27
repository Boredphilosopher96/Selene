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
      .toBe('selene-desktop-preload/v4');
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
      const primaryTargetPosition = { x: 0.2, y: 0.2 };
      const selectedThreadTargetPosition = { x: 0.12, y: 0.12 };
      const reviewTargetEvidence: unknown[] = [];
      const selectNormalizedReviewTarget = async (
        reviewTarget: Locator,
        normalized: { readonly x: number; readonly y: number }
      ) => {
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
        await window.mouse.click(gesture.position.x, gesture.position.y);
        const delivery = await window.evaluate(() => ({
          activeTargetLayers: document.querySelectorAll('.preview-target-layer').length,
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
          body: JSON.stringify({ delivery, gesture, hitOwnership }, null, 2),
          contentType: 'application/json'
        });
        const marker = window.getByLabel('Saved stakeholder review target');
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
        await window.getByRole('button', { name: 'Target review discussion', exact: true }).click();
        const reviewTarget = window.getByRole('button', {
          name: 'Select a stakeholder review location in the rendered artifact',
          exact: true
        });
        await expect(reviewTarget).toBeVisible();
        await expect(reviewTarget).toBeEnabled();
        const selectedTarget = await selectNormalizedReviewTarget(reviewTarget, normalized);
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
      await window.getByLabel('Configured agent').selectOption('configured-jsonl-agent');
      await window.getByLabel('AI change instruction').fill('Make the primary action explicit.');
      const targetAiChange = window.getByRole('button', { name: 'Target AI change', exact: true });
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
                targetMode: layout.dataset.targetMode,
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
        name: 'Select an AI change target in the rendered artifact',
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
          throw new Error('Expected the saved review thread to remain visible while targeting.');
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
      expect(
        targetLayerDiagnostics.artifacts.pins.find(
          (pin) => pin.label === 'Select artifact pin marker: Saved pin over the AI target.'
        )
      ).toMatchObject({ inert: true, overlapsPoint: true, pointerEvents: 'none' });
      expect(targetLayerDiagnostics.artifacts.selectedThread).toMatchObject({
        inert: true,
        overlapsPoint: false,
        pointerEvents: 'none',
        text: expect.stringContaining('Selected review thread over the AI target.')
      });
      await test.info().attach('target-ai-layer-pre-click.json', {
        body: JSON.stringify(targetLayerDiagnostics, null, 2),
        contentType: 'application/json'
      });
      await window.keyboard.press('Escape');
      await expect(spatialTarget).toBeHidden();
      await expect(targetAiChange).toBeFocused();
      await expect(selectedPin).toBeEnabled();
      await selectedPin.click();
      await expect(selectedPin).toHaveAttribute('aria-pressed', 'true');
      await expect(selectedThreadCard.getByLabel('Close selected review thread')).toBeFocused();
      await targetAiChange.click();
      await expect(spatialTarget).toBeVisible();
      await expect(spatialTarget).toBeEnabled();
      await clickSpatialTarget();
      await expect(window.getByText('AI target selected: Point near the top-left.')).toBeVisible();
      await window.getByRole('button', { name: 'Send targeted change' }).click();
      await expect(window.getByText('AI update in progress…')).toBeVisible({
        timeout: 5_000
      });
      const conversationHistory = window.getByLabel('AI conversation history');
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
      const [previewBounds, flowBounds, viewportBeforePinch] = await Promise.all([
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
      expect(worldAfterPinch.x).toBeCloseTo(worldBeforePinch.x, 0);
      expect(worldAfterPinch.y).toBeCloseTo(worldBeforePinch.y, 0);
      await test.info().attach('live-preview-canvas-gesture-evidence.json', {
        body: JSON.stringify(
          {
            gesturePoint,
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
        .getByRole('button', { name: /Selection/ })
        .click();
      await expect(selectedThreadCard).toBeVisible();
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
      await window.mouse.click(
        initialAction.geometry.action.center.x,
        initialAction.geometry.action.center.y
      );
      expect(await previewNavigationEvidence()).toMatchObject({
        route: '/',
        historyState: { screen: 'dashboard' },
        heading: 'Configured agent dashboard'
      });
      await window.getByRole('tab', { name: 'Inspect', exact: true }).click();
      const developerDetails = window.getByLabel('Selection developer details');
      await expect(developerDetails.getByText('Live preview', { exact: true })).toBeVisible();
      await expect(developerDetails.getByText('button', { exact: true })).toBeVisible();
      await unifiedCanvas
        .getByRole('toolbar', { name: 'Canvas tools' })
        .getByRole('button', { name: 'Present', exact: true })
        .click();
      const presentation = window.getByLabel('Prototype presentation', { exact: true });
      await expect(presentation).toBeVisible();
      await expect(presentation.getByRole('button', { name: /Exit/ })).toBeVisible();
      await expect(unifiedCanvas).toHaveCount(0);
      const presentedAction = await previewFrameAction({
        label: 'Open orders',
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
          label: 'Open orders',
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
        label: 'Open orders',
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
          label: 'Open orders',
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

      await (
        await openReviewHandoff()
      )
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

      await window.getByLabel('AI change instruction').fill('Record the post-baseline update.');
      await expect(targetAiChange).toBeVisible();
      await expect(targetAiChange).toBeEnabled();
      await targetAiChange.click();
      await expect(spatialTarget).toBeVisible();
      await expect(spatialTarget).toBeEnabled();
      await clickSpatialTarget();
      await expect(
        window.getByText('AI target selected: Point near the top-left.', { exact: true })
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

      await (
        await openReviewHandoff()
      )
        .getByRole('button', { name: 'Export handoff', exact: true })
        .click();
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
      const openCompactAi = window.getByRole('button', { name: 'Open AI', exact: true });
      await expect(openCompactAi).toBeVisible();
      await openCompactAi.click();
      const compactAiTarget = window.getByRole('button', {
        name: 'Target AI change',
        exact: true
      });
      await expect(compactAiTarget).toBeVisible();
      await expect(compactAiTarget).toBeEnabled();
      await compactAiTarget.click();
      await expect(openCompactAi).toBeVisible();
      const compactTargetLayer = window.getByRole('button', {
        name: 'Select an AI change target in the rendered artifact',
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
      await window.keyboard.press('Escape');
      await expect(compactTargetLayer).toBeHidden();
      await expect(openCompactAi).toHaveCount(0);
      await expect(compactAiTarget).toBeVisible();
      await expect(compactAiTarget).toBeFocused();
      await expect(selectedPin).not.toHaveAttribute('inert', '');

      await compactAiTarget.click();
      await expect(compactTargetLayer).toBeVisible();
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
      await expect(openCompactAi).toHaveCount(0);
      await expect(compactAiTarget).toBeVisible();
      await expect(compactAiTarget).toBeFocused();
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

      await window.setViewportSize({ width: 1280, height: 900 });
      await expect(window.locator('.workspace-layout')).toHaveAttribute(
        'data-layout-mode',
        'split-pane'
      );
      await window.getByRole('tab', { name: 'Inspect', exact: true }).click();
      const useInReview = window.getByRole('button', {
        name: 'Use in review comment',
        exact: true
      });
      await expect(useInReview).toBeEnabled();
      await useInReview.click();
      await expect(
        window.getByText('Inspect context is ready for a stakeholder review comment.')
      ).toBeVisible();
      await window.getByRole('button', { name: 'Target review discussion', exact: true }).click();
      const compactReviewLayer = window.getByRole('button', {
        name: 'Select a stakeholder review location in the rendered artifact',
        exact: true
      });
      await expect(compactReviewLayer).toBeVisible();
      expect(
        await compactReviewLayer.evaluate((layer) => {
          const viewport = layer.closest<HTMLElement>('.canvas-workspace');
          if (!viewport) throw new Error('Compact review targeting requires its preview viewport.');
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
