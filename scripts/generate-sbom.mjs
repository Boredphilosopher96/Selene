import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = process.cwd();
const argumentsList = process.argv.slice(2);
const outputOption = argumentsList.indexOf('--output');
if (outputOption !== -1 && !argumentsList[outputOption + 1]) {
  throw new Error('--output requires a file path.');
}
const outputPath =
  outputOption === -1
    ? resolve(root, 'artifacts/sbom.cdx.json')
    : resolve(root, argumentsList[outputOption + 1]);
const nodeModules = resolve(root, 'node_modules');
const deniedLicenses = [
  'AGPL-3.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'SSPL-1.0'
];

const packageDirectories = [];

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && entry.name !== '.bin')
      .map(async (entry) => {
        const child = resolve(directory, entry.name);
        if (entry.name.startsWith('@') && entry.isDirectory()) {
          await walk(child);
          return;
        }

        packageDirectories.push(child);
        const nestedNodeModules = resolve(child, 'node_modules');
        try {
          await walk(nestedNodeModules);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      })
  );
};

try {
  await walk(nodeModules);
} catch (error) {
  if (error.code === 'ENOENT') {
    throw new Error(
      'node_modules is missing; run bun install --frozen-lockfile before generating an SBOM.',
      { cause: error }
    );
  }
  throw new Error('Unable to read installed dependencies for SBOM generation.', { cause: error });
}

const manifests = await Promise.all(
  packageDirectories.map(async (directory) => {
    try {
      return JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  })
);

const components = new Map();
for (const manifest of manifests) {
  if (!manifest?.name || !manifest.version) continue;

  const key = `${manifest.name}@${manifest.version}`;
  const license = typeof manifest.license === 'string' ? manifest.license : undefined;
  const forbiddenLicense = deniedLicenses.find((entry) => license?.includes(entry));
  if (forbiddenLicense) {
    throw new Error(`${key} declares denied license ${forbiddenLicense}.`);
  }

  components.set(key, {
    type: 'library',
    'bom-ref': `pkg:npm/${encodeURIComponent(manifest.name)}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
    purl: `pkg:npm/${encodeURIComponent(manifest.name)}@${manifest.version}`
  });
}

if (components.size === 0) {
  throw new Error('No dependency manifests were found in node_modules.');
}

const rootManifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      name: rootManifest.name,
      version: rootManifest.version
    },
    tools: {
      components: [
        {
          type: 'application',
          name: 'Selene SBOM Generator',
          version: '1.0.0'
        }
      ]
    }
  },
  components: [...components.values()].sort((left, right) => left.name.localeCompare(right.name))
};

await mkdir(resolve(outputPath, '..'), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Wrote CycloneDX SBOM with ${components.size} components to ${outputPath}.`);
