import { describe, expect, it } from 'vitest';

import {
  createPrototypeRuntime,
  copyPrototypeNodes,
  diffPrototypeGraphs,
  exportPrototypeGraph,
  exportPrototypeHandoff,
  importPrototypeGraph,
  importPrototypeHandoff,
  parsePrototypeRuntimeSnapshot,
  pastePrototypeNodes,
  parsePrototypeGraph,
  prototypeGraphFixture,
  PrototypeGraphValidationError,
  PrototypeRuntime,
  PrototypeRuntimeError,
  schedulePrototypeTimeouts,
  upsertPrototypeTransition
} from './prototype-graph';

describe('PrototypeGraph contract', () => {
  it('deeply validates public graph input and rejects external routes and dangling wires', () => {
    expect(() =>
      parsePrototypeGraph({
        ...prototypeGraphFixture,
        nodes: [{ ...prototypeGraphFixture.nodes[0], route: 'https://evil.example' }]
      })
    ).toThrow(PrototypeGraphValidationError);
    expect(() =>
      parsePrototypeGraph({
        ...prototypeGraphFixture,
        transitions: [{ ...prototypeGraphFixture.transitions[0], to: { nodeId: 'missing' } }]
      })
    ).toThrow(/target node does not exist/);
    expect(() => parsePrototypeGraph({ ...prototypeGraphFixture, unexpected: true })).toThrow(
      PrototypeGraphValidationError
    );
    expect(() =>
      parsePrototypeGraph({
        ...prototypeGraphFixture,
        transitions: prototypeGraphFixture.transitions.map((transition) =>
          transition.kind === 'back' ? { ...transition, to: { nodeId: 'orders' } } : transition
        )
      })
    ).toThrow(PrototypeGraphValidationError);
    expect(() =>
      parsePrototypeGraph({
        ...prototypeGraphFixture,
        nodes: prototypeGraphFixture.nodes.map((node) =>
          node.id === 'new-order' && node.kind === 'page' ? { ...node, route: '/orders' } : node
        )
      })
    ).toThrow(/routes must be unique/);
    expect(() =>
      parsePrototypeGraph({
        ...prototypeGraphFixture,
        transitions: prototypeGraphFixture.transitions.map((transition) =>
          transition.id === 'filter-empty'
            ? {
                ...transition,
                to: { nodeId: 'orders-empty' },
                from: { nodeId: 'new-order', portId: 'save' }
              }
            : transition
        )
      })
    ).toThrow(/owned by its source/);
    expect(() =>
      parsePrototypeGraph({
        ...prototypeGraphFixture,
        transitions: [
          ...prototypeGraphFixture.transitions,
          {
            id: 'duplicate-action',
            kind: 'navigate',
            from: { nodeId: 'orders', portId: 'create' },
            to: { nodeId: 'new-order' }
          }
        ]
      })
    ).toThrow(/only one transition/);
  });

  it('runs navigation, state, overlay, and history deterministically without a browser or backend', () => {
    const runtime = createPrototypeRuntime(prototypeGraphFixture);
    expect(runtime.snapshot()).toMatchObject({
      activeNodeId: 'orders',
      history: ['orders'],
      fixtures: prototypeGraphFixture.fixtures
    });
    expect(
      runtime.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'create' }).activeNodeId
    ).toBe('new-order');
    expect(
      runtime.dispatch({ type: 'trigger', nodeId: 'new-order', portId: 'save' }).activeOverlayId
    ).toBe('saved');
    expect(
      runtime.dispatch({ type: 'trigger', nodeId: 'saved', portId: 'dismiss' }).activeOverlayId
    ).toBeUndefined();
    expect(runtime.dispatch({ type: 'back' }).activeNodeId).toBe('orders');
    expect(
      runtime.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'filter-empty' }).activeStateId
    ).toBe('orders-empty');
    expect(() =>
      runtime.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'missing' })
    ).toThrow(PrototypeRuntimeError);
    expect(() => runtime.dispatch({ type: 'jump', href: 'https://evil.example' })).toThrow(
      PrototypeRuntimeError
    );
    expect(() =>
      runtime.dispatch({ type: 'trigger', nodeId: 'new-order', portId: 'save' })
    ).toThrow(/not active/);
  });

  it('restores the active path at the navigation boundary when going back', () => {
    const runtime = createPrototypeRuntime(prototypeGraphFixture);
    runtime.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'create' });
    runtime.dispatch({ type: 'trigger', nodeId: 'new-order', portId: 'save' });
    expect(runtime.snapshot().activePathTransitionIds).toEqual(['create-order', 'save-order']);
    expect(runtime.dispatch({ type: 'back' })).toMatchObject({
      activeNodeId: 'orders',
      activePathTransitionIds: []
    });
  });

  it('replaces an existing action-port connector through the headless editor command', () => {
    const graph = upsertPrototypeTransition(prototypeGraphFixture, {
      id: 'alternate-create-order',
      kind: 'navigate',
      from: { nodeId: 'orders', portId: 'create' },
      to: { nodeId: 'new-order' }
    });
    expect(graph.transitions).toHaveLength(prototypeGraphFixture.transitions.length);
    expect(
      graph.transitions.find((transition) => transition.id === 'create-order')
    ).toBeUndefined();
    expect(
      graph.transitions.find((transition) => transition.id === 'alternate-create-order')
    ).toMatchObject({
      from: { nodeId: 'orders', portId: 'create' }
    });
  });

  it('supports timeout/reset semantics, scenarios, and portable graph lifecycle boundaries', () => {
    const graph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      nodes: prototypeGraphFixture.nodes.map((node) =>
        node.id === 'orders'
          ? {
              ...node,
              ports: [
                ...node.ports,
                { id: 'expire', label: 'Expire', trigger: 'timeout', timeoutMs: 25 }
              ]
            }
          : node
      ),
      transitions: [
        ...prototypeGraphFixture.transitions,
        {
          id: 'expire-orders',
          kind: 'reset-flow',
          from: { nodeId: 'orders', portId: 'expire' }
        }
      ]
    });
    const scenarioRuntime = createPrototypeRuntime(graph, 'orders-empty');
    expect(scenarioRuntime.snapshot()).toMatchObject({
      activeNodeId: 'orders',
      activeStateId: 'orders-empty',
      scenarioId: 'orders-empty'
    });
    expect(
      scenarioRuntime.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'expire' })
    ).toMatchObject({
      activeNodeId: 'orders',
      activeStateId: 'orders-empty',
      scenarioId: 'orders-empty',
      history: ['orders'],
      activePathTransitionIds: ['expire-orders']
    });
    const exported = exportPrototypeGraph(graph);
    expect(importPrototypeGraph(exported)).toEqual(graph);
    const handoff = exportPrototypeHandoff(graph);
    expect(handoff).toContain('selene-prototype-handoff/v1');
    expect(importPrototypeHandoff(handoff)).toEqual(graph);
    const updated = parsePrototypeGraph({
      ...graph,
      revision: { ...graph.revision, id: 'orders-r2' },
      scenarios: [
        ...graph.scenarios,
        { id: 'orders-new', name: 'Orders new', startNodeId: 'orders', expectedPath: ['orders'] }
      ]
    });
    expect(diffPrototypeGraphs(graph, updated)).toMatchObject({
      fromRevisionId: 'orders-r1',
      toRevisionId: 'orders-r2',
      changedScenarioIds: ['orders-new']
    });
  });

  it('copies and pastes a graph fragment with remapped IDs', () => {
    const fragment = copyPrototypeNodes(prototypeGraphFixture, ['orders', 'orders-empty']);
    const pasted = pastePrototypeNodes(prototypeGraphFixture, fragment);
    expect(pasted.nodes.map((node) => node.id)).toContain('orders-copy');
    expect(pasted.nodes.map((node) => node.id)).toContain('orders-empty-copy');
    expect(pasted.transitions.some((transition) => transition.from.nodeId === 'orders-copy')).toBe(
      true
    );
  });

  it('rejects hostile fixture and browser-history snapshot input before runtime state changes', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index <= 16; index += 1) deep = { nested: deep };
    expect(() => parsePrototypeGraph({ ...prototypeGraphFixture, fixtures: { deep } })).toThrow(
      /nesting depth/
    );
    expect(() =>
      parsePrototypeGraph({ ...prototypeGraphFixture, fixtures: { unicode: '😀'.repeat(3_000) } })
    ).toThrow(/oversized string/);
    expect(() =>
      parsePrototypeGraph({
        ...prototypeGraphFixture,
        scenarios: [
          {
            id: 'unwired',
            name: 'Unwired',
            startNodeId: 'orders',
            expectedPath: ['orders', 'orders']
          }
        ]
      })
    ).toThrow(/unwired transition/);
    const oversized = 'é'.repeat(1_000_001);
    expect(() => importPrototypeGraph(oversized)).toThrow(/too large/);
    expect(() => importPrototypeHandoff(oversized)).toThrow(/too large/);
    const runtime = createPrototypeRuntime(prototypeGraphFixture, 'orders-default');
    const before = runtime.snapshot();
    expect(() =>
      runtime.restore({
        ...before,
        scenarioId: 'missing',
        fixtures: { tampered: true }
      })
    ).toThrow(PrototypeRuntimeError);
    expect(runtime.snapshot()).toEqual(before);
    expect(() =>
      parsePrototypeRuntimeSnapshot(
        { ...before, activeNodeId: 'new-order', history: ['orders'] },
        prototypeGraphFixture
      )
    ).toThrow(/snapshot history/);
    const navigated = createPrototypeRuntime(prototypeGraphFixture).dispatch({
      type: 'trigger',
      nodeId: 'orders',
      portId: 'create'
    });
    expect(() =>
      parsePrototypeRuntimeSnapshot(
        { ...navigated, activePathTransitionIds: ['save-order'] },
        prototypeGraphFixture
      )
    ).toThrow(/not active/);
    expect(() =>
      parsePrototypeRuntimeSnapshot(
        { ...navigated, historyPathLengths: [0, 0] },
        prototypeGraphFixture
      )
    ).toThrow(/snapshot history/);
    const returned = createPrototypeRuntime(prototypeGraphFixture);
    returned.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'create' });
    const afterBack = returned.dispatch({ type: 'trigger', nodeId: 'new-order', portId: 'cancel' });
    expect(() =>
      parsePrototypeRuntimeSnapshot(
        { ...afterBack, activePathTransitionIds: ['create-order', 'cancel-order'] },
        prototypeGraphFixture
      )
    ).toThrow(/snapshot history/);
    const mutable = structuredClone(prototypeGraphFixture);
    const clonedRuntime = new PrototypeRuntime(mutable);
    mutable.nodes[0]!.label = 'Mutated outside runtime';
    expect(clonedRuntime.graph.nodes[0]!.label).toBe('Orders');
    expect(() => new PrototypeRuntime({ malformed: true })).toThrow(PrototypeGraphValidationError);
  });

  it('schedules typed timeout ports through a bounded host timer and ignores cleanup-safe stale work', () => {
    const graph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      nodes: prototypeGraphFixture.nodes.map((node) =>
        node.id === 'orders'
          ? {
              ...node,
              ports: [
                ...node.ports,
                { id: 'expire', label: 'Expire', trigger: 'timeout', timeoutMs: 25 }
              ]
            }
          : node
      ),
      transitions: [
        ...prototypeGraphFixture.transitions,
        {
          id: 'expire-orders',
          kind: 'reset-flow',
          from: { nodeId: 'orders', portId: 'expire' }
        }
      ]
    });
    const callbacks: Array<() => void> = [];
    const cleared: unknown[] = [];
    const snapshots: unknown[] = [];
    const cancel = schedulePrototypeTimeouts(
      createPrototypeRuntime(graph),
      {
        setTimeout(callback, delayMs) {
          expect(delayMs).toBe(25);
          callbacks.push(callback);
          return callback;
        },
        clearTimeout(handle) {
          cleared.push(handle);
        }
      },
      (snapshot) => snapshots.push(snapshot)
    );
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    expect(snapshots).toHaveLength(1);
    cancel();
    expect(cleared).toHaveLength(1);
  });

  it('surfaces unexpected timeout callback failures while treating inactive timeout ports as stale', () => {
    const callbacks: Array<() => void> = [];
    const failures: unknown[] = [];
    const runtime = createPrototypeRuntime(prototypeGraphFixture);
    runtime.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'create' });
    schedulePrototypeTimeouts(
      runtime,
      {
        setTimeout(callback) {
          callbacks.push(callback);
          return callback;
        },
        clearTimeout() {}
      },
      () => {
        throw new Error('host snapshot handling failed');
      },
      (failure) => failures.push(failure)
    );
    callbacks[0]!();
    expect(failures).toMatchObject([
      { type: 'unexpected-timeout-error', nodeId: 'new-order', portId: 'expire' }
    ]);

    const staleCallbacks: Array<() => void> = [];
    const staleRuntime = createPrototypeRuntime(prototypeGraphFixture);
    staleRuntime.dispatch({ type: 'trigger', nodeId: 'orders', portId: 'create' });
    schedulePrototypeTimeouts(
      staleRuntime,
      {
        setTimeout(callback) {
          staleCallbacks.push(callback);
          return callback;
        },
        clearTimeout() {}
      },
      () => undefined,
      (failure) => failures.push(failure)
    );
    staleRuntime.dispatch({ type: 'trigger', nodeId: 'new-order', portId: 'cancel' });
    staleCallbacks[0]!();
    expect(failures).toHaveLength(1);
  });
});
