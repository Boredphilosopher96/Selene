import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const requireFrom = (identifier) =>
  createRequire(resolve(root, 'node_modules', '.bun', identifier, 'node_modules', 'package.json'));
const micromatchRequire = requireFrom('micromatch@4.0.8');
const braces = micromatchRequire('braces');
const micromatch = micromatchRequire('micromatch');
const cacheRequire = requireFrom('cacheable-request@7.0.4');
const CachePolicy = cacheRequire('http-cache-semantics');
const nesting = (depth, open = '{', close = '}') =>
  open.repeat(depth) + 'a,b' + close.repeat(depth);

const request = {
  url: 'https://example.invalid/account',
  method: 'GET',
  headers: { host: 'example.invalid' }
};
const staleRequest = (directive) => ({
  ...request,
  headers: { ...request.headers, 'cache-control': directive }
});
const cachePolicy = (headers, options = {}, age = 2, originalRequest = request) => {
  const policy = new CachePolicy(originalRequest, { status: 200, headers }, options);
  const received = policy.now();
  policy.now = () => received + age * 1000;
  return policy;
};

// Use the public APIs consumed by micromatch/fast-glob and cacheable-request.
// Version-based registry audits intentionally still report these patched versions.
describe('bounded braces security backport', () => {
  for (const method of ['parse', 'compile', 'expand', 'stringify']) {
    it.each([
      ['braces', '{', '}'],
      ['parentheses', '(', ')']
    ])(`${method} accepts 100 %s levels and rejects 101`, (_name, open, close) => {
      expect(() => braces[method](nesting(100, open, close))).not.toThrow();
      expect(() => braces[method](nesting(101, open, close))).toThrow(/exceeds max depth/);
      expect(() => braces[method](nesting(101, open, close), { maxDepth: 10_000 })).toThrow(
        /exceeds max depth/
      );
      expect(() => braces[method](nesting(101, open, close), { maxDepth: Infinity })).toThrow(
        /exceeds max depth/
      );
      expect(() => braces[method](nesting(2, open, close), { maxDepth: 1.5 })).toThrow(
        /exceeds max depth/
      );
    });
  }

  it.each(['compile', 'expand'])(
    'rejects the %s stack-exhaustion reproduction before walking',
    (method) => {
      // This remains below the upstream 10,000-character cap and overflowed both
      // unpatched walkers on Node 24.19.0 with its default stack size.
      const pattern = nesting(4998);
      expect(pattern).toHaveLength(9999);
      expect(() => braces[method](pattern)).toThrow(
        /Input depth \(101\), exceeds max depth \(100\)/
      );
    }
  );

  it('counts mixed parentheses and braces against one bound', () => {
    const pattern = '{('.repeat(51) + 'a,b' + ')}'.repeat(51);
    expect(() => braces.compile(pattern)).toThrow(/exceeds max depth/);
  });

  it.each(['compile', 'expand', 'stringify'])('bounds caller-supplied ASTs in %s', (method) => {
    const makeAst = (depth) => {
      const ast = { type: 'root', nodes: [] };
      let node = ast;
      for (let level = 0; level < depth; level++) {
        const child = { type: 'paren', nodes: [], parent: node };
        node.nodes.push(child);
        node = child;
      }
      node.nodes.push({ type: 'text', value: 'x', parent: node });
      return ast;
    };
    expect(() => braces[method](makeAst(100))).not.toThrow();
    expect(() => braces[method](makeAst(101))).toThrow(
      /AST depth \(101\), exceeds max depth \(100\)/
    );
    expect(() => braces[method](makeAst(2), { maxDepth: 1.5 })).toThrow(/exceeds max depth/);
    expect(() => braces[method](makeAst(101), { maxDepth: 10_000 })).toThrow(/exceeds max depth/);
  });

  it('rejects child cycles through the bounded walker', () => {
    for (const method of ['compile', 'expand', 'stringify']) {
      const ast = { type: 'root', nodes: [] };
      ast.nodes.push(ast);
      expect(() => braces[method](ast)).toThrow(/exceeds max depth/);
    }
  });

  it('rejects cyclic AST parent chains without hanging the test process', () => {
    const source = `
      const braces = require(${JSON.stringify(micromatchRequire.resolve('braces'))});
      const parent = { type: 'paren', nodes: [], queue: [] };
      parent.parent = parent;
      const ast = { type: 'paren', nodes: [], parent };
      try {
        braces.expand(ast);
        process.exitCode = 1;
      } catch (error) {
        if (!/AST parent chain contains a cycle/.test(error.message)) throw error;
        console.log(error.message);
      }
    `;
    const child = spawnSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 3000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('AST parent chain contains a cycle');
  });

  it('preserves escaped, quoted, bracketed, invalid and range behavior', () => {
    expect(braces.expand('file-{01..03}.js')).toEqual(['file-01.js', 'file-02.js', 'file-03.js']);
    expect(braces.expand('file-{1..5..2}.js')).toEqual(['file-1.js', 'file-3.js', 'file-5.js']);
    expect(braces.expand('a/{b,{c,d}}/e')).toEqual(['a/b/e', 'a/c/e', 'a/d/e']);
    expect(braces.compile('{a,b}')).toBe('(a|b)');
    expect(braces.stringify('{a,{b,c}}', { escapeInvalid: true })).toBe('{a,{b,c}}');
    for (const literal of [
      '\\{'.repeat(101),
      '"' + '{'.repeat(101) + '"',
      '[' + '{'.repeat(101) + ']'
    ]) {
      expect(() => braces.compile(literal)).not.toThrow();
    }
    expect(braces.expand('a/{b,c')).toEqual(['a/{b,c']);
    expect(() => braces.expand('{1..1001}')).toThrow(/range limit/);
  });

  it('preserves micromatch and fast-glob consumers', () => {
    expect(micromatch(['a.js', 'b.ts', 'c.txt'], '*.{js,ts}')).toEqual(['a.js', 'b.ts']);
    expect(micromatch.braceExpand('file-{01..03}.js')).toEqual([
      'file-01.js',
      'file-02.js',
      'file-03.js'
    ]);
    const fastGlob = requireFrom('fast-glob@3.3.3')('fast-glob');
    expect(
      fastGlob.sync('scripts/{brace-expansion-compat,dependency-security-patches}.test.mjs', {
        cwd: root
      })
    ).toEqual([
      'scripts/brace-expansion-compat.test.mjs',
      'scripts/dependency-security-patches.test.mjs'
    ]);
    expect(() => micromatch.braceExpand(nesting(101))).toThrow(/exceeds max depth/);
  });
});

