import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertHarnessPortAvailable } from './playwright-harness.mjs';

const terminationEscalationMs = 1_000;
const windowsJobScript = fileURLToPath(new URL('./harness-windows-job.ps1', import.meta.url));

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function terminateProcessTree(
  child,
  signal,
  force = false,
  { platform = process.platform, spawnProcess = spawn, killProcess = process.kill } = {}
) {
  if (!child.pid) return;
  if (platform === 'win32') {
    await new Promise((resolve, reject) => {
      const taskkill = spawnProcess(
        'taskkill',
        ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])],
        { stdio: 'ignore', windowsHide: true }
      );
      taskkill.once('error', reject);
      taskkill.once('close', (code, exitSignal) => {
        if (code === 0) return resolve();
        reject(
          new Error(
            `taskkill failed for harness process ${child.pid} (code ${code}, signal ${exitSignal})`
          )
        );
      });
    });
    return;
  }
  try {
    killProcess(-child.pid, signal);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return;
    throw error;
  }
}

async function terminateProcessTreeWithEscalation(child, signal) {
  await terminateProcessTree(child, signal);
  await delay(terminationEscalationMs);
  await terminateProcessTree(child, 'SIGKILL', true);
}

function spawnHarnessChild(command, arguments_, environment) {
  if (process.platform === 'win32') {
    // The PowerShell supervisor assigns the server to a kill-on-close Job Object.
    // It only exits after closing that job, so a normal direct-child exit cannot
    // orphan server descendants before this process observes it.
    return spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        windowsJobScript,
        command,
        ...arguments_
      ],
      { detached: false, stdio: 'inherit', env: environment }
    );
  }
  return spawn(command, arguments_, {
    detached: true,
    stdio: 'inherit',
    env: environment
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
