import { expect, describe, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { evaluateSigningGate } from './release-signing-gate.mjs';
import { validateReleaseReference } from './verify-release-reference.mjs';

const sha = 'a'.repeat(40);

describe('release reference validation', () => {
  it('requires a tag matching the single product version and its exact commit', () => {
    expect(
      validateReleaseReference({
        tag: 'v0.1.0-alpha.0',
        sha,
        version: '0.1.0-alpha.0',
        resolveCommit: () => sha
      })
    ).toEqual({ tag: 'v0.1.0-alpha.0', sha, version: '0.1.0-alpha.0' });
  });

  it('rejects a product-version mismatch and a tag at another commit', () => {
    expect(() =>
      validateReleaseReference({
        tag: 'v0.1.0',
        sha,
        version: '0.1.0-alpha.0',
        resolveCommit: () => sha
      })
    ).toThrow('does not match product version');
    expect(() =>
      validateReleaseReference({
        tag: 'v0.1.0-alpha.0',
        sha,
        version: '0.1.0-alpha.0',
        resolveCommit: (reference) => (reference === sha ? sha : 'b'.repeat(40))
      })
    ).toThrow('not requested SHA');
  });
});

describe('protected signing gate', () => {
  it('does nothing without approval or complete credentials', () => {
    expect(evaluateSigningGate('macos', {})).toMatchObject({ enabled: false });
    expect(evaluateSigningGate('linux', { SELENE_SIGNING_APPROVED: 'true' })).toMatchObject({
      enabled: false
    });
  });

  it('requires API-key material before enabling macOS built-in notarization', () => {
    expect(
      evaluateSigningGate('macos', {
        SELENE_SIGNING_APPROVED: 'true',
        CSC_LINK: 'certificate',
        APPLE_API_KEY_CONTENT: 'key material',
        APPLE_API_KEY_ID: 'key-id',
        APPLE_API_ISSUER: 'issuer'
      })
    ).toMatchObject({ enabled: true });
  });
});

describe('signed release artifact selection', () => {
  it('uses bounded staged assets and keeps verified Linux alongside signed macOS and Windows', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/release-preparation.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('pattern: Selene-signed-desktop-*');
    expect(workflow).toContain('pattern: Selene-desktop-linux-x64-*');
    expect(workflow).toContain(
      'path: artifacts/release-assets/${{ matrix.platform }}-${{ matrix.arch }}'
    );
    expect(workflow).toContain(
      'subject-path: artifacts/release-assets/${{ matrix.platform }}-${{ matrix.arch }}/*'
    );
    expect(workflow).toContain('release_assets=(release-assets/*)');
    expect(workflow).not.toContain('find release-assets -type f');
    expect(workflow).not.toContain('xargs');
  });
});

describe('exact-SHA release preflight', () => {
  it('runs the current CI contract before desktop artifact jobs', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/release-preparation.yml', import.meta.url),
      'utf8'
    );
    for (const command of [
      'bun run format',
      'bun run lint',
      'bun run test',
      'bun run typecheck',
      'bun run build',
      'bun run build-storybook',
      'bun run check:emitted-size',
      'bunx playwright install --with-deps chromium',
      'bun run test:e2e',
      'bun run test:startup',
      'bun run test:a11y',
      'bun run release:dry-run'
    ]) {
      expect(workflow).toContain(command);
    }
  });
});

describe('runtime SBOM workflow contract', () => {
  it('builds a desktop artifact before publishing SBOM provenance', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/security.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('bun run desktop:package -- --platform linux --arch x64');
    expect(workflow).toContain('artifacts/release-assets/linux-x64/*.sbom.cdx.json');
    expect(workflow).not.toContain('run: bun run sbom');
  });

  it('keeps Linux package metadata complete on clean hosted runners', async () => {
    const [desktopManifest, builderConfig] = await Promise.all([
      readFile(new URL('../apps/desktop/package.json', import.meta.url), 'utf8').then(JSON.parse),
      readFile(new URL('../apps/desktop/electron-builder.config.mjs', import.meta.url), 'utf8')
    ]);
    expect(desktopManifest.homepage).toMatch(/^https:\/\//);
    expect(desktopManifest.author.email).toMatch(/@/);
    expect(desktopManifest.desktopName).toBe('Selene');
    expect(builderConfig).toContain('maintainer:');
    expect(builderConfig).toContain('syncDesktopName: true');
  });
});
