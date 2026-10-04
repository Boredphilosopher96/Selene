import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import type { DesignInputCallContext } from '@selene/design-inputs';
import { createDesktopDesignInputLoader } from './design-input-runtime';
import { DesktopDesignSystemIntake } from './designer-setup-host';
import { desktopDesignInputRuntime } from './design-input-runtime';
import { NpmDesignInputAdapter } from './npm-design-input-adapter';

const request = { name: '@acme/design-system', version: '1.2.3' };
const archiveUrl = 'https://registry.npmjs.org/@acme/design-system/-/design-system-1.2.3.tgz';
const now = () => new Date('2026-09-30T12:00:00.000Z');
const manifest = {
  ...request,
  license: 'MIT',
  scripts: { postinstall: 'this code must never execute' },
  peerDependencies: { react: '^19.0.0' },
  exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } },
  selene: {
    designSystem: {
      schemaVersion: '1',
      tokenFiles: ['./dist/tokens.json'],
      components: [{ name: 'Button', entrypoint: '.', exportName: 'Button' }],
      designLanguagePath: './DESIGN.md'
    }
  }
};

interface TarEntry {
  readonly name: string;
  readonly content?: string | Buffer;
  readonly type?: string;
  readonly link?: string;
}

function tar(tarEntries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of tarEntries) {
    const body = Buffer.from(entry.content ?? '');
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100);
    header.write('0000644\0', 100, 8);
    header.write('0000000\0', 108, 8);
    header.write('0000000\0', 116, 8);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    header.write('00000000000\0', 136, 12);
    header.fill(32, 148, 156);
    header.write(entry.type ?? '0', 156, 1);
    header.write(entry.link ?? '', 157, 100);
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function entries(packageJson: unknown = manifest): readonly TarEntry[] {
  return [
    { name: 'package/package.json', content: JSON.stringify(packageJson) },
    {
      name: 'package/dist/index.js',
      content: 'throw new Error("package code was evaluated"); export const Button = {};'
    },
    { name: 'package/dist/index.d.ts', content: 'export declare const Button: unknown;' },
    { name: 'package/dist/tokens.json', content: '{"color":"#2563eb"}' },
    { name: 'package/DESIGN.md', content: '# Design\n\n## Principles\n\nUse semantic tokens.' },
    { name: 'package/LICENSE', content: 'MIT license fixture' }
  ];
}

function context(controller = new AbortController()): DesignInputCallContext {
  return {
    ownerGeneration: 1,
    remainingMs: 5000,
    cancellation: {
      isCancellationRequested: () => controller.signal.aborted,
      reason: () => (controller.signal.aborted ? 'caller-aborted' : undefined),
      subscribe(listener) {
        const abort = () => listener('caller-aborted');
        controller.signal.addEventListener('abort', abort);
        return () => controller.signal.removeEventListener('abort', abort);
      }
    }
  };
}

interface RegistryOptions {
  readonly archive?: Buffer;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly serve?: (path: string, response: ServerResponse) => boolean;
}

