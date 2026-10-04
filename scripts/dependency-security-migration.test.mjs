import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTlsServer, get as httpsGet } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createTemporaryLocalhostTls } from './temporary-localhost-tls.mjs';

const root = resolve(import.meta.dirname, '..');
const rootRequire = createRequire(resolve(root, 'package.json'));
const builderRequire = createRequire(
  createRequire(rootRequire.resolve('electron-builder/package.json')).resolve(
    'app-builder-lib/package.json'
  )
);
const get = builderRequire('@electron/get');
const builder = builderRequire('./out/util/electronGet.js');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const listen = (server) => new Promise((done) => server.listen(0, '127.0.0.1', done));
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
};
const originOf = (server) => `http://127.0.0.1:${server.address().port}`;
const artifactOptions = (origin, directory, payload, downloadOptions = {}) => ({
  artifactName: 'electron',
  platformName: 'linux',
  arch: 'x64',
  version: '9.9.9',
  cacheDir: resolve(directory, 'cache'),
  electronDownload: {
    force: false,
    checksums: { 'electron-v9.9.9-linux-x64.zip': sha256(payload) },
    mirrorOptions: { resolveAssetURL: () => `${origin}/artifact` },
    downloadOptions: { quiet: true, ...downloadOptions }
  }
});
const withOrigin = async (handler, check) => {
  const server = createServer(handler);
  const directory = await mkdtemp(resolve(tmpdir(), 'selene-fetch-migration-'));
  try {
    await listen(server);
    await check(server, directory);
  } finally {
    if (server.listening) await close(server);
    await rm(directory, { recursive: true, force: true });
  }
};

describe('dependency chain removal and exploit evidence', () => {
  it('retains the actual cookie disclosure reproduction, including the unsafe 4.3.0 bump', async () => {
    // Archive as test data, outside package resolution, with exact release bytes.
    const fixture = JSON.parse(
      await readFile(
        resolve(
          root,
          'scripts/fixtures/dependency-security/http-cache-semantics-4.3.0.source.json'
        ),
        'utf8'
      )
    );
    expect(sha256(fixture.source)).toBe(fixture.indexSha256);
    const module = { exports: {} };
    runInNewContext(fixture.source, { module }, { timeout: 1000 });
    const request = { url: 'https://example.invalid/account', method: 'GET', headers: {} };
    const policy = new module.exports(request, {
      status: 200,
      headers: { 'cache-control': 'max-age=60', 'set-cookie': 'session=other-user' }
    });
    const received = policy.now();
    policy.now = () => received + 2000;
    expect(policy.maxAge()).toBe(0);
    expect(
      policy.evaluateRequest({ ...request, headers: { 'cache-control': 'max-stale=86400' } })
        .response.headers['set-cookie']
    ).toBe('session=other-user');
  });

  it('removes both vulnerable chains while preserving the raw audit gate', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const lock = await readFile(resolve(root, 'bun.lock'), 'utf8');
    expect(manifest.scripts['audit:dependencies']).toBe('bun audit && bun audit --production');
    expect(manifest.devDependencies['@changesets/cli']).toBe('3.0.3');
    expect(manifest.overrides['@electron/get']).toBe('5.1.0');
    expect(manifest.patchedDependencies['app-builder-lib@26.15.3']).toBe(
      'patches/app-builder-lib@26.15.3.patch'
    );
    const patch = await readFile(resolve(root, 'patches/app-builder-lib@26.15.3.patch'), 'utf8');
    expect([...patch.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((match) => match[1])).toEqual([
      'out/binDownload.js',
      'out/util/electronGet.d.ts',
      'out/util/electronGet.js'
    ]);
    for (const removed of [
      'braces',
      'micromatch',
      'fast-glob',
      'globby',
      'got',
      'cacheable-request',
      'http-cache-semantics'
    ]) {
      expect(lock).not.toMatch(new RegExp(`"${removed}(?:/[^" ]*)?": \\["`));
      expect(() => builderRequire.resolve(removed)).toThrow(/Cannot find module/);
    }
  });

  it('uses the same official Fetch downloader for packaging and Electron installation', async () => {
    const electronRequire = createRequire(
      createRequire(resolve(root, 'apps/desktop/package.json')).resolve('electron/package.json')
    );
    expect(builderRequire.resolve('@electron/get')).toBe(electronRequire.resolve('@electron/get'));
    const manifest = JSON.parse(
      await readFile(
        resolve(dirname(builderRequire.resolve('@electron/get')), '../package.json'),
        'utf8'
      )
    );
    expect(manifest.name).toBe('@electron/get');
    expect(manifest.version).toBe('5.1.0');
    expect(typeof get.FetchDownloader).toBe('function');
  });

  it('fetches each forced artifact despite shared cookies and client max-stale', async () => {
    let requests = 0;
    const payloads = [Buffer.from('user one artifact'), Buffer.from('user two artifact')];
    await withOrigin(
      (_request, response) => {
        const payload = payloads[requests++];
        response.writeHead(200, {
          'content-length': String(payload.length),
          'cache-control': 'max-age=60',
          'set-cookie': `session=user-${requests}; HttpOnly; Secure`
        });
        response.end(payload);
      },
      async (server, directory) => {
        const download = async (payload) => {
          const options = artifactOptions(originOf(server), directory, payload, {
            headers: { 'cache-control': 'max-stale=86400' }
          });
          options.electronDownload.force = true;
          const downloaded = await builder.downloadElectronArtifactZip(options);
          expect(await readFile(downloaded)).toEqual(payload);
        };
        await download(payloads[0]);
        await download(payloads[1]);
        expect(requests).toBe(2);
      }
    );
  });
});

