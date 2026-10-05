import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { checkDesktopPerformanceReport } from './check-desktop-report.mjs';

function fixture() {
  const launch = {
    encryptedStorage: true,
    storageBackend: 'gnome_libsecret',
    windows: [{ sandbox: true, contextIsolation: true, nodeIntegration: false }],
    resources: [
      { path: 'assets/index.js', emittedBytes: 310000 },
      { path: 'assets/index.css', emittedBytes: 120000 }
    ]
  };
  return {
    complete: true,
    methodology: {
      diagnosticForcedGc: false,
      sourceCommit: '1'.repeat(40),
      harnessSha256: '2'.repeat(64),
      trackedSourceDiffSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      builtFiles: ['main', 'preload', 'renderer'].map((surface) => ({
        path: `apps/desktop/out/${surface}/index.js`,
        bytes: 10,
        sha256: '3'.repeat(64)
      }))
    },
    launches: Array.from({ length: 3 }, () => structuredClone(launch)),
    launchReadyMs: { samples: 3, p95: 800 },
    projectCreateToPaintMs: 1000,
    selectionToAuthorizedPaintMs: { samples: 60, p95: 100 },
    warmProjectOpenToPaintMs: { p95: 300 },
    warmPreviewRefreshToPaintMs: { p95: 230 },
    presentReturnToPaintMs: { p95: 500 },
    snapshotIpc: { times: { p95: 4 } },
    sustainedSession: { elapsedMs: 181000, cycles: 80 },
    noticeBurst: { calls: 10000, transientNotices: 128, snapshotJsonCharacters: 18000 },
    idleMetrics: { renderer: { JSHeapUsedSize: 40000000 }, dom: { documents: 1 } },
    afterSessionSelectionToAuthorizedPaintMs: { p95: 100 },
    cleanup: Array.from({ length: 3 }, () => ({ observedProcessCount: 6, liveProcesses: [] }))
  };
}

it('checks completed unforced native fixture observations without treating missing values as zero', () => {
  expect(checkDesktopPerformanceReport(fixture()).passed).toBe(true);
  const report = fixture();
  report.launches[0].resources = [];
  expect(checkDesktopPerformanceReport(report).failures).toContain(
    'launch 1: initial resource coverage is unavailable; an empty list is not zero bytes'
  );
});

it('refuses incomplete, forced-GC, insecure, over-budget and leaking-process observations', () => {
  const report = fixture();
  report.complete = false;
  report.methodology.diagnosticForcedGc = true;
  report.launches[0].windows[0].sandbox = false;
  report.noticeBurst.transientNotices = 10000;
  report.cleanup[0].liveProcesses = [{ pid: 123 }];
  const result = checkDesktopPerformanceReport(report);
  expect(result.passed).toBe(false);
  expect(result.failures).toHaveLength(5);
});

it('does not qualify a partial artifact identity or a missing cleanup observation', () => {
  const report = fixture();
  report.methodology.builtFiles = [];
  report.cleanup.pop();
  expect(checkDesktopPerformanceReport(report).failures).toHaveLength(2);
});

it('rejects missing stylesheet, dirty source, renderer errors and unobserved process identities', () => {
  const report = fixture();
  report.launches[0].resources.pop();
  report.methodology.trackedSourceDiffSha256 = '4'.repeat(64);
  report.rendererEvents = [{ event: 'pageerror' }];
  report.cleanup[0].observedProcessCount = 0;
  expect(checkDesktopPerformanceReport(report).failures).toHaveLength(4);
});

it('rejects malformed observations without copying receipt content into diagnostics', () => {
  const marker = 'private-receipt-value';
  const report = fixture();
  report.selectionToAuthorizedPaintMs.samples = marker;
  report.selectionToAuthorizedPaintMs.p95 = marker;
  report.afterSessionSelectionToAuthorizedPaintMs.p95 = {
    toString() {
      throw new Error('Receipt values must not be stringified');
    }
  };

  const result = checkDesktopPerformanceReport(report);

  expect(result.passed).toBe(false);
  expect(result.failures).toEqual([
    'selection samples: missing or invalid numeric observation, minimum 60',
    'selection p95 ms: missing or invalid numeric observation, budget 150',
    'after-session selection p95 ms: missing or invalid numeric observation, budget 150'
  ]);
  expect(JSON.stringify(result)).not.toContain(marker);
});

it('keeps inclusive numeric budget boundaries and reports out-of-range metric labels', () => {
  const report = fixture();
  report.selectionToAuthorizedPaintMs.p95 = 150;
  report.afterSessionSelectionToAuthorizedPaintMs.p95 = 150;
  expect(checkDesktopPerformanceReport(report).passed).toBe(true);

  report.selectionToAuthorizedPaintMs.samples = 59;
  report.selectionToAuthorizedPaintMs.p95 = 151;
  report.afterSessionSelectionToAuthorizedPaintMs.p95 = 151;
  expect(checkDesktopPerformanceReport(report).failures).toEqual([
    'selection samples: below minimum 60',
    'selection p95 ms: exceeds budget 150',
    'after-session selection p95 ms: exceeds budget 150'
  ]);
});

it.each([false, true])(
  'emits safe CLI diagnostics and the correct exit code (invalid: %s)',
  (invalid) => {
    const directory = mkdtempSync(join(tmpdir(), 'selene-performance-check-'));
    try {
      const report = fixture();
      const marker = 'private-receipt-value';
      if (invalid) {
        report.selectionToAuthorizedPaintMs.samples = marker;
        report.selectionToAuthorizedPaintMs.p95 = marker;
        report.afterSessionSelectionToAuthorizedPaintMs.p95 = marker;
      }
      const receipt = join(directory, 'receipt.json');
      writeFileSync(receipt, JSON.stringify(report));
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./check-desktop-report.mjs', import.meta.url)), receipt],
        { encoding: 'utf8' }
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(invalid ? 1 : 0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain(marker);
      expect(JSON.parse(result.stdout)).toEqual(checkDesktopPerformanceReport(report));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);
