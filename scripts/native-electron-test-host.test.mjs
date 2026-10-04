import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { assertNativeElectronTestAllowed } from './playwright-harness.mjs';

describe('native Electron test host', () => {
  it.each([{}, { CI: 'false' }, { SELENE_ALLOW_FOREGROUND_ELECTRON_TESTS: '1' }])(
    'refuses local macOS foreground launches with %j',
    (environment) => {
      expect(() => assertNativeElectronTestAllowed({ platform: 'darwin', environment })).toThrow(
        'Run these graphical tests in CI.'
      );
    }
  );

  it.each([{ CI: 'true' }, { CI: '1' }, { SELENE_ALLOW_FOREGROUND_ELECTRON_TESTS: 'true' }])(
    'allows macOS CI or the documented foreground opt-in with %j',
    (environment) => {
      expect(() =>
        assertNativeElectronTestAllowed({ platform: 'darwin', environment })
      ).not.toThrow();
    }
  );

  it.each(['linux', 'win32'])('preserves existing %s test-host behavior', (platform) => {
    expect(() => assertNativeElectronTestAllowed({ platform, environment: {} })).not.toThrow();
  });

  it('exits before the launch boundary in a real non-GUI child process', () => {
    const harness = new URL('./playwright-harness.mjs', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { assertNativeElectronTestAllowed } from ${JSON.stringify(harness)};
assertNativeElectronTestAllowed({ platform: 'darwin', environment: {} });
process.stdout.write('FOREGROUND_LAUNCH_REACHED');`
      ],
      { encoding: 'utf8', timeout: 5_000 }
    );
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stdout).not.toContain('FOREGROUND_LAUNCH_REACHED');
    expect(child.stderr).toContain('Foreground Electron tests are disabled on local macOS');
    expect(child.stderr).toContain('Test listing and --smoke-test remain available.');
  });
});
