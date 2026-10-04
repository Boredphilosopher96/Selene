import type { PrototypeGraph } from '@selene/core';

import {
  PrototypeGraphConflictError,
  type PrototypeGraphPersistencePort,
  type PersistedPrototypeGraph
} from './designer-host-ports';
import {
  ProjectLifecycleError,
  type LocalDesignerState,
  type LocalProjectLifecycleService
} from './project-lifecycle';

/** Legacy files are read for migration; project records own all subsequent writes. */
export class LifecyclePrototypeGraphPersistencePort implements PrototypeGraphPersistencePort {
  public readonly commitsDesignerState = true;

  public constructor(
    private readonly lifecycle: LocalProjectLifecycleService,
    private readonly legacy: PrototypeGraphPersistencePort
  ) {}

  public async read(projectId: string): Promise<PersistedPrototypeGraph | undefined> {
    try {
      const graph = (await this.lifecycle.designerState(projectId))?.prototypeGraph;
      if (graph !== undefined) return graph;
    } catch (error) {
      if (!(error instanceof ProjectLifecycleError) || error.code !== 'NOT_FOUND') throw error;
    }
    return this.legacy.read(projectId);
  }

  public async compareAndSwap(
    projectId: string,
    expectedRevision: number,
    graph: PrototypeGraph,
    state?: LocalDesignerState
  ): Promise<PersistedPrototypeGraph> {
    if (state === undefined) throw new Error('Flow save requires its canonical review state.');
    const current = await this.read(projectId);
    if ((current?.revision ?? 0) !== expectedRevision) throw new PrototypeGraphConflictError();
    try {
      return await this.lifecycle.commitPrototypeGraph({
        projectId,
        expectedRevision,
        legacyRevision: current?.revision ?? 0,
        graph,
        state
      });
    } catch (error) {
      if (error instanceof ProjectLifecycleError && error.code === 'GRAPH_CONFLICT')
        throw new PrototypeGraphConflictError();
      // The launchpad's uncreated sample has no review baseline or project record.
      if (
        error instanceof ProjectLifecycleError &&
        error.code === 'NOT_FOUND' &&
        state.baseline.baseline === undefined
      )
        return this.legacy.compareAndSwap(projectId, expectedRevision, graph);
      throw error;
    }
  }

  public async recoverFromFixture(
    projectId: string,
    graph: PrototypeGraph,
    state?: LocalDesignerState
  ) {
    if (state === undefined) throw new Error('Flow recovery requires its canonical review state.');
    return this.legacy.recoverFromFixture(projectId, graph, undefined, async () => {
      try {
        const current = (await this.lifecycle.designerState(projectId))?.prototypeGraph;
        return await this.lifecycle.commitPrototypeGraph({
          projectId,
          expectedRevision: current?.revision ?? 0,
          legacyRevision: 0,
          graph,
          state
        });
      } catch (error) {
        if (
          error instanceof ProjectLifecycleError &&
          error.code === 'NOT_FOUND' &&
          state.baseline.baseline === undefined
        )
          return undefined;
        throw error;
      }
    });
  }
}
