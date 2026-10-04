import { describe, expect, it } from 'vitest';
import { parsePrototypeGraph, prototypeGraphFixture } from '@selene/core';
import {
  acknowledgeCanvasGraphHistory,
  createCanvasGraphHistory,
  editCanvasGraphConnection,
  planCanvasGraphHistory,
  persistCanvasGraphHistory,
  reconcileCanvasGraphHistory,
  reconnectCanvasGraphConnection
} from './canvas-graph-history';

const movedGraph = parsePrototypeGraph({
  ...prototypeGraphFixture,
  nodes: prototypeGraphFixture.nodes.map((node) =>
    node.id === 'orders' ? { ...node, position: { x: 100, y: 200 } } : node
  )
});

describe('integrated canvas graph history', () => {
  it('restores exact positions through acknowledged undo and redo revisions', () => {
    const initial = createCanvasGraphHistory(prototypeGraphFixture, 10);
    const commit = planCanvasGraphHistory(initial, { kind: 'commit', graph: movedGraph });
    expect(commit?.graph.nodes.find((node) => node.id === 'orders')?.position).toEqual({
      x: 100,
      y: 200
    });
    if (commit === undefined) throw new Error('Expected graph move');
    const applied = acknowledgeCanvasGraphHistory(commit, { graph: movedGraph, revision: 11 });
    const undo = planCanvasGraphHistory(applied, { kind: 'undo' });
    if (undo === undefined) throw new Error('Expected undo');
    expect(undo.graph.nodes.find((node) => node.id === 'orders')?.position).toEqual({
      x: 80,
      y: 170
    });
    const undone = acknowledgeCanvasGraphHistory(undo, { graph: undo.graph, revision: 12 });
    const redo = planCanvasGraphHistory(undone, { kind: 'redo' });
    if (redo === undefined) throw new Error('Expected redo');
    expect(redo.graph).toEqual(movedGraph);
    expect(acknowledgeCanvasGraphHistory(redo, { graph: redo.graph, revision: 13 })).toEqual({
      graph: movedGraph,
      revision: 13,
      past: [prototypeGraphFixture],
      future: []
    });
  });

  it('does not consume history while a save rejects and clears redo after a new edit', async () => {
    const initial = createCanvasGraphHistory(prototypeGraphFixture, 0);
    const move = planCanvasGraphHistory(initial, { kind: 'commit', graph: movedGraph });
    if (move === undefined) throw new Error('Expected move');
    const applied = acknowledgeCanvasGraphHistory(move, { graph: movedGraph, revision: 1 });
    const undo = planCanvasGraphHistory(applied, { kind: 'undo' });
    if (undo === undefined) throw new Error('Expected undo');
    await expect(
      persistCanvasGraphHistory(undo, async () => {
        throw new Error('Save failed');
      })
    ).rejects.toThrow('Save failed');
    expect(applied.past).toEqual([prototypeGraphFixture]);
    expect(applied.future).toEqual([]);
    expect(planCanvasGraphHistory(applied, { kind: 'undo' })?.graph).toEqual(prototypeGraphFixture);
    const undone = acknowledgeCanvasGraphHistory(undo, { graph: undo.graph, revision: 2 });
    const changed = parsePrototypeGraph({ ...prototypeGraphFixture, name: 'Changed flow' });
    const newEdit = planCanvasGraphHistory(undone, { kind: 'commit', graph: changed });
    if (newEdit === undefined) throw new Error('Expected edit');
    expect(acknowledgeCanvasGraphHistory(newEdit, { graph: changed, revision: 3 }).future).toEqual(
      []
    );
  });

  it('fences unrelated revisions, replacement graphs and projects while ignoring old snapshots', () => {
    const initial = createCanvasGraphHistory(prototypeGraphFixture, 0);
    const move = planCanvasGraphHistory(initial, { kind: 'commit', graph: movedGraph });
    if (move === undefined) throw new Error('Expected move');
    const applied = acknowledgeCanvasGraphHistory(move, { graph: movedGraph, revision: 1 });
    expect(reconcileCanvasGraphHistory(applied, prototypeGraphFixture, 0)).toBe(applied);
    expect(reconcileCanvasGraphHistory(applied, movedGraph, 1)).toBe(applied);
    expect(reconcileCanvasGraphHistory(applied, movedGraph, 2).past).toEqual([]);
    expect(reconcileCanvasGraphHistory(applied, prototypeGraphFixture, 1).past).toEqual([]);
    const replacement = parsePrototypeGraph({ ...movedGraph, id: 'replacement' });
    expect(reconcileCanvasGraphHistory(applied, replacement, 0).graph.id).toBe('replacement');
    const project = parsePrototypeGraph({
      ...movedGraph,
      project: { projectId: 'other', owner: 'Lee' }
    });
    expect(reconcileCanvasGraphHistory(applied, project, 0).past).toEqual([]);
    expect(acknowledgeCanvasGraphHistory(move, { graph: movedGraph, revision: 3 }).past).toEqual(
      []
    );
  });
});

