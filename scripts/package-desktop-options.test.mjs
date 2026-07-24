import { describe, expect, it } from 'vitest';

import { parseDesktopPackageOptions } from './package-desktop-options.mjs';

describe('parseDesktopPackageOptions', () => {
  it('uses a universal macOS package by default', () => {
    expect(parseDesktopPackageOptions([], 'darwin')).toEqual({
      platform: 'macos',
      arch: 'universal',
      dryRun: false,
      smoke: false
    });
  });

  it('keeps the supported Linux and Windows release matrix at x64', () => {
    expect(parseDesktopPackageOptions([], 'linux')).toMatchObject({
      platform: 'linux',
      arch: 'x64'
    });
    expect(parseDesktopPackageOptions([], 'win32')).toMatchObject({
      platform: 'windows',
      arch: 'x64'
    });
  });

  it('accepts explicit macOS architecture choices and dry-run smoke mode', () => {
    expect(
      parseDesktopPackageOptions(['--platform', 'macos', '--arch', 'arm64', '--dry-run'], 'linux')
    ).toEqual({ platform: 'macos', arch: 'arm64', dryRun: true, smoke: true });
  });

  it('rejects unsupported platforms and architecture combinations', () => {
    expect(() => parseDesktopPackageOptions(['--platform', 'freebsd'], 'linux')).toThrow(
      'Unsupported desktop platform freebsd'
    );
    expect(() =>
      parseDesktopPackageOptions(['--platform', 'linux', '--arch', 'arm64'], 'linux')
    ).toThrow('Unsupported linux architecture arm64');
  });
});
