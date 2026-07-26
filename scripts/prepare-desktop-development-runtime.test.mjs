import { describe, expect, it, vi } from 'vitest';

import {
  desktopDevelopmentRuntimePlan,
  prepareDesktopDevelopmentRuntime
} from './prepare-desktop-development-runtime.mjs';

describe('desktop development runtime preparation', () => {
  it.each(['arm64', 'x64'])('prepares the fixed verified Bun assets on macOS %s', async (arch) => {
    const run = vi.fn(async () => undefined);
    const result = await prepareDesktopDevelopmentRuntime({ platform: 'darwin', arch, run });
    expect(result).toMatchObject({
      status: 'prepare',
      executable: process.execPath,
      arguments: expect.arrayContaining(['--arch', arch])
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(result.executable, result.arguments);
  });

  it.each(['linux', 'win32'])(
    'continues ordinary desktop authoring without macOS preparation on %s',
    async (platform) => {
      const run = vi.fn(async () => undefined);
      const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      try {
        const result = await prepareDesktopDevelopmentRuntime({
          platform,
          arch: 'x64',
          run
        });
        expect(result).toMatchObject({
          status: 'unsupported',
          message: expect.stringContaining('macOS-only')
        });
        expect(run).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledWith(expect.stringContaining('continuing'));
      } finally {
        write.mockRestore();
      }
    }
  );

  it('reports unsupported macOS architectures without attempting unsafe preparation', () => {
    expect(desktopDevelopmentRuntimePlan('darwin', 'riscv64')).toMatchObject({
      status: 'unsupported',
      message: expect.stringContaining('architecture')
    });
  });
});
