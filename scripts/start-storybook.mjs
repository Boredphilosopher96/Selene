import { runHarnessServer } from './harness-server-process.mjs';
import { harnessPorts } from './playwright-harness.mjs';

const port = harnessPorts().storybook;
process.exitCode = await runHarnessServer({
  label: 'interactive Storybook',
  port,
  command: 'bun',
  arguments_: [
    'x',
    '--bun',
    'storybook',
    'dev',
    '--config-dir',
    'packages/ui/.storybook',
    '--port',
    String(port),
    '--exact-port',
    '--ci',
    ...process.argv.slice(2)
  ]
});
