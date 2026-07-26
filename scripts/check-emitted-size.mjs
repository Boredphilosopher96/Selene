import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const kibibyte = 1024;

const surfaces = [
  {
    name: 'browser prototype',
    directory: 'apps/web/dist',
    referenceBytes: 350 * kibibyte
  },
  {
    name: 'Storybook',
    directory: 'storybook-static',
    referenceBytes: 8_000 * kibibyte
  },
  {
    name: 'Electron desktop renderer',
    directory: 'apps/desktop/out/renderer',
    referenceBytes: 800 * kibibyte
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

for (const surface of measurements) {
  const { bytes } = surface;
  const status = bytes <= surface.referenceBytes ? 'within reference' : 'above advisory reference';
  console.log(
    `telemetry: ${status}: ${surface.name}: ${(bytes / kibibyte).toFixed(1)} KiB / reference ${(surface.referenceBytes / kibibyte).toFixed(1)} KiB`
  );
}
