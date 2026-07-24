import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertHarnessPortAvailable } from './playwright-harness.mjs';

const terminationEscalationMs = 1_000;
const supervisorTerminationEscalationMs = terminationEscalationMs * 2 + 100;
const windowsJobScript = fileURLToPath(new URL('./harness-windows-job.ps1', import.meta.url));
const posixSupervisorScript = fileURLToPath(
  new URL('./harness-posix-supervisor.mjs', import.meta.url)
);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function terminateProcessTree(
  child,
  signal,
  force = false,
  { platform = process.platform, killProcess = process.kill } = {}
) {
  if (!child.pid) return;
  if (platform === 'win32') {
    // The direct child is the Job Object supervisor. Terminating it closes its
    // only Job Object handle, which atomically kills every assigned descendant.
    // A process can have exited between the event and this cleanup request.
    try {
      killProcess(child.pid, force ? 'SIGKILL' : signal);
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ESRCH') return;
      throw error;
    }
    return;
  }
  try {
    killProcess(-child.pid, signal);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return;
    throw error;
  }
}

function waitForProcessExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

async function terminateProcessTreeWithEscalation(child, signal) {
  const exited = waitForProcessExit(child);
  await terminateProcessTree(child, signal);
  if (process.platform === 'win32') return;
  const exitedBeforeSupervisorBudget = await Promise.race([
    exited.then(() => true),
    delay(supervisorTerminationEscalationMs).then(() => false)
  ]);
  if (exitedBeforeSupervisorBudget) return;
  await terminateProcessTree(child, 'SIGKILL', true);
}

function spawnHarnessChild(command, arguments_, environment) {
  if (process.platform === 'win32') {
    const supervisorSpec = Buffer.from(
      JSON.stringify({ command, arguments: arguments_, parentPid: process.pid }),
      'utf8'
    ).toString('base64');
    // The PowerShell process owns the Job Object. It starts the server suspended,
    // assigns it before resuming, and exits when this wrapper disappears.
    return spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', windowsJobScript],
      {
        detached: false,
        stdio: 'inherit',
        env: { ...environment, SELENE_HARNESS_WINDOWS_SPEC: supervisorSpec }
      }
    );
  }
  const supervisorSpec = Buffer.from(
    JSON.stringify({ command, arguments: arguments_, parentPid: process.pid }),
    'utf8'
  ).toString('base64');
  // This detached session owns the whole server group and watches this wrapper.
  // If the wrapper is SIGKILLed, the supervisor still tears the group down.
  return spawn(process.execPath, [posixSupervisorScript], {
    detached: true,
    stdio: 'inherit',
    env: { ...environment, SELENE_HARNESS_POSIX_SPEC: supervisorSpec }
  });
}

/**
 * Starts a harness server only on its assigned port and relays termination
 * signals so Playwright cannot leave a child server behind between runs.
 */
export async function runHarnessServer({
  label,
  port,
  command,
  arguments_,
  environment = process.env
}) {
  await assertHarnessPortAvailable(label, port);

  const child = spawnHarnessChild(command, arguments_, environment);
  let forwardedSignal;
  let terminationPromise;
  const signalHandlers = new Map();
  const requestTermination = (signal) => {
    forwardedSignal ??= signal;
    terminationPromise ??= terminateProcessTreeWithEscalation(child, signal);
    return terminationPromise;
  };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    const handler = () => {
      void requestTermination(signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  };

  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    const terminationSignal = signal ?? forwardedSignal;
    if (process.platform !== 'win32') {
      await requestTermination(terminationSignal ?? 'SIGTERM');
    } else if (terminationPromise) {
      await terminationPromise;
    }
    if (terminationSignal) {
      removeSignalHandlers();
      process.kill(process.pid, terminationSignal);
      return 1;
    }
    return code ?? 1;
  } finally {
    removeSignalHandlers();
  }
}
