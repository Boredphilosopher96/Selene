import { spawn } from 'node:child_process';

import { assertHarnessPortAvailable } from './playwright-harness.mjs';

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

  const child = spawn(command, arguments_, { stdio: 'inherit', env: environment });
  let forwardedSignal;
  const signalHandlers = new Map();
  const forwardSignal = (signal) => {
    forwardedSignal ??= signal;
    child.kill(signal);
  };
  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    const handler = () => forwardSignal(signal);
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
