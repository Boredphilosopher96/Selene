import { spawn } from 'node:child_process';

import { assertHarnessPortAvailable } from './playwright-harness.mjs';

const terminationEscalationMs = 1_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminateProcessTree(child, signal, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const taskkill = spawn(
        'taskkill',
        ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])],
        { stdio: 'ignore', windowsHide: true }
      );
      taskkill.once('error', resolve);
      taskkill.once('close', resolve);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || typeof error !== 'object' || error.code !== 'ESRCH') return;
  }
}

async function terminateProcessTreeWithEscalation(child, signal) {
  await terminateProcessTree(child, signal);
  await delay(terminationEscalationMs);
  await terminateProcessTree(child, 'SIGKILL', true);
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

  const child = spawn(command, arguments_, {
    detached: process.platform !== 'win32',
    stdio: 'inherit',
    env: environment
  });
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
    if (code !== 0 || terminationSignal) {
      await requestTermination(terminationSignal ?? 'SIGTERM');
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
