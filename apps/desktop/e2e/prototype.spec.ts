import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const mainEntry = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const agentFixture = fileURLToPath(new URL('./designer-agent.fixture.mjs', import.meta.url));
const require = createRequire(import.meta.url);

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

test('configured JSONL agent revises, renders, baselines, and exports a stale handoff', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'selene-desktop-e2e-'));
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
    args: [mainEntry, `--user-data-dir=${userData}`]
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

      await window.getByRole('button', { name: 'Mark ready' }).click();
      await expect(window.getByText('ready-for-handoff / current')).toBeVisible({ timeout: 5_000 });

      await window.getByLabel('AI change instruction').fill('Record the post-baseline update.');
      await window.getByRole('button', { name: 'Send targeted change' }).click();
      await expect(window.getByText('ready-for-handoff / stale')).toBeVisible({ timeout: 5_000 });
      await expect(window.getByText('1 changes since baseline')).toBeVisible({ timeout: 5_000 });

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
