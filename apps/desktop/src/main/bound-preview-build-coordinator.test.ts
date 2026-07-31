import {
  type ReactBuildArtifact,
  type ReactCompilerPort,
  type ReactSourceWorkspace
} from '@selene/core';
import { describe, expect, it } from 'vitest';

import {
  BoundPreviewBuildCoordinator,
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