async function withRegistry(
  options: RegistryOptions,
  operation: (
    adapter: NpmDesignInputAdapter,
    paths: readonly string[],
    transport: typeof fetch
  ) => Promise<void>
): Promise<void> {
  const archive = options.archive ?? gzipSync(tar(entries()));
  const metadata = {
    ...request,
    license: 'MIT',
    dist: {
      tarball: archiveUrl,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`
    },
    ...options.metadata
  };
  const paths: string[] = [];
  const server = createServer((incoming, response) => {
    const path = incoming.url ?? '';
    paths.push(path);
    if (options.serve?.(path, response)) return;
    if (path.endsWith('.tgz')) {
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.end(archive);
    } else {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(metadata));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Fixture server did not start');
  const transport: typeof fetch = async (url, fetchOptions) => {
    const original = new URL(
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    );
    const response = await fetch(
      `http://127.0.0.1:${address.port}${original.pathname}`,
      fetchOptions
    );
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
  try {
    await operation(new NpmDesignInputAdapter({ fetch: transport, now }), paths, transport);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }
}

describe('public npm design-input adapter', () => {
  it('retrieves one exact scoped version over HTTP and preserves source, archive integrity, license and provenance without execution', async () => {
    await withRegistry({}, async (adapter, paths) => {
      const resolved = await adapter.resolvePackage(context(), request);
      expect(paths).toEqual([
        '/%40acme%2Fdesign-system/1.2.3',
        '/@acme/design-system/-/design-system-1.2.3.tgz'
      ]);
      expect(resolved.packageJson).toEqual({
        name: '@acme/design-system',
        version: '1.2.3',
        peerDependencies: { react: '^19.0.0' },
        exports: manifest.exports,
        selene: manifest.selene
      });
      expect(resolved.files.find((file) => file.path === './dist/index.js')?.content).toBe(
        'throw new Error("package code was evaluated"); export const Button = {};'
      );
      expect(
        JSON.parse(resolved.files.find((file) => file.path === './package.json')?.content ?? '')
      ).toMatchObject({ license: 'MIT', scripts: manifest.scripts });
      expect(
        JSON.parse(
          resolved.files.find((file) => file.path === './selene-npm-receipt.json')?.content ?? ''
        )
      ).toMatchObject({
        format: 'selene-npm-package-receipt/v1',
        name: '@acme/design-system',
        version: '1.2.3',
        registry: 'https://registry.npmjs.org',
        archiveUrl,
        license: 'MIT',
        fileCount: 6
      });
      expect(resolved.provenance).toEqual({
        provider: 'npm-registry',
        location: 'npm:@acme/design-system@1.2.3'
      });
      expect(
        await adapter.readDesignLanguage(context(), {
          location: 'npm:@acme/design-system@1.2.3/DESIGN.md'
        })
      ).toMatchObject({ markdown: '# Design\n\n## Principles\n\nUse semantic tokens.' });
    });
  });

  it('passes the real supervised intake and preserves its exact component export and receipt', async () => {
    await withRegistry({}, async (adapter) => {
      const intake = new DesktopDesignSystemIntake(adapter.port(), desktopDesignInputRuntime, {
        requiredPeerDependencies: { react: '^19.0.0' },
        provider: { label: 'public npm registry', supports: () => true }
      });
      expect(await intake.inspectPackage(request)).toMatchObject({
        status: 'staged',
        packageName: '@acme/design-system',
        version: '1.2.3',
        exports: ['.'],
        peerCompatibility: 'compatible',
        provenance: { provider: 'npm-registry' },
        catalog: { components: [{ name: 'Button', exportName: 'Button', entrypoint: '.' }] }
      });
      await expect(
        createDesktopDesignInputLoader(adapter.port()).inspectPackage({
          package: request,
          requiredPeerDependencies: { react: '^18.0.0' }
        })
      ).rejects.toMatchObject({
        issues: [
          {
            code: 'incompatible-input',
            message: 'Design input does not satisfy the requested compatibility contract.'
          }
        ]
      });
    });
  });

  it('loads package-owned guidance through the parallel portable loader on its first request', async () => {
    await withRegistry({}, async (adapter) => {
      const loaded = await createDesktopDesignInputLoader(adapter.port()).load({
        package: request,
        designLanguage: { location: 'npm:@acme/design-system@1.2.3/DESIGN.md' },
        requiredPeerDependencies: { react: '^19.0.0' }
      });
      expect(loaded).toMatchObject({
        library: { name: '@acme/design-system', version: '1.2.3' },
        language: { sections: [{ heading: 'Design' }, { heading: 'Principles' }] }
      });
    });
  });

  it('keeps the artifact receipt identical across restarts while retaining the actual trusted retrieval time', async () => {
    await withRegistry({}, async (adapter, _paths, transport) => {
      const restarted = new NpmDesignInputAdapter({
        fetch: transport,
        now: () => new Date('2026-10-01T12:00:00.000Z')
      });
      const first = await adapter.retrievePackage(context(), request);
      const second = await restarted.retrievePackage(context(), request);
      expect(first.receipt.retrievedAt).toBe('2026-09-30T12:00:00.000Z');
      expect(second.receipt.retrievedAt).toBe('2026-10-01T12:00:00.000Z');
      const policy = {
        requiredPeerDependencies: { react: '^19.0.0' },
        provider: { label: 'public npm registry', supports: () => true }
      };
      const firstIntake = new DesktopDesignSystemIntake(
        adapter.port(),
        desktopDesignInputRuntime,
        policy
      );
      const secondIntake = new DesktopDesignSystemIntake(
        restarted.port(),
        desktopDesignInputRuntime,
        policy
      );
      const firstReceipt = await firstIntake.inspectPackage(request);
      const secondReceipt = await secondIntake.inspectPackage(request);
      expect(secondReceipt.artifactDigest).toBe(firstReceipt.artifactDigest);
      expect(await restarted.resolvePackage(context(), request)).toEqual(
        await adapter.resolvePackage(context(), request)
      );
    });
  });

  it.each(['latest', '^1.2.3', '1.2', 'file:/tmp/library', '1.2.3/other'])(
    'rejects non-exact version %s before contacting a registry',
    async (version) => {
      await withRegistry({}, async (adapter, paths) => {
        await expect(
          adapter.resolvePackage(context(), { name: request.name, version })
        ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        expect(paths).toEqual([]);
      });
    }
  );

  it('rejects registry/archive identity disagreement and never follows an external tarball URL', async () => {
    await withRegistry({ metadata: { version: '1.2.4' } }, async (adapter, paths) => {
      await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
        code: 'INVALID_METADATA'
      });
      expect(paths).toHaveLength(1);
    });
    await withRegistry(
      {
        metadata: { dist: { tarball: 'http://127.0.0.1/private.tgz', integrity: 'sha512-ignored' } }
      },
      async (adapter, paths) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'INVALID_METADATA'
        });
        expect(paths).toHaveLength(1);
      }
    );
    await withRegistry(
      { archive: gzipSync(tar(entries({ ...manifest, name: '@other/library' }))) },
      async (adapter) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'INVALID_METADATA'
        });
      }
    );
  });

  it('rejects altered archive bytes, weak hashes and attempts to downgrade a declared SHA-512 digest', async () => {
    const archive = gzipSync(tar(entries()));
    const matchingSha256 = createHash('sha256').update(archive).digest('base64');
    for (const integrity of [
      'sha512-' + Buffer.alloc(64).toString('base64'),
      'sha1-' + Buffer.alloc(20).toString('base64'),
      `sha256-${matchingSha256} sha512-${Buffer.alloc(64).toString('base64')}`
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Each fixture owns and closes an isolated HTTP server.
      await withRegistry(
        { archive, metadata: { dist: { tarball: archiveUrl, integrity } } },
        async (adapter) => {
          await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
            code: 'INTEGRITY_FAILED'
          });
        }
      );
    }
  });

  it.each([
    { name: 'package/../outside.js' },
    { name: '/absolute.js' },
    { name: 'package/back\\slash.js' },
    { name: 'package/C:drive.js' },
    { name: 'package/link.js', type: '2', link: 'other.js' },
    { name: 'package/hard.js', type: '1', link: 'package/LICENSE' },
    { name: 'package/device', type: '3' },
    { name: 'package/package.json', content: '{}' },
    { name: 'package/selene-npm-receipt.json', content: '{}' }
  ])('rejects unsafe or duplicate tar entry $name', async (entry) => {
    await withRegistry({ archive: gzipSync(tar([...entries(), entry])) }, async (adapter) => {
      await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
        code: 'UNSAFE_ARCHIVE'
      });
    });
  });

  it('checks tar checksums and rejects truncated or concatenated archives', async () => {
    const valid = tar(entries());
    const badChecksum = Buffer.from(valid);
    badChecksum[0] = 65;
    for (const bytes of [
      badChecksum,
      valid.subarray(0, valid.length - 513),
      Buffer.concat([valid, valid])
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Each fixture owns and closes an isolated HTTP server.
      await withRegistry({ archive: gzipSync(bytes) }, async (adapter) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'UNSAFE_ARCHIVE'
        });
      });
    }
  });

  it('accepts bounded PAX and long-name records only for safe package paths', async () => {
    function pax(value: string): string {
      const body = `path=${value}\n`;
      let length = Buffer.byteLength(body) + 2;
      while (length !== Buffer.byteLength(body) + String(length).length + 1)
        length = Buffer.byteLength(body) + String(length).length + 1;
      return `${length} ${body}`;
    }
    const longPath = `package/${'x'.repeat(110)}.js`;
    await withRegistry(
      {
        archive: gzipSync(
          tar([
            ...entries(),
            { name: 'PaxHeader', type: 'x', content: pax('package/illustration.svg') },
            { name: 'package/placeholder.svg', content: '<svg></svg>' },
            { name: 'LongName', type: 'L', content: `${longPath}\0` },
            { name: 'package/placeholder.js', content: 'export {}' }
          ])
        )
      },
      async (adapter) => {
        const resolved = await adapter.resolvePackage(context(), request);
        expect(resolved.files).toEqual(
          expect.arrayContaining([
            { path: './illustration.svg', content: '<svg></svg>' },
            { path: `./${'x'.repeat(110)}.js`, content: 'export {}' }
          ])
        );
      }
    );
    await withRegistry(
      {
        archive: gzipSync(
          tar([
            ...entries(),
            { name: 'PaxHeader', type: 'x', content: pax('package/../escape.js') },
            { name: 'package/placeholder.js', content: 'export {}' }
          ])
        )
      },
      async (adapter) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'UNSAFE_ARCHIVE'
        });
      }
    );
  });

  it('bounds decompression, entries, files and individual source sizes', async () => {
    const archives = [
      gzipSync(Buffer.alloc(4 * 1024 * 1024 + 512)),
      gzipSync(
        tar([...entries(), { name: 'package/large.js', content: Buffer.alloc(512 * 1024 + 1, 65) }])
      ),
      gzipSync(
        tar([
          ...entries(),
          ...Array.from({ length: 128 }, (_, index) => ({
            name: `package/file-${index}.js`,
            content: 'export {}'
          }))
        ])
      ),
      gzipSync(
        tar(
          Array.from({ length: 257 }, (_, index) => ({ name: `package/dir-${index}`, type: '5' }))
        )
      )
    ];
    for (const archive of archives) {
      // oxlint-disable-next-line no-await-in-loop -- Each fixture owns and closes an isolated HTTP server.
      await withRegistry({ archive }, async (adapter) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'BUDGET_EXCEEDED'
        });
      });
    }
  });

  it('bounds metadata and streamed archive bytes even without a Content-Length', async () => {
    for (const archiveRequest of [false, true]) {
      // oxlint-disable-next-line no-await-in-loop -- The two cases have independent request and archive limits.
      await withRegistry(
        {
          serve(path, response) {
            if (path.endsWith('.tgz') !== archiveRequest) return false;
            response.writeHead(200);
            response.end(Buffer.alloc(archiveRequest ? 2 * 1024 * 1024 + 1 : 256 * 1024 + 1, 65));
            return true;
          }
        },
        async (adapter) => {
          await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
            code: 'BUDGET_EXCEEDED'
          });
        }
      );
    }
  });

  it('does not follow registry redirects or expose transport error text', async () => {
    await withRegistry(
      {
        serve(_path, response) {
          response.writeHead(302, { location: 'http://127.0.0.1/private' });
          response.end();
          return true;
        }
      },
      async (adapter, paths) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'REGISTRY_UNAVAILABLE',
          message: 'The npm registry is unavailable. Retry package inspection.'
        });
        expect(paths).toHaveLength(1);
      }
    );
  });

  it('aborts an in-flight archive stream on supervisor cancellation', async () => {
    let announceArchive: () => void = () => {};
    const archiveStarted = new Promise<void>((resolve) => {
      announceArchive = resolve;
    });
    await withRegistry(
      {
        serve(path, response) {
          if (!path.endsWith('.tgz')) return false;
          response.writeHead(200);
          response.write(Buffer.from([31, 139]));
          announceArchive();
          return true;
        }
      },
      async (adapter) => {
        const controller = new AbortController();
        const pending = adapter.resolvePackage(context(controller), request);
        await archiveStarted;
        controller.abort();
        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      }
    );
  });

  it('requires an approved archive license and existing export target', async () => {
    await withRegistry(
      {
        archive: gzipSync(tar(entries({ ...manifest, license: 'UNLICENSED' }))),
        metadata: { license: 'UNLICENSED' }
      },
      async (adapter) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'LICENSE_UNAPPROVED'
        });
      }
    );
    await withRegistry(
      { archive: gzipSync(tar(entries({ ...manifest, exports: { '.': './missing.js' } }))) },
      async (adapter) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'INCOMPATIBLE_PACKAGE'
        });
      }
    );
  });

  it('reads only the declared package guidance and checks its digest', async () => {
    await withRegistry({}, async (adapter) => {
      expect(
        await adapter.readDesignLanguage(context(), {
          location: 'npm:@acme/design-system@1.2.3/DESIGN.md'
        })
      ).toMatchObject({ markdown: '# Design\n\n## Principles\n\nUse semantic tokens.' });
      await adapter.resolvePackage(context(), request);
      await expect(
        adapter.readDesignLanguage(context(), { location: 'npm:@acme/design-system@1.2.3/LICENSE' })
      ).rejects.toMatchObject({ code: 'INCOMPATIBLE_PACKAGE' });
      await expect(
        adapter.readDesignLanguage(context(), {
          location: 'npm:@acme/design-system@1.2.3/../secret'
        })
      ).rejects.toMatchObject({ code: 'UNSAFE_ARCHIVE' });
      await expect(
        adapter.readDesignLanguage(context(), {
          location: 'npm:@acme/design-system@1.2.3/DESIGN.md',
          expectedSha256: '0'.repeat(64)
        })
      ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    });
  });

  it('keeps retrieved nested metadata immutable and rejects binary files or non-design-system activation', async () => {
    await withRegistry({}, async (adapter) => {
      const retrieved = await adapter.retrievePackage(context(), request);
      const exports = retrieved.packageJson.exports;
      if (exports === null || typeof exports !== 'object')
        throw new Error('Fixture package exports must be an object');
      expect(Reflect.set(exports, '.', './other.js')).toBe(false);
      expect(retrieved.packageJson.exports).toEqual(manifest.exports);
    });
    await withRegistry(
      {
        archive: gzipSync(
          tar([
            ...entries(),
            { name: 'package/image.png', content: Buffer.from([137, 80, 78, 71]) }
          ])
        )
      },
      async (adapter) => {
        await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
          code: 'UNSAFE_ARCHIVE'
        });
      }
    );
    const plainManifest = { name: request.name, version: request.version, license: 'MIT' };
    await withRegistry({ archive: gzipSync(tar(entries(plainManifest))) }, async (adapter) => {
      expect((await adapter.retrievePackage(context(), request)).receipt.license).toBe('MIT');
      await expect(adapter.resolvePackage(context(), request)).rejects.toMatchObject({
        code: 'INCOMPATIBLE_PACKAGE'
      });
    });
  });
});
