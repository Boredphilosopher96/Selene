import { runHarnessServer } from './harness-server-process.mjs';
import { harnessPorts } from './playwright-harness.mjs';

const port = harnessPorts().storybook;
process.exitCode = await runHarnessServer({
  label: 'interactive Storybook',
  port,
  command: 'bun',
  arguments_: [
    'run',
    'storybook:serve',
    '--',
    '--port',
    String(port),
    '--exact-port',
    '--ci',
    ...process.argv.slice(2)
  ]
});
