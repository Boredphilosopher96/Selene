import { _electron as electron, expect, test } from '@playwright/test';
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

function desktopArgs(userData: string): string[] {
  return [
    mainEntry,
    `--user-data-dir=${userData}`,
    ...(process.platform === 'linux' ? ['--password-store=gnome-libsecret'] : [])
  ];
}

/** Match Playwright's Linux CI launcher for direct child processes only. */
function rawDesktopArgs(userData: string): string[] {
  return [
    ...desktopArgs(userData),
    ...(process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : [])
  ];
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

test('uses encrypted libsecret safeStorage instead of Linux basic_text', async () => {
  test.skip(process.platform !== 'linux', 'Linux Secret Service is CI-specific.');
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-safe-storage-backend-'));
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  try {
    await application.firstWindow({ timeout: 5_000 });
    expect(
      await application.evaluate(({ safeStorage }) => ({
        encryptionAvailable: safeStorage.isEncryptionAvailable(),
        backend: safeStorage.getSelectedStorageBackend()
      }))
    ).toEqual({ encryptionAvailable: true, backend: 'gnome_libsecret' });
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('rejects a second Electron process for the same local user-data owner', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-single-instance-'));
  const first = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  let second: ChildProcess | undefined;
  try {
    await first.firstWindow({ timeout: 5_000 });
    second = spawn(await electronExecutable(), rawDesktopArgs(userData), {
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
      await expect(window.getByRole('alert')).toContainText('Crash recovery is active.');
      await expect(window.getByRole('button', { name: 'Render revision' })).toBeDisabled();
      await window.getByRole('button', { name: 'Resume previews' }).click();
      await expect(window.getByRole('alert')).toBeHidden();
      await expect(window.getByRole('button', { name: 'Render revision' })).toBeEnabled();
      await expect(
        window.getByText('Crash recovery reset. You can render a revision again.')
      ).toBeVisible();
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
    denied = spawn(await electronExecutable(), rawDesktopArgs(userData), {
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

test('keeps privacy controls explicit and local in the desktop recovery-capable shell', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-privacy-'));
  const application = await electron.launch({
    executablePath: await electronExecutable(),
    args: desktopArgs(userData)
  });
  try {
    const window = await application.firstWindow({ timeout: 5_000 });
    const consent = window.getByLabel('Store local crash diagnostics on this device');
    await expect(window.getByRole('status')).toHaveText('Validated local workspace ready.');
    await expect(consent).not.toBeChecked();
    await consent.click();
    await expect(
      window.getByText('Local crash diagnostics enabled. Nothing is sent automatically.')
    ).toBeVisible();
    await consent.click();
    await expect(
      window.getByText('Local crash diagnostics disabled and queued events deleted.')
    ).toBeVisible();
    await window.getByRole('button', { name: 'Delete diagnostics' }).click();
    await expect(window.getByText('Deleted local crash diagnostics.')).toBeVisible();
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('configured JSONL agent revises, renders, baselines, and exports a stale handoff', async () => {
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
      await expect(window.getByText('Compiled React artifact')).toBeVisible({ timeout: 5_000 });
      await window.getByLabel('Configured agent').selectOption('configured-jsonl-agent');
      await window.getByLabel('AI change instruction').fill('Make the primary action explicit.');
      await window.getByRole('button', { name: 'Target a point or region' }).click();
      const spatialTarget = window.getByRole('button', {
        name: 'Select a spatial change target in the preview'
      });
      await expect(spatialTarget).toBeVisible();
      await spatialTarget.click({
        position: { x: 120, y: 80 }
      });
      await window.getByRole('button', { name: 'Send targeted change' }).click();
      await expect(window.getByText('completed: Validated revision applied.')).toBeVisible({
        timeout: 5_000
      });
      await expect(window.getByText('applied: Make the primary action explicit.')).toBeVisible({
        timeout: 5_000
      });
      const prototype = window.frameLocator('iframe[title="Generated React preview frame"]');
      await expect(
        prototype.getByRole('heading', { name: 'Configured agent dashboard' })
      ).toBeVisible({ timeout: 5_000 });
      await prototype.getByRole('button', { name: 'Open orders' }).click();
      await expect(prototype.getByRole('heading', { name: 'Orders' })).toBeVisible({
        timeout: 5_000
      });

      await window.getByRole('button', { name: 'Ready for review' }).click();
      await expect(window.getByText('ready-for-review / current')).toBeVisible({ timeout: 5_000 });
      await window.getByRole('button', { name: 'Ready for handoff' }).click();
      await expect(window.getByText('ready-for-handoff / current')).toBeVisible({ timeout: 5_000 });

      await window.getByLabel('AI change instruction').fill('Record the post-baseline update.');
      await window.getByRole('button', { name: 'Send targeted change' }).click();
      await expect(window.getByText('ready-for-handoff / stale')).toBeVisible({ timeout: 5_000 });
      await expect(window.getByText('1 changes since handoff baseline')).toBeVisible({
        timeout: 5_000
      });
      await expect(window.getByText('Prior handoff approvals are stale.')).toBeVisible({
        timeout: 5_000
      });

      await window.getByRole('button', { name: 'Export handoff' }).click();
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
    } catch (error) {
      throw failure(error);
    }
  } finally {
    await closeElectron(application);
    await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
