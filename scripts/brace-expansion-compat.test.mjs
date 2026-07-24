import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const requireFromBunPackage = (identifier) =>
  createRequire(resolve(root, 'node_modules', '.bun', identifier, 'node_modules', 'package.json'));

describe('brace-expansion security override compatibility', () => {
  it('keeps the fixed package callable for legacy CommonJS minimatch consumers', () => {
    const expansion = requireFromBunPackage('brace-expansion@5.0.8')('brace-expansion');
    const minimatch3 = requireFromBunPackage('minimatch@3.1.5')('minimatch');
    const minimatch5 = requireFromBunPackage('minimatch@5.1.9')('minimatch');
    const minimatch9 = requireFromBunPackage('minimatch@9.0.9')('minimatch');

    expect(typeof expansion).toBe('function');
    expect(expansion.expand).toBe(expansion);
    expect(expansion('assets/{main,preload}.{js,cjs}')).toEqual([
      'assets/main.js',
      'assets/main.cjs',
      'assets/preload.js',
      'assets/preload.cjs'
    ]);
    expect(minimatch3('assets/main.js', 'assets/*.{js,cjs}')).toBe(true);
    expect(minimatch5('assets/preload.cjs', 'assets/*.{js,cjs}')).toBe(true);
    expect(minimatch9.minimatch('assets/main.js', 'assets/*.{js,cjs}')).toBe(true);
  });

  it('keeps current glob behavior and records only the fixed brace-expansion version', async () => {
    const [glob, lockfile, manifest, compatibilityPatch] = await Promise.all([
      Promise.resolve(requireFromBunPackage('glob@13.0.6')('glob')),
      readFile(resolve(root, 'bun.lock'), 'utf8'),
      readFile(resolve(root, 'package.json'), 'utf8').then(JSON.parse),
      readFile(resolve(root, 'patches', 'brace-expansion@5.0.8.patch'), 'utf8')
    ]);

    expect(glob.globSync('scripts/*-compat.test.mjs', { cwd: root })).toContain(
      'scripts/brace-expansion-compat.test.mjs'
    );
    expect(manifest.overrides['brace-expansion']).toBe('5.0.8');
    expect(lockfile).toContain('brace-expansion@5.0.8');
    expect(lockfile).not.toContain('brace-expansion@1.1.16');
    expect(lockfile).not.toContain('brace-expansion@2.1.2');
    expect(compatibilityPatch).toContain('module.exports = callableExpand');
  });
});
