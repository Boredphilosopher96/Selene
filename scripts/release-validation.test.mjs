import { expect, describe, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { evaluateSigningGate } from './release-signing-gate.mjs';
import { validateReleaseReference } from './verify-release-reference.mjs';
import { desktopSmokeArguments } from './desktop-smoke-arguments.mjs';

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
    const [workflow, ciWorkflow, desktopE2e, accessibilityE2e, keyringHarness] = await Promise.all([
      readFile(new URL('../.github/workflows/release-preparation.yml', import.meta.url), 'utf8'),
      readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
      readFile(new URL('../apps/desktop/e2e/prototype.spec.ts', import.meta.url), 'utf8'),
      readFile(new URL('../apps/a11y/accessibility.spec.ts', import.meta.url), 'utf8'),
      readFile(new URL('./run-linux-desktop-e2e-with-keyring.sh', import.meta.url), 'utf8')
    ]);
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
    expect(workflow).toContain('Install isolated Linux Secret Service harness');
    expect(workflow).toContain(
      'bash scripts/run-linux-desktop-e2e-with-keyring.sh -- bun run test:a11y'
    );
    expect(workflow).toContain(
      'bash scripts/run-linux-desktop-e2e-with-keyring.sh -- bun run --cwd apps/desktop test:e2e'
    );
    expect(workflow).toContain('gnome-keyring');
    expect(workflow).toContain('libglib2.0-bin');
    expect(ciWorkflow).toContain(
      'run: bash scripts/run-linux-desktop-e2e-with-keyring.sh -- bun run test:a11y'
    );
    expect(ciWorkflow).toContain(
      'run: bash scripts/run-linux-desktop-e2e-with-keyring.sh -- bun run --cwd apps/desktop test:e2e'
    );
    expect(ciWorkflow).toContain('gnome-keyring libglib2.0-bin');
    expect(
      ciWorkflow.match(
        /run: bash scripts\/run-linux-desktop-e2e-with-keyring\.sh -- bun run test:a11y/g
      )
    ).toHaveLength(1);
    expect(desktopE2e).toContain('encryptionAvailable: safeStorage.isEncryptionAvailable()');
    expect(desktopE2e).toContain("backend: 'gnome_libsecret'");
    expect(desktopE2e).toContain("'--password-store=gnome-libsecret'");
    expect(desktopE2e).toContain(
      "process.platform === 'linux' && process.env.CI === 'true' ? ['--no-sandbox'] : []"
    );
    expect(accessibilityE2e).toContain("'--password-store=gnome-libsecret'");
    expect(keyringHarness.match(/gnome-keyring-daemon \\\n/g)).toHaveLength(1);
    expect(keyringHarness).toContain('gnome-keyring-daemon \\\n      --foreground');
    expect(keyringHarness).toContain('--components=secrets \\\n      --unlock');
    expect(keyringHarness).toContain('GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring-control"');
    expect(keyringHarness).toContain('--control-directory "$GNOME_KEYRING_CONTROL"');
    expect(keyringHarness).toContain('org.freedesktop.secrets');
    expect(keyringHarness).toContain('org.freedesktop.DBus.NameHasOwner');
    expect(keyringHarness).not.toContain('gdbus introspect');
    expect(keyringHarness).not.toContain('eval "$(gnome-keyring-daemon');
  });
});

describe('desktop launch smoke sandbox contract', () => {
  it('allows --no-sandbox only for an explicitly opted-in Linux CI smoke', () => {
    expect(
      desktopSmokeArguments({
        executable: '/opt/Selene/selene',
        platform: 'linux',
        environment: { CI: 'true', SELENE_DESKTOP_SMOKE_NO_SANDBOX: 'true' }
      })
    ).toEqual(['/opt/Selene/selene', '--smoke-test', '--no-sandbox']);

    for (const [platform, environment] of [
      ['linux', { CI: 'true' }],
      ['linux', { SELENE_DESKTOP_SMOKE_NO_SANDBOX: 'true' }],
      ['macos', { CI: 'true', SELENE_DESKTOP_SMOKE_NO_SANDBOX: 'true' }],
      ['windows', { CI: 'true', SELENE_DESKTOP_SMOKE_NO_SANDBOX: 'true' }]
    ]) {
      expect(desktopSmokeArguments({ executable: 'Selene', platform, environment })).toEqual([
        'Selene',
        '--smoke-test'
      ]);
    }
  });

  it('keeps the CI bypass explicit in both unsigned and protected packaging steps', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/release-preparation.yml', import.meta.url),
      'utf8'
    );
    expect(workflow.match(/SELENE_DESKTOP_SMOKE_NO_SANDBOX:/g)).toHaveLength(2);
    expect(workflow).toContain("matrix.platform == 'linux'");
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

  it('documents deterministic root SBOM defaults and preserves exact-one archive discovery', async () => {
    const [source, releases] = await Promise.all([
      readFile(new URL('./generate-sbom.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../docs/RELEASES.md', import.meta.url), 'utf8')
    ]);
    expect(source).toContain(
      "const hostPlatform = { darwin: 'macos', linux: 'linux', win32: 'windows' }"
    );
    expect(source).toContain("const hostArch = { x64: 'x64', arm64: 'arm64' }");
    expect(source).toContain('const electronVersion = desktopManifest.devDependencies?.electron');
    expect(source).toContain(
      "optionValue('--output') ??\n  `artifacts/release-assets/${platform}-${arch}/${assetPrefix}.sbom.cdx.json`"
    );
    expect(source).toContain('Expected exactly one packaged app.asar');
    expect(releases).toContain('bun run sbom');
    expect(releases).toContain('artifacts/desktop-build/<platform>-<arch>/');
    expect(releases).toContain('exactly one `resources/app.asar`');
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
