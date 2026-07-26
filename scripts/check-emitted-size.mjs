import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const kibibyte = 1024;

const surfaces = [
  {
    name: 'browser prototype',
    directory: 'apps/web/dist',
    budget: 350 * kibibyte,
    advisory: true
  },
  {
    name: 'Storybook',
    directory: 'storybook-static',
    budget: 8_000 * kibibyte
  },
  {
    name: 'Electron desktop renderer',
    directory: 'apps/desktop/out/renderer',
    budget: 800 * kibibyte
  }
];

async function emittedBytes(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return emittedBytes(path);
      if (entry.isFile()) return (await stat(path)).size;
      return 0;
    })
  );
  return sizes.reduce((total, size) => total + size, 0);
}

const measurements = await Promise.all(
  surfaces.map(async (surface) => ({ ...surface, bytes: await emittedBytes(surface.directory) }))
);

let exceeded = false;
for (const surface of measurements) {
  const { bytes } = surface;
  const overBudget = bytes > surface.budget;
  const status = overBudget ? (surface.advisory ? 'advisory' : 'over budget') : 'ok';
  console.log(
    `${status}: ${surface.name}: ${(bytes / kibibyte).toFixed(1)} KiB / ${(surface.budget / kibibyte).toFixed(1)} KiB`
  );
  exceeded ||= overBudget && surface.advisory !== true;
}

if (exceeded) process.exitCode = 1;
