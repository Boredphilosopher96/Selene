import { spawn } from 'node:child_process';

import { assertHarnessPortAvailable } from './playwright-harness.mjs';

const [label, portText, command, ...arguments_] = process.argv.slice(2);
const port = Number(portText);
if (!label || !Number.isSafeInteger(port) || !command) {
  throw new Error('Usage: playwright-web-server.mjs <label> <port> <command> [args...]');
}

await assertHarnessPortAvailable(label, port);
const child = spawn(command, arguments_, { stdio: 'inherit', env: process.env });
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`${label} server exited from signal ${signal}`));
    else resolve(code ?? 1);
  });
});
process.exitCode = exitCode;
