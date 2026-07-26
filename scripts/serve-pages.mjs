import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
  throw new Error('Usage: node scripts/serve-pages.mjs <port>');

const site = resolve(process.cwd(), 'site');
const publicBasePath = '/Selene';
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function assetPath(pathname) {
  if (pathname !== publicBasePath && !pathname.startsWith(`${publicBasePath}/`)) return undefined;
  const relative = pathname.slice(publicBasePath.length).replace(/^\/+/, '');
  const candidate = resolve(site, relative || 'index.html');
  return candidate === site || candidate.startsWith(`${site}/`) ? candidate : undefined;
}

async function existingFile(pathname) {
  const candidate = assetPath(pathname);
  if (candidate === undefined) return undefined;
  try {
    const metadata = await stat(candidate);
    if (metadata.isFile()) return candidate;
    if (metadata.isDirectory()) {
      const index = resolve(candidate, 'index.html');
      return (await stat(index)).isFile() ? index : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const file = (await existingFile(url.pathname)) ?? resolve(site, '404.html');
  response.writeHead(file.endsWith('404.html') ? 404 : 200, {
    'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store'
  });
  createReadStream(file).pipe(response);
}).listen(port, '127.0.0.1');
