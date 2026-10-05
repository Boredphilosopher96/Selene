import { describe, expect, it, vi } from 'vitest';

import type { ReactSourceWorkspace } from '@selene/core';
import { ViteReactCompilerPort } from './react-compiler';

const runtime = vi.hoisted(() => {
  let finishLoading!: () => void;
  const loading = new Promise<void>((resolve) => {
    finishLoading = resolve;
  });
  return { loading, finishLoading, build: vi.fn() };
});
vi.mock('vite', async () => {
  await runtime.loading;
  return { build: runtime.build };
});

describe('Vite compiler admission during lazy runtime loading', () => {
  it('holds admission after abort until loading settles, skips the cancelled build, and recovers', async () => {
    vi.useFakeTimers();
    const source: ReactSourceWorkspace = {
      format: 'selene-react-workspace/v1',
      projectId: 'cancel-held-runtime-load',
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
      revision: { id: 'r1', createdAt: '2026-10-05T00:00:00Z', summary: 'Cancelled loading' }
    };
    const compiler = new ViteReactCompilerPort();
    const caller = new AbortController();
    try {
      const first = compiler.compile(source, caller.signal);
      const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      caller.abort();
      await cancelled;
      await Promise.all(
        Array.from({ length: 3 }, () =>
          expect(compiler.compile(source)).rejects.toThrow('still finishing a previous build')
        )
      );
      expect(runtime.build).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      runtime.finishLoading();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.build).not.toHaveBeenCalled();
      runtime.build.mockResolvedValue({
        output: [{ type: 'chunk', fileName: 'preview.js', code: 'After loading' }]
      });
      await expect(compiler.compile(source)).resolves.toMatchObject({
        code: 'After loading',
        diagnostics: []
      });
      expect(runtime.build).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      runtime.finishLoading();
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
    }
  });
});
