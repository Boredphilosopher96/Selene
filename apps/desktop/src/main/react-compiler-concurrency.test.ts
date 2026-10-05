import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReactSourceWorkspace } from '@selene/core';
import { BoundPreviewBuildCoordinator } from './bound-preview-build-coordinator';
import { PREVIEW_COMPILER_TIMEOUT_MS } from './preview-compile-deadline';
import { ViteReactCompilerPort } from './react-compiler';

const runtime = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('vite', () => ({ build: runtime.build }));

function workspace(revisionId = 'r1'): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId: 'bounded-compiler',
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content: 'export default function App() { return <main>Preview</main>; }'
      }
    ],
    dependencies: [],
    nodes: [{ nodeId: 'app.root', path: 'src/App.tsx', exportName: 'default' }],
    revision: { id: revisionId, createdAt: '2026-10-05T00:00:00Z', summary: 'Compiler recovery' }
  };
}

function request(revisionId = 'r1') {
  const source = workspace(revisionId);
  return {
    identity: {
      projectId: source.projectId,
      sourceRevisionId: source.revision.id,
      graphRevision: 1,
      bindingId: 'a'.repeat(64)
    },
    workspace: source
  };
}

function output(code: string) {
  return { output: [{ type: 'chunk' as const, fileName: 'preview.js', code }] };
}

describe('Vite compiler admission across abandoned builds', () => {
  afterEach(() => {
    runtime.build.mockReset();
    vi.useRealTimers();
  });

  it.each(['resolve', 'reject'] as const)(
    'bounds timeout retries until the underlying Vite build can %s, then recovers without caching late output',
    async (settlement) => {
      vi.useFakeTimers();
      const held: Array<{
        resolve: (value: ReturnType<typeof output>) => void;
        reject: (error: Error) => void;
      }> = [];
      let actualBuilds = 0;
      let maximumActualBuilds = 0;
      runtime.build.mockImplementation(async () => {
        actualBuilds += 1;
        maximumActualBuilds = Math.max(maximumActualBuilds, actualBuilds);
        try {
          return await new Promise<ReturnType<typeof output>>((resolve, reject) => {
            held.push({ resolve, reject });
          });
        } finally {
          actualBuilds -= 1;
        }
      });
      const coordinator = new BoundPreviewBuildCoordinator(new ViteReactCompilerPort());
      try {
        const first = coordinator.build(request());
        const failed = expect(first).rejects.toMatchObject({ name: 'AbortError' });
        await vi.advanceTimersByTimeAsync(PREVIEW_COMPILER_TIMEOUT_MS);
        await failed;
        expect(actualBuilds).toBe(1);
        for (let retry = 0; retry < 3; retry += 1) {
          const pending = coordinator.build(request(retry === 1 ? 'r2' : 'r1'));
          // eslint-disable-next-line no-await-in-loop -- Verify each retry settles before starting the next.
          await expect(pending).rejects.toMatchObject({
            name: 'AbortError',
            message: 'Preview compiler is still finishing a previous build. Retry shortly.'
          });
          expect(vi.getTimerCount()).toBe(0);
        }
        expect(runtime.build).toHaveBeenCalledTimes(1);
        expect(maximumActualBuilds).toBe(1);
      } finally {
        for (const build of held) {
          if (settlement === 'resolve') build.resolve(output('Abandoned output'));
          else build.reject(new Error('Late Vite failure'));
        }
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(actualBuilds).toBe(0);
      runtime.build.mockResolvedValue(output('Fresh output'));
      const fresh = await coordinator.build(request());
      expect(fresh).toMatchObject({ code: 'Fresh output', diagnostics: [] });
      expect(fresh.receipt?.sourceRevisionId).toBe('r1');
      expect(runtime.build).toHaveBeenCalledTimes(2);
      await expect(coordinator.build(request())).resolves.toBe(fresh);
      expect(runtime.build).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(['resolve', 'reject'] as const)(
    'keeps admission after direct caller cancellation until Vite can %s',
    async (settlement) => {
      vi.useFakeTimers();
      let resolve!: (value: ReturnType<typeof output>) => void;
      let reject!: (error: Error) => void;
      const held = new Promise<ReturnType<typeof output>>((accept, fail) => {
        resolve = accept;
        reject = fail;
      });
      let actualBuilds = 0;
      let maximumActualBuilds = 0;
      runtime.build.mockImplementation(async () => {
        actualBuilds += 1;
        maximumActualBuilds = Math.max(maximumActualBuilds, actualBuilds);
        try {
          return await held;
        } finally {
          actualBuilds -= 1;
        }
      });
      const compiler = new ViteReactCompilerPort();
      const caller = new AbortController();
      const first = compiler.compile(workspace(), caller.signal);
      const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.build).toHaveBeenCalledOnce();
      expect(actualBuilds).toBe(1);
      caller.abort();
      await cancelled;
      await Promise.all(
        Array.from({ length: 10 }, (_, retry) =>
          expect(compiler.compile(workspace(`r${retry + 2}`))).rejects.toThrow(
            'still finishing a previous build'
          )
        )
      );
      expect(runtime.build).toHaveBeenCalledOnce();
      expect(actualBuilds).toBe(1);
      expect(maximumActualBuilds).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      if (settlement === 'resolve') resolve(output('Cancelled output'));
      else reject(new Error('Cancelled Vite failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(actualBuilds).toBe(0);
      runtime.build.mockResolvedValue(output('After cancellation'));
      await expect(compiler.compile(workspace('fresh'))).resolves.toMatchObject({
        revisionId: 'fresh',
        code: 'After cancellation',
        diagnostics: []
      });
      expect(runtime.build).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('reserves admission synchronously before the lazy runtime boundary', async () => {
    runtime.build.mockResolvedValue(output('Accepted output'));
    const compiler = new ViteReactCompilerPort();
    const first = compiler.compile(workspace());
    const second = compiler.compile(workspace('r2'));
    await expect(second).rejects.toThrow('still finishing a previous build');
    await expect(first).resolves.toMatchObject({ code: 'Accepted output', diagnostics: [] });
    expect(runtime.build).toHaveBeenCalledOnce();
  });

  it('does not reserve admission for an already-aborted caller or invalid source', async () => {
    const compiler = new ViteReactCompilerPort();
    const caller = new AbortController();
    caller.abort();
    await expect(compiler.compile(workspace(), caller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
    await expect(
      compiler.compile({ ...workspace(), entrypoint: '../outside.tsx' })
    ).rejects.toThrow();
    expect(runtime.build).not.toHaveBeenCalled();
    runtime.build.mockResolvedValue(output('Fresh admission'));
    await expect(compiler.compile(workspace())).resolves.toMatchObject({
      code: 'Fresh admission',
      diagnostics: []
    });
    expect(runtime.build).toHaveBeenCalledOnce();
  });

  it('releases admission after an ordinary synchronous Vite failure and preserves plain-text diagnostics', async () => {
    const compiler = new ViteReactCompilerPort();
    runtime.build.mockImplementationOnce(() => {
      throw new Error('\u001B[31mVite failure\u001B[0m');
    });
    const failed = await compiler.compile(workspace());
    expect(failed).toMatchObject({ code: '', diagnostics: [{ message: 'Vite failure' }] });
    expect(failed.receipt).toBeUndefined();
    runtime.build.mockResolvedValue(output('After failure'));
    await expect(compiler.compile(workspace())).resolves.toMatchObject({
      code: 'After failure',
      diagnostics: []
    });
    expect(runtime.build).toHaveBeenCalledTimes(2);
  });
});
