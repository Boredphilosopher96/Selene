import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(import.meta.dirname, 'check-emitted-size.mjs');
const fixtures = [];

async function createOutput(rootDirectory, directory, bytes) {
  const output = join(rootDirectory, directory, 'emitted.js');
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, 'x');
  await truncate(output, bytes);
}

async function createFixture() {
  const fixture = await mkdtemp(join(tmpdir(), 'selene-emitted-size-'));
  fixtures.push(fixture);
  return fixture;
}

function report(cwd) {
  return new Promise((resolveReport, rejectReport) => {
    const child = spawn(process.execPath, [script], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectReport);
    child.once('close', (exitCode) => resolveReport({ exitCode, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true }))
  );
});

describe('emitted-size advisory telemetry', () => {
  it('reports all measured surfaces above reference without failing', async () => {
    const fixture = await createFixture();
    await Promise.all([
      createOutput(fixture, 'apps/web/dist', 351 * 1024),
      createOutput(fixture, 'storybook-static', 8_001 * 1024),
      createOutput(fixture, 'apps/desktop/out/renderer', 801 * 1024)
    ]);

    const result = await report(fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('telemetry: above advisory reference: browser prototype');
    expect(result.stdout).toContain('telemetry: above advisory reference: Storybook');
    expect(result.stdout).toContain(
      'telemetry: above advisory reference: Electron desktop renderer'
    );
  });

  it('still fails when an expected emitted output is missing', async () => {
    const fixture = await createFixture();
    await Promise.all([
      createOutput(fixture, 'apps/web/dist', 1),
      createOutput(fixture, 'storybook-static', 1)
    ]);

    const result = await report(fixture);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('apps/desktop/out/renderer');
  });
});
