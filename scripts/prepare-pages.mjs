import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { documentationIndexPage, pagesStyles, publicLandingPage } from './pages-content.mjs';

const root = process.cwd();
const site = resolve(root, 'site');

const copy = async (source, destination) => {
  await cp(resolve(root, source), resolve(site, destination), {
    recursive: true,
    force: true
  });
};

await rm(site, { recursive: true, force: true });
await mkdir(site, { recursive: true });
await copy('apps/web/dist', 'demo');
await copy('apps/web/dist/404.html', '404.html');
await copy('storybook-static', 'storybook');
await copy('docs', 'docs');

await writeFile(resolve(site, 'pages.css'), pagesStyles);
await writeFile(
  resolve(site, 'docs/index.html'),
  documentationIndexPage().replace(
    `<style>${pagesStyles}</style>`,
    '<link rel="stylesheet" href="../pages.css" />'
  )
);
await writeFile(
  resolve(site, 'index.html'),
  publicLandingPage().replace(
    `<style>${pagesStyles}</style>`,
    '<link rel="stylesheet" href="./pages.css" />'
  )
);