describe('shared-cache reuse security backport', () => {
  const forbidden = [
    [
      'shared cookies',
      { 'cache-control': 'max-age=60', 'set-cookie': 'session=other-user; HttpOnly; Secure' }
    ],
    ['proxy-revalidate', { 'cache-control': 'max-age=60, proxy-revalidate' }],
    ['no-cache', { 'cache-control': 'no-cache' }],
    ['private', { 'cache-control': 'private, max-age=60' }],
    ['no-store', { 'cache-control': 'no-store, max-age=60' }],
    ['must-revalidate', { 'cache-control': 'max-age=60, must-revalidate' }]
  ];
  it.each(forbidden)('refuses %s despite numeric or unlimited max-stale', (_name, headers) => {
    for (const directive of ['max-stale=86400', 'max-stale']) {
      for (const policy of [
        cachePolicy(headers),
        CachePolicy.fromObject(cachePolicy(headers).toObject())
      ]) {
        expect(policy.satisfiesWithoutRevalidation(staleRequest(directive))).toBe(false);
        const result = policy.evaluateRequest(staleRequest(directive));
        expect(result.response).toBeUndefined();
        expect(result.revalidation.synchronous).toBe(true);
      }
    }
  });

  it.each(forbidden)(
    'refuses %s through stale-if-error and direct stale-while-revalidate',
    (_name, headers) => {
      const enhanced = {
        ...headers,
        'cache-control':
          headers['cache-control'] + ', stale-if-error=300, stale-while-revalidate=300'
      };
      for (const policy of [
        cachePolicy(enhanced),
        CachePolicy.fromObject(cachePolicy(enhanced).toObject())
      ]) {
        expect(policy.useStaleWhileRevalidate()).toBe(false);
        const result = policy.revalidatedPolicy(request, { status: 503, headers: {} });
        expect(result.policy).not.toBe(policy);
        expect(result.modified).toBe(true);
        expect(result.matches).toBe(false);
        expect(result.policy.responseHeaders()['set-cookie']).toBeUndefined();
      }
    }
  );

  it('retains legitimate stale-if-error fallback for the matching cache entry only', () => {
    const policy = cachePolicy({ 'cache-control': 'max-age=1, stale-if-error=300' });
    const response = { status: 503, headers: {} };
    const result = policy.revalidatedPolicy(request, response);
    expect(result.policy).toBe(policy);
    expect(result.modified).toBe(false);
    expect(result.matches).toBe(true);
    const mismatch = policy.revalidatedPolicy(
      { ...request, url: 'https://example.invalid/other' },
      response
    );
    expect(mismatch.policy).not.toBe(policy);
    expect(mismatch.modified).toBe(true);
  });

  it('also denies reuse when the original authenticated response is not storable', () => {
    const original = {
      ...request,
      headers: { ...request.headers, authorization: 'Bearer example' }
    };
    const policy = cachePolicy({ 'cache-control': 'max-age=60' }, {}, 2, original);
    expect(policy.storable()).toBe(false);
    expect(policy.satisfiesWithoutRevalidation(staleRequest('max-stale'))).toBe(false);
  });

  it('retains private-cache and explicit public/immutable cookie opt-ins', () => {
    const cookie = { 'cache-control': 'max-age=60', 'set-cookie': 'session=own-user' };
    expect(cachePolicy(cookie, { shared: false }).satisfiesWithoutRevalidation(request)).toBe(true);
    for (const directive of ['public, max-age=60', 'immutable, max-age=60']) {
      expect(
        cachePolicy({ ...cookie, 'cache-control': directive }).satisfiesWithoutRevalidation(request)
      ).toBe(true);
    }
    expect(
      cachePolicy(
        { 'cache-control': 'max-age=60, proxy-revalidate' },
        { shared: false }
      ).satisfiesWithoutRevalidation(request)
    ).toBe(true);
  });

  it('retains legitimate fresh, max-stale, stale-while-revalidate and conditional revalidation behavior', () => {
    expect(
      cachePolicy({ 'cache-control': 'max-age=60' }).satisfiesWithoutRevalidation(request)
    ).toBe(true);
    const stale = cachePolicy({ 'cache-control': 'max-age=1' });
    expect(stale.satisfiesWithoutRevalidation(request)).toBe(false);
    expect(stale.satisfiesWithoutRevalidation(staleRequest('max-stale=60'))).toBe(true);
    const asynchronous = cachePolicy({
      'cache-control': 'max-age=1, stale-while-revalidate=60'
    }).evaluateRequest(request);
    expect(asynchronous.response).toBeDefined();
    expect(asynchronous.revalidation.synchronous).toBe(false);
    const conditional = cachePolicy({
      'cache-control': 'no-cache',
      etag: '"example"'
    }).evaluateRequest(staleRequest('max-stale'));
    expect(conditional.response).toBeUndefined();
    expect(conditional.revalidation.headers['if-none-match']).toBe('"example"');
  });

  it('keeps Vary and request no-cache fences', () => {
    expect(
      cachePolicy({ 'cache-control': 'max-age=60', vary: '*' }).satisfiesWithoutRevalidation(
        staleRequest('max-stale')
      )
    ).toBe(false);
    expect(
      cachePolicy({ 'cache-control': 'max-age=60' }).satisfiesWithoutRevalidation(
        staleRequest('no-cache, max-stale')
      )
    ).toBe(false);
  });
});