describe('desktop Fetch migration compatibility', () => {
  it('refuses checkout-local TLS files, including symlinked temporary directories', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'selene-tls-containment-'));
    const alias = resolve(directory, 'source-checkout');
    const original = Object.fromEntries(
      ['TMPDIR', 'TEMP', 'TMP'].map((key) => [key, process.env[key]])
    );
    try {
      await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const rejectsLocalTemp = async (temporaryRoot) => {
        for (const key of Object.keys(original)) process.env[key] = temporaryRoot;
        await expect(
          (async () => {
            const tls = await createTemporaryLocalhostTls();
            await tls.dispose();
          })()
        ).rejects.toThrow('Temporary TLS directory must be outside the source checkout');
      };
      await rejectsLocalTemp(root);
      await rejectsLocalTemp(alias);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires explicit CA trust and matching hostname, then removes disposable TLS files', async () => {
    const tls = await createTemporaryLocalhostTls();
    const server = createTlsServer({ key: tls.key, cert: tls.cert }, (_request, response) => {
      response.end('verified TLS');
    });
    const request = (options = {}) =>
      new Promise((done, reject) => {
        const clientRequest = httpsGet(
          originOf(server).replace('http:', 'https:'),
          { agent: false, ...options },
          (response) => {
            let body = '';
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () => done(body));
            response.on('error', reject);
          }
        );
        clientRequest.on('error', reject);
      });
    try {
      await listen(server);
      await expect(request()).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
      await expect(request({ ca: tls.cert })).resolves.toBe('verified TLS');
      await expect(request({ ca: tls.cert, servername: 'example.invalid' })).rejects.toMatchObject({
        code: 'ERR_TLS_CERT_ALTNAME_INVALID'
      });
    } finally {
      try {
        if (server.listening) await close(server);
      } finally {
        await tls.dispose();
      }
    }
    await expect(access(tls.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains packaging progress reporting through the migrated builder', async () => {
    const payload = Buffer.alloc(1024 * 1024, 'x');
    const info = vi.spyOn(builderRequire('builder-util').log, 'info').mockImplementation(() => {});
    try {
      await withOrigin(
        (_request, response) => {
          response.writeHead(200, { 'content-length': String(payload.length) });
          response.end(payload);
        },
        async (server, directory) => {
          expect(
            await readFile(
              await builder.downloadElectronArtifactZip(
                artifactOptions(originOf(server), directory, payload)
              )
            )
          ).toEqual(payload);
          expect(info.mock.calls).toEqual(
            expect.arrayContaining([
              [expect.objectContaining({ label: 'electron', progress: '100%' }), 'downloaded']
            ])
          );
        }
      );
    } finally {
      info.mockRestore();
    }
  });
  it('verifies a freshly fetched SHASUMS256 file with the migrated default options', async () => {
    const payload = Buffer.from('remote checksum fixture');
    const paths = [];
    await withOrigin(
      (request, response) => {
        paths.push(request.url);
        const bytes =
          request.url === '/SHASUMS256.txt'
            ? Buffer.from(`${sha256(payload)} *electron-v9.9.9-linux-x64.zip\n`)
            : payload;
        response.writeHead(200, { 'content-length': String(bytes.length) });
        response.end(bytes);
      },
      async (server, directory) => {
        const options = artifactOptions(originOf(server), directory, payload);
        delete options.electronDownload.checksums;
        options.electronDownload.mirrorOptions.resolveAssetURL = (details) =>
          `${originOf(server)}/${details.artifactName === 'SHASUMS256.txt' ? 'SHASUMS256.txt' : 'artifact'}`;
        expect(await readFile(await builder.downloadElectronArtifactZip(options))).toEqual(payload);
        expect(paths).toEqual(['/artifact', '/SHASUMS256.txt']);
      }
    );
  });

  it('preserves generic binDownload checksum, cache, offline and output-copy behavior', async () => {
    const payload = Buffer.from('generic tool fixture');
    const binary = builderRequire('./out/binDownload.js');
    let requests = 0;
    await withOrigin(
      (_request, response) => {
        requests++;
        response.writeHead(200, { 'content-length': String(payload.length) });
        response.end(payload);
      },
      async (server, directory) => {
        const previousCache = process.env.ELECTRON_BUILDER_CACHE;
        process.env.ELECTRON_BUILDER_CACHE = directory;
        const url = `${originOf(server)}/tool.zip`;
        const output = resolve(directory, 'copied.zip');
        try {
          await binary.download(url, output, sha256(payload));
          expect(await readFile(output)).toEqual(payload);
          await binary.download(url, output, sha256(payload));
          expect(requests).toBe(1);
          await expect(binary.download(url, output, '0'.repeat(64))).rejects.toThrow(/checksum/i);
          await close(server);
          await binary.download(url, resolve(directory, 'offline-copy.zip'), sha256(payload));
          expect(await readFile(resolve(directory, 'offline-copy.zip'))).toEqual(payload);
        } finally {
          if (previousCache === undefined) delete process.env.ELECTRON_BUILDER_CACHE;
          else process.env.ELECTRON_BUILDER_CACHE = previousCache;
        }
      }
    );
  });
  it('preserves progress, good checksums and bad-checksum rejection through both consumers', async () => {
    const payload = Buffer.from('local compatibility fixture');
    await withOrigin(
      (_request, response) => {
        response.writeHead(200, { 'content-length': String(payload.length) });
        response.end(payload);
      },
      async (server, directory) => {
        const progress = [];
        const options = {
          version: '9.9.9',
          platform: 'linux',
          arch: 'x64',
          artifactName: 'electron',
          cacheRoot: resolve(directory, 'cache'),
          tempDirectory: directory,
          cacheMode: get.ElectronDownloadCacheMode.Bypass,
          checksums: { 'electron-v9.9.9-linux-x64.zip': sha256(payload) },
          mirrorOptions: { resolveAssetURL: () => `${originOf(server)}/artifact` },
          downloadOptions: {
            quiet: true,
            signal: AbortSignal.timeout(3000),
            getProgressCallback: (value) => progress.push(value)
          }
        };
        expect(await readFile(await get.downloadArtifact(options))).toEqual(payload);
        expect(progress.some((value) => value.percent === 1)).toBe(true);
        await expect(
          get.downloadArtifact({
            ...options,
            checksums: { 'electron-v9.9.9-linux-x64.zip': '0'.repeat(64) }
          })
        ).rejects.toThrow(/checksum/i);
        const builderOptions = artifactOptions(originOf(server), directory, payload);
        builderOptions.electronDownload.force = true;
        builderOptions.electronDownload.checksums['electron-v9.9.9-linux-x64.zip'] = '0'.repeat(64);
        await expect(builder.downloadElectronArtifactZip(builderOptions)).rejects.toThrow(
          /checksum/i
        );
      }
    );
  });

  it('preserves verified disk caching, corrupt-cache recovery and offline hits', async () => {
    let requests = 0;
    const payload = Buffer.from('verified cache fixture');
    await withOrigin(
      (_request, response) => {
        requests++;
        response.writeHead(200, { 'content-length': String(payload.length) });
        response.end(payload);
      },
      async (server, directory) => {
        const options = artifactOptions(originOf(server), directory, payload);
        const downloaded = await builder.downloadElectronArtifactZip(options);
        expect(await readFile(await builder.downloadElectronArtifactZip(options))).toEqual(payload);
        expect(requests).toBe(1);
        await writeFile(downloaded, 'corrupt cached data');
        expect(await readFile(await builder.downloadElectronArtifactZip(options))).toEqual(payload);
        expect(requests).toBe(2);
        await close(server);
        expect(await readFile(await builder.downloadElectronArtifactZip(options))).toEqual(payload);
        expect(requests).toBe(2);
      }
    );
  });

  it.each(['headers', 'body'])(
    'bounds stalled %s with a Fetch signal through the builder',
    async (stage) => {
      await withOrigin(
        (_request, response) => {
          if (stage === 'body') {
            response.writeHead(200, { 'content-length': '1000' });
            response.write('partial');
          }
        },
        async (server, directory) => {
          const started = performance.now();
          await expect(
            builder.downloadElectronArtifactZip(
              artifactOptions(originOf(server), directory, Buffer.from('timeout'), {
                signal: AbortSignal.timeout(100)
              })
            )
          ).rejects.toThrow(/timeout|abort/i);
          expect(performance.now() - started).toBeLessThan(1500);
        }
      );
    }
  );

  it.each([
    'agent',
    'timeout',
    'retry',
    'https',
    'username',
    'password',
    'cookieJar',
    'form',
    'json',
    'auth',
    'resolveBodyOnly'
  ])('rejects unsupported got option %s explicitly', async (key) => {
    await expect(
      builder.downloadElectronArtifactZip(
        artifactOptions('http://127.0.0.1:1', tmpdir(), Buffer.from('x'), { [key]: {} })
      )
    ).rejects.toThrow(`${key} is unsupported`);
  });

  it('retains arbitrary options for an explicit custom downloader', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'selene-custom-downloader-'));
    const payload = Buffer.from('custom download');
    const options = artifactOptions('https://example.invalid', directory, payload, {
      username: 'custom-api-user',
      customOption: 'preserved'
    });
    let received;
    options.electronDownload.downloader = {
      download: async (_url, target, customOptions) => {
        received = customOptions;
        await writeFile(target, payload);
      }
    };
    try {
      expect(await readFile(await builder.downloadElectronArtifactZip(options))).toEqual(payload);
      expect(received.username).toBe('custom-api-user');
      expect(received.customOption).toBe('preserved');
      expect(received.signal).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([{ strictSSL: false }, { strictSSL: false, force: false }])(
    'rejects TLS validation bypass in either config shape (%j)',
    (electronDownload) => {
      expect(() =>
        builder.downloadElectronArtifactZip({
          artifactName: 'electron',
          platformName: 'linux',
          arch: 'x64',
          version: '9.9.9',
          electronDownload
        })
      ).toThrow(/strictSSL.*unsupported/);
    }
  );

  it('classifies actual Fetch HTTP and wrapped network errors for retry', () => {
    for (const status of [429, 500, 503])
      expect(
        builder.shouldRetryDownloadError(new get.HTTPError(new Response(null, { status })))
      ).toBe(true);
    expect(
      builder.shouldRetryDownloadError(new get.HTTPError(new Response(null, { status: 404 })))
    ).toBe(false);
    for (const code of ['ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'])
      expect(
        builder.shouldRetryDownloadError(new TypeError('fetch failed', { cause: { code } }))
      ).toBe(true);
    expect(builder.shouldRetryDownloadError(new Error('Checksum mismatch'))).toBe(false);
    expect(builder.shouldRetryDownloadError(new DOMException('timed out', 'TimeoutError'))).toBe(
      false
    );
  });

  it('retries a real origin 503 before downloading a verified artifact', async () => {
    let requests = 0;
    const payload = Buffer.from('retried artifact');
    await withOrigin(
      (_request, response) => {
        if (++requests === 1) {
          response.writeHead(503);
          response.end();
          return;
        }
        response.writeHead(200, { 'content-length': String(payload.length) });
        response.end(payload);
      },
      async (server, directory) => {
        expect(
          await readFile(
            await builder.downloadElectronArtifactZip(
              artifactOptions(originOf(server), directory, payload)
            )
          )
        ).toEqual(payload);
        expect(requests).toBe(2);
      }
    );
  });

  it.each([
    ['http', false, 'electron'],
    ['http', true, 'electron'],
    ['https', false, 'electron'],
    ['https', true, 'electron'],
    ['http', false, 'generic'],
    ['http', true, 'generic'],
    ['https', false, 'generic'],
    ['https', true, 'generic']
  ])(
    'honors proxy and NO_PROXY (%s, bypass=%s, %s) in an isolated packaging process',
    async (scheme, bypass, consumer) => {
      const payload = Buffer.from('proxied verified artifact');
      const sockets = new Set();
      let tunnels = 0;
      const proxy = createServer();
      proxy.on('connect', (request, socket, head) => {
        tunnels++;
        const [host, port] = request.url.split(':');
        const upstream = connect(Number(port), host, () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        for (const stream of [socket, upstream]) {
          sockets.add(stream);
          stream.on('close', () => sockets.delete(stream));
          stream.on('error', () => {
            socket.destroy();
            upstream.destroy();
          });
        }
      });
      let tls;
      try {
        await listen(proxy);
        if (scheme === 'https') tls = await createTemporaryLocalhostTls();
        const handler = (_request, response) => {
          response.writeHead(200, { 'content-length': String(payload.length) });
          response.end(payload);
        };
        const server =
          scheme === 'https'
            ? createTlsServer({ key: tls.key, cert: tls.cert }, handler)
            : createServer(handler);
        const directory = await mkdtemp(resolve(tmpdir(), 'selene-proxy-fixture-'));
        try {
          await listen(server);
          const origin = originOf(server).replace('http:', `${scheme}:`);
          const options = artifactOptions(origin, directory, payload);
          const download =
            consumer === 'electron'
              ? `const builder = require(${JSON.stringify(builderRequire.resolve('./out/util/electronGet.js'))}); const options = ${JSON.stringify(options)}; options.electronDownload.mirrorOptions.resolveAssetURL = () => ${JSON.stringify(`${origin}/artifact`)}; const downloaded = await builder.downloadElectronArtifactZip(options);`
              : `const binary = require(${JSON.stringify(builderRequire.resolve('./out/binDownload.js'))}); const downloaded = ${JSON.stringify(resolve(directory, 'generic-output.zip'))}; await binary.download(${JSON.stringify(`${origin}/artifact`)}, downloaded, ${JSON.stringify(sha256(payload))});`;
          const source = `const { readFile } = require('node:fs/promises'); (async () => {${download} console.log('PAYLOAD:'+(await readFile(downloaded)).toString())})().catch(error => {console.error(error);process.exitCode=1});`;
          const child = spawn(process.execPath, ['-e', source], {
            env: {
              ...process.env,
              ...(tls ? { NODE_EXTRA_CA_CERTS: tls.caPath } : {}),
              ELECTRON_BUILDER_CACHE: resolve(directory, 'generic-cache'),
              HTTP_PROXY: originOf(proxy),
              HTTPS_PROXY: originOf(proxy),
              http_proxy: originOf(proxy),
              https_proxy: originOf(proxy),
              NO_PROXY: bypass ? '127.0.0.1' : '',
              no_proxy: bypass ? '127.0.0.1' : ''
            },
            stdio: ['ignore', 'pipe', 'pipe']
          });
          let output = '';
          let errors = '';
          child.stdout.on('data', (chunk) => {
            output += chunk;
          });
          child.stderr.on('data', (chunk) => {
            errors += chunk;
          });
          const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
          const result = await new Promise((done, reject) => {
            child.on('error', reject);
            child.on('close', done);
          });
          clearTimeout(timer);
          expect(errors).toBe('');
          expect(result).toBe(0);
          expect(output).toContain(`PAYLOAD:${payload.toString()}`);
          expect(tunnels).toBe(bypass ? 0 : 1);
        } finally {
          await close(server);
          await rm(directory, { recursive: true, force: true });
        }
      } finally {
        try {
          for (const socket of sockets) socket.destroy();
          if (proxy.listening) await close(proxy);
        } finally {
          await tls?.dispose();
        }
      }
    }
  );
});