describe('integrated canvas connection editing', () => {
  it('preserves scenario paths and history when saving an unchanged connection', () => {
    const result = editCanvasGraphConnection(
      prototypeGraphFixture,
      {
        transitionId: 'create-order',
        sourceNodeId: 'orders',
        portId: 'create',
        kind: 'navigate',
        targetNodeId: 'new-order'
      },
      'unused'
    );
    if (result.kind !== 'ready') throw new Error(result.message);
    expect(result.graph).toBe(prototypeGraphFixture);
    expect(
      result.graph.scenarios.find((scenario) => scenario.id === 'orders-default')?.expectedPath
    ).toEqual(['orders', 'new-order']);
    expect(
      planCanvasGraphHistory(createCanvasGraphHistory(prototypeGraphFixture, 5), {
        kind: 'commit',
        graph: result.graph
      })
    ).toBeUndefined();
  });
  it('reconnects the selected edge without changing its identity or another source action', () => {
    const result = reconnectCanvasGraphConnection(prototypeGraphFixture, 'create-order', {
      source: 'orders',
      sourceHandle: 'create',
      target: 'saved'
    });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error(result.message);
    expect(result.graph.transitions.find((item) => item.id === 'create-order')).toEqual({
      id: 'create-order',
      kind: 'open-overlay',
      from: { nodeId: 'orders', portId: 'create' },
      to: { nodeId: 'saved' }
    });
    expect(result.graph.transitions.filter((item) => item.id !== 'create-order')).toEqual(
      prototypeGraphFixture.transitions.filter((item) => item.id !== 'create-order')
    );
    const collision = reconnectCanvasGraphConnection(prototypeGraphFixture, 'create-order', {
      source: 'orders',
      sourceHandle: 'filter-empty',
      target: 'orders-empty'
    });
    expect(collision).toEqual({
      kind: 'unavailable',
      message: 'That source action already has a connection. Select it to edit it.'
    });
  });

  it('edits history commands by keyboard data and rejects stale or unowned actions', () => {
    const result = editCanvasGraphConnection(
      prototypeGraphFixture,
      {
        transitionId: 'create-order',
        sourceNodeId: 'orders',
        portId: 'create',
        kind: 'back',
        targetNodeId: ''
      },
      'unused'
    );
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error(result.message);
    expect(result.graph.transitions.find((item) => item.id === 'create-order')).toEqual({
      id: 'create-order',
      kind: 'back',
      from: { nodeId: 'orders', portId: 'create' }
    });
    expect(
      editCanvasGraphConnection(
        prototypeGraphFixture,
        {
          transitionId: 'missing',
          sourceNodeId: 'orders',
          portId: 'create',
          kind: 'navigate',
          targetNodeId: 'new-order'
        },
        'unused'
      ).kind
    ).toBe('unavailable');
    expect(
      reconnectCanvasGraphConnection(prototypeGraphFixture, 'create-order', {
        source: 'new-order',
        sourceHandle: 'save',
        target: 'orders-empty'
      }).kind
    ).toBe('unavailable');
  });
});