describe('unchanged desktop download consumer', () => {
  it('retains checksum verification, got request timeout and progress through app-builder-lib', async () => {
    const builderRequire = createRequire(
      createRequire(
        createRequire(resolve(root, 'package.json')).resolve('electron-builder/package.json')
      ).resolve('app-builder-lib/package.json')
    );
    const get = builderRequire('@electron/get');
    expect(typeof get.downloadArtifact).toBe('function');
    expect(get.ElectronDownloadCacheMode.Bypass).toBe(3);
    const payload = Buffer.from('local dependency compatibility fixture');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const server = createServer((incoming, response) => {
      if (incoming.url === '/slow') return;
      response.writeHead(200, { 'content-length': String(payload.length) });
      response.end(payload);
    });
    const directory = await mkdtemp(resolve(tmpdir(), 'selene-dependency-download-'));
    const previousQuiet = process.env.ELECTRON_GET_NO_PROGRESS;
    process.env.ELECTRON_GET_NO_PROGRESS = '1';
    try {
      await new Promise((done) => server.listen(0, '127.0.0.1', done));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const progress = [];
      const options = {
        version: '9.9.9',
        platform: 'linux',
        arch: 'x64',
        artifactName: 'electron',
        cacheRoot: resolve(directory, 'cache'),
        tempDirectory: directory,
        cacheMode: get.ElectronDownloadCacheMode.Bypass,
        checksums: { 'electron-v9.9.9-linux-x64.zip': checksum },
        mirrorOptions: { resolveAssetURL: () => `${origin}/artifact` },
        downloadOptions: {
          quiet: true,
          retry: 0,
          timeout: { request: 5000 },
          getProgressCallback: (value) => {
            progress.push(value);
          }
        }
      };
      const downloaded = await get.downloadArtifact(options);
      expect(await readFile(downloaded)).toEqual(payload);
      expect(progress.some((value) => value.percent === 1)).toBe(true);
      await expect(
        get.downloadArtifact({
          ...options,
          checksums: { 'electron-v9.9.9-linux-x64.zip': '0'.repeat(64) }
        })
      ).rejects.toThrow(/checksum/i);
      await expect(
        get.downloadArtifact({
          ...options,
          mirrorOptions: { resolveAssetURL: () => `${origin}/slow` },
          downloadOptions: { quiet: true, retry: 0, timeout: { request: 100 } }
        })
      ).rejects.toThrow(/Timeout/);
    } finally {
      if (previousQuiet === undefined) delete process.env.ELECTRON_GET_NO_PROGRESS;
      else process.env.ELECTRON_GET_NO_PROGRESS = previousQuiet;
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('patch installation and advisory transparency', () => {
  it('keeps original audited identities, pinned Bun patches and the raw audit gate', async () => {
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const lock = await readFile(resolve(root, 'bun.lock'), 'utf8');
    expect(manifest.scripts['audit:dependencies']).toBe('bun audit && bun audit --production');
    for (const identifier of ['braces@3.0.3', 'http-cache-semantics@4.2.0']) {
      expect(manifest.patchedDependencies[identifier]).toBe(`patches/${identifier}.patch`);
      expect(lock).toContain(`"${identifier}": "patches/${identifier}.patch"`);
    }
    expect(micromatchRequire('braces/package.json').version).toBe('3.0.3');
    expect(cacheRequire('http-cache-semantics/package.json').version).toBe('4.2.0');
  });
});
