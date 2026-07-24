import { spawn } from 'node:child_process';

import { assertHarnessPortAvailable } from './playwright-harness.mjs';

const terminationEscalationMs = 5_000;

function terminateProcessTree(child, signal, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const taskkill = spawn(
      'taskkill',
      ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])],
      { stdio: 'ignore', windowsHide: true }
    );
    taskkill.once('error', () => {});
    taskkill.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return;
    throw error;
  }
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
  let escalationTimer;
  const signalHandlers = new Map();
  const forwardSignal = (signal) => {
    forwardedSignal ??= signal;
    terminateProcessTree(child, signal);
    escalationTimer ??= setTimeout(
      () => terminateProcessTree(child, 'SIGKILL', true),
      terminationEscalationMs
    );
    escalationTimer.unref();
  };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    const handler = () => forwardSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  const removeSignalHandlers = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    if (escalationTimer) clearTimeout(escalationTimer);
  };

  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    const terminationSignal = signal ?? forwardedSignal;
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
