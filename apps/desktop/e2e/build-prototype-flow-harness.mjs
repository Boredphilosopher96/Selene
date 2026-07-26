import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const fixtures = [
  { directoryName: 'prototype-flow-harness', entrypoint: 'prototype-flow-harness.tsx' },
  {
    directoryName: 'workspace-toolbar-diagnostics-harness',
    entrypoint: 'workspace-toolbar-diagnostics-harness.tsx'
  }
];

async function buildFixture(fixture) {
  const outputDirectory = join(directory, '..', '..', '..', '.cache', fixture.directoryName);
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(directory, fixture.entrypoint)],
    outdir: outputDirectory,
    target: 'browser',
    format: 'esm',
    naming: `${fixture.directoryName}.[ext]`,
    define: { 'process.env.NODE_ENV': '"development"' }
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Could not build the ${fixture.directoryName} Electron test fixture.`);
  }
  const script = result.outputs.find((output) => output.path.endsWith('.js'));
  const stylesheet = result.outputs.find((output) => output.path.endsWith('.css'));
  if (!script) throw new Error(`${fixture.directoryName} did not emit JavaScript.`);
  await writeFile(
    join(outputDirectory, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>${fixture.directoryName}</title>${stylesheet ? `<link rel="stylesheet" href="./${basename(stylesheet.path)}">` : ''}</head><body><div id="root"></div><script type="module" src="./${basename(script.path)}"></script></body></html>`
  );
}

await Promise.all(fixtures.map(buildFixture));
