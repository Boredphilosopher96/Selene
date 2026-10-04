import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('../packages/core/src/prototype-graph.ts', import.meta.url);
const {
  parsePrototypeGraph,
  prototypeGraphFixture,
  removePrototypeTransition,
  upsertPrototypeTransition
} = await import(moduleUrl.href);

// Run with `bun scripts/benchmark-prototype-graph.mjs [source-module-path]`.
// An optional source path permits the exact same harness to measure a baseline.
// This measures the real
// validation/editor boundary, not a substitute algorithm. Timings are diagnostic
// only: shared-runner latency is unsuitable for a deterministic CI assertion.
const sampleCount = 15;
const warmupCount = 3;

function graphFixture(nodeCount, scenarioCount) {
  const nodes = Array.from({ length: nodeCount }, (_node, index) => ({
    id: `screen-${index}`,
    kind: 'screen',
    label: `Screen ${index}`,
    route: `/screen-${index}`,
    position: { x: index * 100, y: 0 },
    ports: Array.from({ length: 4 }, (_port, port) => ({
      id: `next-${port}`,
      label: `Next ${port}`,
      trigger: 'click'
    }))
  }));
  return {
    ...prototypeGraphFixture,
    id: 'benchmark-graph',
    initialNodeId: nodes[0].id,
    nodes,
    transitions: nodes.flatMap((node, index) =>
      node.ports.map((port, offset) => ({
        id: `navigate-${index}-${offset}`,
        kind: 'navigate',
        from: { nodeId: node.id, portId: port.id },
        to: { nodeId: nodes[(index + offset + 1) % nodeCount].id }
      }))
    ),
    scenarios: Array.from({ length: scenarioCount }, (_, index) => ({
      id: `scenario-${index}`,
      name: `Scenario ${index}`,
      startNodeId: nodes[0].id,
      expectedPath: nodes.map((node) => node.id)
    })),
    fixtures: {}
  };
}

function measure(run) {
  for (let index = 0; index < warmupCount; index += 1) run();
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return {
    samples: samples.length,
    medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    p95Ms: Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(3))
  };
}

const workloads = [
  { name: 'small', nodes: 20, scenarios: 10 },
  { name: 'medium', nodes: 100, scenarios: 50 },
  { name: 'schema-limit', nodes: 500, scenarios: 200 }
];

const measurements = workloads.map((workload) => {
  const graph = graphFixture(workload.nodes, workload.scenarios);
  // These two edges are near the end of every path. Removing the second port
  // keeps every scenario intact; removing the first truncates its wired prefix.
  const firstPort = `navigate-${workload.nodes - 2}-0`;
  const secondPort = `navigate-${workload.nodes - 2}-1`;
  const connection = graph.transitions.find((transition) => transition.id === secondPort);
  parsePrototypeGraph(graph);
  return {
    ...workload,
    transitions: graph.transitions.length,
    pathStepsPerScenario: workload.nodes - 1,
    parse: measure(() => parsePrototypeGraph(graph)),
    removeUnrelatedEdge: measure(() => removePrototypeTransition(graph, secondPort)),
    removePathEdge: measure(() => removePrototypeTransition(graph, firstPort)),
    replaceEdge: measure(() => upsertPrototypeTransition(graph, connection))
  };
});

console.log(
  JSON.stringify(
    {
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      platform: `${process.platform}/${process.arch}`,
      sampleCount,
      warmupCount,
      measurements
    },
    null,
    2
  )
);
