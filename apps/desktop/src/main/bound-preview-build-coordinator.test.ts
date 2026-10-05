import {
  type ReactBuildArtifact,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';
import { describe, expect, it, vi } from 'vitest';

import {
  BoundPreviewBuildCoordinator,
  DEFAULT_BOUND_PREVIEW_COMPILE_TIMEOUT_MS,
  type BoundPreviewBuildRequest
} from './bound-preview-build-coordinator';

function workspace(projectId = 'project-a', revisionId = 'revision-a'): ReactSourceWorkspace {
  return {
    format: 'selene-react-workspace/v1',
    projectId,
    entrypoint: 'src/App.tsx',
    files: [
      {
        path: 'src/App.tsx',
        language: 'tsx',
        content:
          'export default function App(){return <main data-selene-node-id="app.root">Preview</main>}'
      }
    ],
    dependencies: [],
    nodes: [{ nodeId: 'app.root', path: 'src/App.tsx', exportName: 'default' }],
    revision: {
      id: revisionId,
      createdAt: '2026-07-27T00:00:00.000Z',
      summary: 'Coordinator fixture'
    }
  };
}

function request(
  source = workspace(),
  overrides: Partial<BoundPreviewBuildRequest['identity']> = {}
): BoundPreviewBuildRequest {
  return {
    identity: {
      projectId: source.projectId,
      sourceRevisionId: source.revision.id,
      graphRevision: 4,
      bindingId: 'a'.repeat(64),
      ...overrides
    },
    workspace: source
  };
}

function artifact(revisionId: string): ReactBuildArtifact {
  return { revisionId, code: `compiled:${revisionId}`, diagnostics: [] };
}

describe('BoundPreviewBuildCoordinator', () => {
  it.each(['resolve', 'reject'] as const)(
    'bounds a noncooperative compiler and consumes its late %s without retaining stale output',
    async (settlement) => {
      vi.useFakeTimers();
      try {
        let resolve!: (value: ReactBuildArtifact) => void;
        let reject!: (error: unknown) => void;
        let signal: AbortSignal | undefined;
        let attempts = 0;
        const compiler: ReactCompilerPort = {
          compile: (source, currentSignal) => {
            attempts += 1;
            signal = currentSignal;
            if (attempts > 1)
              return Promise.resolve({ ...artifact(source.revision.id), code: 'fresh output' });
            return new Promise<ReactBuildArtifact>((accept, fail) => {
              resolve = accept;
              reject = fail;
            });
          }
        };
        const coordinator = new BoundPreviewBuildCoordinator(compiler);
        const first = coordinator.build(request());
        const failed = expect(first).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(DEFAULT_BOUND_PREVIEW_COMPILE_TIMEOUT_MS);
        await failed;
        expect(signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        if (settlement === 'resolve')
          resolve({ ...artifact('revision-a'), code: 'abandoned output' });
        else reject(new Error('late compiler failure'));
        await Promise.resolve();
        await Promise.resolve();

        await expect(coordinator.build(request())).resolves.toMatchObject({ code: 'fresh output' });
        await expect(coordinator.build(request())).resolves.toMatchObject({ code: 'fresh output' });
        expect(attempts).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('does not retain a completed artifact after its host lease is no longer active', async () => {
    let active = true;
    let attempts = 0;
    const compiler: ReactCompilerPort = {
      compile: async (source) => {
        attempts += 1;
        active = false;
        return artifact(source.revision.id);
      }
    };
    const coordinator = new BoundPreviewBuildCoordinator(compiler);
    const guarded = {
      ...request(),
      assertActive: () => {
        if (!active) throw new Error('Lease expired before retention');
      }
    };
    await expect(coordinator.build(guarded)).rejects.toThrow(/expired before retention/);
    await coordinator.build(request());
    expect(attempts).toBe(2);
  });

  it('bounds shared never-settling work for every waiter and cleans its timer on clear', async () => {
    vi.useFakeTimers();
    try {
      const compiler: ReactCompilerPort = {
        compile: () => new Promise<ReactBuildArtifact>(() => undefined)
      };
      const coordinator = new BoundPreviewBuildCoordinator(compiler);
      const first = coordinator.build(request());
      const second = coordinator.build(request());
      const failed = expect(Promise.all([first, second])).rejects.toMatchObject({
        name: 'AbortError'
      });
      coordinator.clear();
      await failed;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a deadline that would relax the host compile budget', () => {
    const compiler: ReactCompilerPort = { compile: async (source) => artifact(source.revision.id) };
    expect(
      () =>
        new BoundPreviewBuildCoordinator(compiler, {
          compileTimeoutMs: DEFAULT_BOUND_PREVIEW_COMPILE_TIMEOUT_MS + 1
        })
    ).toThrow(/timeout/);
  });

  it('coalesces concurrent callers for one exact identity', async () => {
    let release: ((value: ReactBuildArtifact) => void) | undefined;
    let compilations = 0;
    const compiler: ReactCompilerPort = {
      compile: () => {
        compilations += 1;
        return new Promise<ReactBuildArtifact>((resolve) => {
          release = resolve;
        });
      }
    };
    const coordinator = new BoundPreviewBuildCoordinator(compiler);
    const first = coordinator.build(request());
    const second = coordinator.build(request());

    expect(compilations).toBe(1);
    release?.(artifact('revision-a'));
    await expect(Promise.all([first, second])).resolves.toEqual([
      artifact('revision-a'),
      artifact('revision-a')
    ]);
  });

  it('never reuses a successful artifact across projects or revisions', async () => {
    let compilations = 0;
    const compiler: ReactCompilerPort = {
      compile: async (source) => {
        compilations += 1;
        if (source.projectId === 'project-b') throw new Error('project-b failed');
        return artifact(source.revision.id);
      }
    };
    const coordinator = new BoundPreviewBuildCoordinator(compiler);

    await expect(coordinator.build(request())).resolves.toEqual(artifact('revision-a'));
    await expect(coordinator.build(request(workspace('project-b', 'revision-b')))).rejects.toThrow(
      'project-b failed'
    );
    expect(compilations).toBe(2);
  });

  it('includes binding and workspace commitments in the cache key', async () => {
    let compilations = 0;
    const compiler: ReactCompilerPort = {
      compile: async (source) => {
        compilations += 1;
        return artifact(source.revision.id);
      }
    };
    const coordinator = new BoundPreviewBuildCoordinator(compiler);
    const first = request();
    const changedBinding = request(first.workspace, { bindingId: 'b'.repeat(64) });
    const changedWorkspace = request({
      ...first.workspace,
      files: first.workspace.files.map((file) => ({ ...file, content: `${file.content}\n` }))
    });

    await coordinator.build(first);
    await coordinator.build(changedBinding);
    await coordinator.build(changedWorkspace);
    expect(compilations).toBe(3);
  });

  it('lets the host compiler authorize declared governed dependencies', async () => {
    const governed = {
      ...workspace(),
      dependencies: ['@acme/design-system']
    };
    let compiledDependencies: readonly string[] | undefined;
    const compiler: ReactCompilerPort = {
      compile: async (source) => {
        compiledDependencies = source.dependencies;
        return artifact(source.revision.id);
      }
    };

    await expect(
      new BoundPreviewBuildCoordinator(compiler).build(request(governed))
    ).resolves.toEqual(artifact('revision-a'));
    expect(compiledDependencies).toEqual(['@acme/design-system']);
  });

  it('rejects mismatched identity before invoking the compiler', async () => {
    let compilations = 0;
    const compiler: ReactCompilerPort = {
      compile: async (source) => {
        compilations += 1;
        return artifact(source.revision.id);
      }
    };
    const coordinator = new BoundPreviewBuildCoordinator(compiler);

    await expect(
      coordinator.build(request(workspace(), { projectId: 'different-project' }))
    ).rejects.toThrow('does not match');
    expect(compilations).toBe(0);
  });

  it('does not cancel shared compilation while another caller is waiting', async () => {
    let release: ((value: ReactBuildArtifact) => void) | undefined;
    let compilerSignal: AbortSignal | undefined;
    const compiler: ReactCompilerPort = {
      compile: (_source, signal) => {
        compilerSignal = signal;
        return new Promise<ReactBuildArtifact>((resolve) => {
          release = resolve;
        });
      }
    };
    const coordinator = new BoundPreviewBuildCoordinator(compiler);
    const controller = new AbortController();
    const cancelled = coordinator.build(request(), controller.signal);
    const retained = coordinator.build(request());

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(compilerSignal?.aborted).toBe(false);
    release?.(artifact('revision-a'));
    await expect(retained).resolves.toEqual(artifact('revision-a'));
  });
});
