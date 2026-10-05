import { describe, expect, it, vi } from 'vitest';

import {
  PREVIEW_COMPILER_TIMEOUT_MS,
  runPreviewCompileWithDeadline
} from './preview-compile-deadline';

describe('Vite compiler adapter deadline', () => {
  it.each(['resolve', 'reject'] as const)(
    'releases a never-settling operation and consumes its late %s',
    async (settlement) => {
      vi.useFakeTimers();
      try {
        let resolve!: (value: string) => void;
        let reject!: (error: unknown) => void;
        let buildSignal: AbortSignal | undefined;
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, 'removeEventListener');
        const pending = runPreviewCompileWithDeadline((signal) => {
          buildSignal = signal;
          return new Promise<string>((accept, fail) => {
            resolve = accept;
            reject = fail;
          });
        }, caller.signal);
        const failed = expect(pending).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(PREVIEW_COMPILER_TIMEOUT_MS);
        await failed;
        expect(buildSignal?.aborted).toBe(true);
        expect(remove).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        if (settlement === 'resolve') resolve('abandoned output');
        else reject(new Error('abandoned error'));
        await Promise.resolve();
        await expect(runPreviewCompileWithDeadline(async () => 'fresh output')).resolves.toBe(
          'fresh output'
        );
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('cancels an uncooperative operation immediately and avoids calling a pre-aborted one', async () => {
    const caller = new AbortController();
    const pending = runPreviewCompileWithDeadline(
      () => new Promise<string>(() => undefined),
      caller.signal
    );
    const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();
    await failed;
    const operation = vi.fn(async () => 'unreachable');
    await expect(runPreviewCompileWithDeadline(operation, caller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('cleans timers and listeners after ordinary success and synchronous failure', async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, 'removeEventListener');
      await expect(
        runPreviewCompileWithDeadline(async () => 'output', caller.signal)
      ).resolves.toBe('output');
      await expect(
        runPreviewCompileWithDeadline(() => {
          throw new Error('failed import');
        }, caller.signal)
      ).rejects.toThrow('failed import');
      expect(remove).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
