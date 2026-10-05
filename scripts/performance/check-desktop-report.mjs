import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const desktopPerformanceBudgets = Object.freeze({
  launchP95Ms: 1200,
  firstProjectToPaintMs: 1500,
  selectionP95Ms: 150,
  projectReopenP95Ms: 500,
  previewRefreshP95Ms: 450,
  presentReturnP95Ms: 900,
  snapshotIpcP95Ms: 10,
  initialJavaScriptBytes: 350 * 1024,
  initialStylesheetBytes: 140 * 1024,
  fixtureSnapshotCharacters: 64 * 1024,
  transientNotices: 128,
  idleRendererHeapBytes: 256 * 1024 * 1024,
  sustainedSessionMs: 180000
});

/** These are reference-fixture guardrails, not hardware-independent latency promises. */
export function checkDesktopPerformanceReport(report, { requireSustainedSession = true } = {}) {
  const failures = [];
  const atMost = (label, value, budget) => {
    if (!Number.isFinite(value) || value < 0 || value > budget)
      failures.push(`${label}: observed ${String(value)}, budget ${budget}`);
  };
  const atLeast = (label, value, minimum) => {
    if (!Number.isFinite(value) || value < minimum)
      failures.push(`${label}: observed ${String(value)}, minimum ${minimum}`);
  };
  if (report.complete !== true || report.error) failures.push('The native run did not complete');
  if (report.methodology?.diagnosticForcedGc !== false)
    failures.push('Forced-GC diagnostics do not qualify as production performance evidence');
  const builtFiles = report.methodology?.builtFiles;
  if (
    !Array.isArray(builtFiles) ||
    ['main', 'preload', 'renderer'].some(
      (surface) =>
        !builtFiles.some(
          ({ path }) => typeof path === 'string' && path.startsWith(`apps/desktop/out/${surface}/`)
        )
    ) ||
    builtFiles.some(
      ({ sha256, bytes }) =>
        typeof sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(sha256) ||
        !Number.isSafeInteger(bytes) ||
        bytes < 0
    )
  )
    failures.push('The receipt is missing production main/preload/renderer file fingerprints');
  if (
    !/^[a-f0-9]{40}$/u.test(report.methodology?.sourceCommit ?? '') ||
    !/^[a-f0-9]{64}$/u.test(report.methodology?.harnessSha256 ?? '') ||
    report.methodology?.trackedSourceDiffSha256 !==
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  )
    failures.push(
      'The native receipt must identify the harness and an unchanged committed source tree'
    );
  if (report.rendererEvents?.some(({ event }) => event === 'crash' || event === 'pageerror'))
    failures.push('The observed renderer crashed or raised an uncaught page error');
  atLeast('launch samples', report.launchReadyMs?.samples, 3);
  atMost('launch p95 ms', report.launchReadyMs?.p95, desktopPerformanceBudgets.launchP95Ms);
  atMost(
    'first project to paint ms',
    report.projectCreateToPaintMs,
    desktopPerformanceBudgets.firstProjectToPaintMs
  );
  atLeast('selection samples', report.selectionToAuthorizedPaintMs?.samples, 60);
  atMost(
    'selection p95 ms',
    report.selectionToAuthorizedPaintMs?.p95,
    desktopPerformanceBudgets.selectionP95Ms
  );
  atMost(
    'project reopen p95 ms',
    report.warmProjectOpenToPaintMs?.p95,
    desktopPerformanceBudgets.projectReopenP95Ms
  );
  atMost(
    'preview refresh p95 ms',
    report.warmPreviewRefreshToPaintMs?.p95,
    desktopPerformanceBudgets.previewRefreshP95Ms
  );
  atMost(
    'presentation return p95 ms',
    report.presentReturnToPaintMs?.p95,
    desktopPerformanceBudgets.presentReturnP95Ms
  );
  atMost(
    'snapshot IPC p95 ms',
    report.snapshotIpc?.times?.p95,
    desktopPerformanceBudgets.snapshotIpcP95Ms
  );
  for (const [index, launch] of (report.launches ?? []).entries()) {
    if (!launch.encryptedStorage || launch.storageBackend === 'basic_text')
      failures.push(`launch ${index + 1}: protected storage was unavailable`);
    if (
      !launch.windows?.length ||
      launch.windows.some(
        ({ sandbox, contextIsolation, nodeIntegration }) =>
          !sandbox || !contextIsolation || nodeIntegration
      )
    )
      failures.push(`launch ${index + 1}: sandbox/isolation requirements were not preserved`);
    if (!launch.resources?.length) {
      failures.push(
        `launch ${index + 1}: initial resource coverage is unavailable; an empty list is not zero bytes`
      );
      continue;
    }
    if (
      !['.js', '.css'].every((extension) =>
        launch.resources.some(({ path }) => typeof path === 'string' && path.endsWith(extension))
      )
    )
      failures.push(
        `launch ${index + 1}: both initial script and stylesheet coverage are required`
      );
    const bytes = (extension) =>
      launch.resources
        .filter(({ path }) => path.endsWith(extension))
        .reduce((sum, { emittedBytes }) => sum + emittedBytes, 0);
    atMost(
      `launch ${index + 1} linked JavaScript bytes`,
      bytes('.js'),
      desktopPerformanceBudgets.initialJavaScriptBytes
    );
    atMost(
      `launch ${index + 1} linked stylesheet bytes`,
      bytes('.css'),
      desktopPerformanceBudgets.initialStylesheetBytes
    );
  }
  if (requireSustainedSession) {
    atLeast(
      'sustained timebox ms (includes notice burst)',
      report.sustainedSession?.elapsedMs,
      desktopPerformanceBudgets.sustainedSessionMs
    );
    atLeast('mixed UI cycles', report.sustainedSession?.cycles, 30);
    atLeast('real notice-burst IPC calls', report.noticeBurst?.calls, 10000);
    atMost(
      'transient notices after burst',
      report.noticeBurst?.transientNotices,
      desktopPerformanceBudgets.transientNotices
    );
    atMost(
      'fixture snapshot characters after burst',
      report.noticeBurst?.snapshotJsonCharacters,
      desktopPerformanceBudgets.fixtureSnapshotCharacters
    );
    atMost(
      'idle renderer JS heap bytes',
      report.idleMetrics?.renderer?.JSHeapUsedSize,
      desktopPerformanceBudgets.idleRendererHeapBytes
    );
    atMost('idle detached/live DOM documents', report.idleMetrics?.dom?.documents, 4);
    atMost(
      'after-session selection p95 ms',
      report.afterSessionSelectionToAuthorizedPaintMs?.p95,
      desktopPerformanceBudgets.selectionP95Ms
    );
  }
  if (
    !Array.isArray(report.cleanup) ||
    report.cleanup.length < (report.launches?.length ?? Infinity)
  )
    failures.push('Every native launch must have a completed owned-process cleanup observation');
  if (
    report.cleanup?.some(
      ({ liveProcesses }) => !Array.isArray(liveProcesses) || liveProcesses.length
    )
  )
    failures.push('Owned native processes survived application close');
  if (
    report.cleanup?.some(
      ({ observedProcessCount }) =>
        !Number.isSafeInteger(observedProcessCount) || observedProcessCount < 1
    )
  )
    failures.push('Owned native process identity observations are unavailable');
  return { passed: failures.length === 0, failures, budgets: desktopPerformanceBudgets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error('Pass the native performance JSON receipt path.');
  const report = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const result = checkDesktopPerformanceReport(report);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
