import { spawn } from 'node:child_process';

const parentPollMs = 50;
const terminationEscalationMs = 1_000;

function decodeSpec() {
  const encoded = process.env.SELENE_HARNESS_POSIX_SPEC;
  if (!encoded) throw new Error('SELENE_HARNESS_POSIX_SPEC is required.');
  const spec = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (
    typeof spec.command !== 'string' ||
    !Array.isArray(spec.arguments) ||
    !spec.arguments.every((argument) => typeof argument === 'string') ||
    !Number.isSafeInteger(spec.parentPid)
  ) {
    throw new Error('SELENE_HARNESS_POSIX_SPEC is invalid.');
  }
  return spec;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    if (error && typeof error === 'object' && error.code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(signal) {
  try {
    process.kill(-process.pid, signal);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return;
    throw error;
  }
}

const { command, arguments: arguments_, parentPid } = decodeSpec();
const child = spawn(command, arguments_, { env: process.env, stdio: 'inherit' });
let termination;
let parentWatcher;

const requestTermination = (signal) => {
  termination ??= (async () => {
    signalGroup(signal);
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(terminationEscalationMs)
    ]);
    if (child.exitCode === null && child.signalCode === null) signalGroup('SIGKILL');
  })();
  return termination;
};

const signalHandlers = new Map();
for (const signal of ['SIGINT', 'SIGTERM']) {
  const handler = () => {
    void requestTermination(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

parentWatcher = setInterval(() => {
  if (process.ppid !== parentPid || !processExists(parentPid)) void requestTermination('SIGTERM');
}, parentPollMs);
parentWatcher.unref();

const { code, signal } = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
});
clearInterval(parentWatcher);
for (const [handledSignal, handler] of signalHandlers)
  process.removeListener(handledSignal, handler);

if (termination) await termination;
if (signal) process.kill(process.pid, signal);
process.exitCode = code ?? 1;
