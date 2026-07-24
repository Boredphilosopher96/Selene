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

function childGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return false;
    if (error && typeof error === 'object' && error.code === 'EPERM') return true;
    throw error;
  }
}

function signalChildGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ESRCH') return;
    throw error;
  }
}

async function waitForChildGroupExit(pid) {
  return new Promise((resolve, reject) => {
    let timer;
    let timeout;
    const finish = (value) => {
      clearInterval(timer);
      clearTimeout(timeout);
      resolve(value);
    };
    const check = () => {
      try {
        if (!childGroupExists(pid)) finish(true);
      } catch (error) {
        clearInterval(timer);
        clearTimeout(timeout);
        reject(error);
      }
    };
    timer = setInterval(check, parentPollMs);
    timeout = setTimeout(() => finish(false), terminationEscalationMs);
    check();
  });
}

const { command, arguments: arguments_, parentPid } = decodeSpec();
// The server process owns a separate group. This supervisor remains outside it
// so it can verify and, if needed, force only server descendants to exit.
const child = spawn(command, arguments_, { detached: true, env: process.env, stdio: 'inherit' });
let termination;
let parentWatcher;

const requestTermination = (signal) => {
  termination ??= (async () => {
    signalChildGroup(child.pid, signal);
    if (await waitForChildGroupExit(child.pid)) return;
    signalChildGroup(child.pid, 'SIGKILL');
    if (!(await waitForChildGroupExit(child.pid)))
      throw new Error(`Harness child process group ${child.pid} did not terminate.`);
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
await requestTermination('SIGTERM');
clearInterval(parentWatcher);
for (const [handledSignal, handler] of signalHandlers)
  process.removeListener(handledSignal, handler);

if (signal) process.kill(process.pid, signal);
process.exitCode = code ?? 1;
