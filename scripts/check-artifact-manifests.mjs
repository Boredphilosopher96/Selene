import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  aggregateComponentCatalogs,
  validateArtifactManifests,
  validateComponentCatalogSources
} from '../packages/core/dist/index.js';

const root = process.cwd();
const artifactDirectory = 'examples/generated/orders-prototype';

async function readJson(path) {
  return JSON.parse(await readFile(resolve(root, path), 'utf8'));
}

const prototype = await readJson(`${artifactDirectory}/executable-prototype.manifest.json`);
const catalog = await readJson(`${artifactDirectory}/component-catalog.manifest.json`);
const reader = {
  async read(path) {
    try {
      return await readFile(resolve(root, path), 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    }
  }
};

const issues = [
  ...validateArtifactManifests(prototype, catalog),
  ...(await validateComponentCatalogSources(catalog, reader))
];
if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join('\n'));

const index = aggregateComponentCatalogs([catalog]);
if (index.projects.length !== 1 || index.projects[0]?.projectId !== prototype.projectId)
  throw new Error('Component catalog index did not preserve the generated project manifest.');

console.log(
  `Validated ${prototype.projectId} executable prototype and component catalog manifests.`
);
