import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
await copy('storybook-static', 'storybook');
await copy('docs', 'docs');

await writeFile(
  resolve(site, 'docs/index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Selene documentation</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; }
      main { max-width: 48rem; margin: 0 auto; padding: 3rem 1.5rem; }
      li { margin: .65rem 0; }
    </style>
  </head>
  <body>
    <main>
      <p><a href="../">Selene</a></p>
      <h1>Documentation</h1>
      <p>The source documents below ship with each public-site build.</p>
      <ul>
        <li><a href="./architecture/README.md">Architecture overview</a></li>
        <li><a href="./architecture/ADR-0001-local-first-headless-core.md">ADR 0001: local-first headless core</a></li>
        <li><a href="./architecture/ADR-0002-react-source-model.md">ADR 0002: React source model</a></li>
        <li><a href="./architecture/ADR-0003-portable-agent-protocol.md">ADR 0003: portable agent protocol</a></li>
        <li><a href="./architecture/ADR-0004-federated-design-inputs.md">ADR 0004: federated design inputs</a></li>
        <li><a href="./architecture/ADR-0005-trust-boundaries.md">ADR 0005: trust boundaries</a></li>
      </ul>
    </main>
  </body>
</html>
`
);

await writeFile(
  resolve(site, 'index.html'),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="Selene public documentation, demo, and component Storybook." />
    <title>Selene</title>
    <style>
      :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
      main { max-width: 44rem; padding: 3rem 1.5rem; }
      h1 { font-size: clamp(2.5rem, 10vw, 5rem); margin: 0; }
      p { font-size: 1.125rem; line-height: 1.6; }
      nav { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 2rem; }
      a { border: 1px solid currentColor; border-radius: .5rem; color: inherit; padding: .7rem 1rem; text-decoration: none; }
      a:hover { text-decoration: underline; }
    </style>
  </head>
  <body>
    <main>
      <h1>Selene</h1>
      <p>A local-first workspace for the web, desktop, and typed shared packages.</p>
      <nav aria-label="Public resources">
        <a href="./demo/">Web demo</a>
        <a href="./storybook/">Component Storybook</a>
        <a href="./docs/">Architecture documents</a>
      </nav>
    </main>
  </body>
</html>
`
);
