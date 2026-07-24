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
  it('keeps verified Linux artifacts alongside signed macOS and Windows artifacts', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/release-preparation.yml', import.meta.url),
      'utf8'
    );
    expect(workflow).toContain('pattern: Selene-signed-desktop-*');
    expect(workflow).toContain('pattern: Selene-desktop-linux-x64-*');
  });
});
