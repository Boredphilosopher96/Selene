import { spawn } from 'node:child_process';

import { assertHarnessPortAvailable, harnessPorts } from './playwright-harness.mjs';

const port = harnessPorts().storybook;
await assertHarnessPortAvailable('interactive Storybook', port);
const child = spawn(
  './node_modules/.bin/storybook',
  [
    'dev',
    '--config-dir',
    'packages/ui/.storybook',
    '--port',
    String(port),
    '--ci',
    ...process.argv.slice(2)
  ],
  { stdio: 'inherit', env: process.env }
);
const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (signal) reject(new Error(`interactive Storybook exited from signal ${signal}`));
    else resolve(code ?? 1);
  });
});
process.exitCode = exitCode;
