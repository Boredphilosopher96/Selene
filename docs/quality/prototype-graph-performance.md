# Prototype graph operation performance

Measured on 2026-10-04 in the Linux x64 cloud workspace using Bun 1.3.14
(baseline x64 build), an AMD EPYC 9V74 host, and the same checked-in benchmark
harness before and after the change. The baseline is commit
`6602ebd2e3a7c4f34ece847a1094c81f70d8e1c8`.

## Bottleneck and bounded change

Graph semantic validation previously scanned the transition array for each step
of every scenario path, and transition removal repeated the same scan while
finding each scenario's longest wired prefix. At the accepted schema limits this
can require nearly 200 million candidate comparisons per validation. The CPU
profile of the baseline benchmark attributes the dominant self time to these
scenario-validation and edge-removal loops (baseline source lines 339–354 and
762–768).

The change creates node-ID and source-to-target indexes within each operation.
Each path step then uses a set lookup. There is no persistent graph cache, no
validation bypass, no new public API, and no increased schema limit. Invalid
duplicate IDs keep their original first-match diagnostics. Alternate transitions
between the same pair of nodes still keep a scenario wired. Back and reset edges
still have no fixed destination.

## Method

Run from the repository root:

```sh
bun scripts/benchmark-prototype-graph.mjs
```

For a baseline, check out the baseline SHA in a separate worktree, install the
same frozen dependencies, and run this exact harness with the baseline module:

```sh
bun scripts/benchmark-prototype-graph.mjs ../baseline/packages/core/src/prototype-graph.ts
```

The optional argument selects a source module without changing the fixture or
measurement code. For CPU sampling, run either command with `bun --cpu-prof-md`
and keep profile output outside the checkout. Profiled runs are separate from
the latency results below.

Each operation receives three warmups followed by 15 timed samples. The fixture
has four valid navigation ports per screen and one path through every screen per
scenario. The workloads are:

- Small: 20 nodes, 80 transitions, 10 scenarios, 19 steps per scenario
- Medium: 100 nodes, 400 transitions, 50 scenarios, 99 steps per scenario
- Schema limit: 500 nodes, 2,000 transitions, 200 scenarios, 499 steps per scenario

The removal cases delete a near-end edge, either unrelated to each expected path
or its last hop. The replacement case calls the real editor upsert boundary,
which validates both the input and resulting graph.

## Results

Times are milliseconds. These are synthetic core-operation measurements on a
shared cloud host, not end-to-end renderer or user-interaction latency. The small
fixture differences are within the noise floor; do not infer a general speedup
from those samples. The larger workload improvement is the intended result.

| Workload     | Operation             | Before median | After median | Before p95 | After p95 |
| ------------ | --------------------- | ------------: | -----------: | ---------: | --------: |
| Small        | Parse/validate        |         0.840 |        0.818 |      1.034 |     1.145 |
| Small        | Remove unrelated edge |         0.825 |        0.729 |      3.706 |     3.951 |
| Small        | Remove last path hop  |         0.472 |        0.398 |      0.630 |     0.456 |
| Small        | Replace edge          |         0.806 |        0.724 |      4.212 |     3.009 |
| Medium       | Parse/validate        |         6.662 |        1.809 |      8.703 |     3.656 |
| Medium       | Remove unrelated edge |        11.869 |        2.214 |     13.511 |     7.077 |
| Medium       | Remove last path hop  |        11.170 |        2.144 |     16.768 |     7.139 |
| Medium       | Replace edge          |        13.988 |        3.702 |     23.130 |     6.625 |
| Schema limit | Parse/validate        |       432.325 |       19.738 |    479.083 |    30.246 |
| Schema limit | Remove unrelated edge |       927.588 |       21.859 |    967.300 |    25.267 |
| Schema limit | Remove last path hop  |       918.601 |       21.309 |    993.059 |    24.716 |
| Schema limit | Replace edge          |       843.911 |       38.383 |    870.476 |    41.846 |

At the schema limit, the measured median parse time fell 95.4%, and the measured
median last-hop removal time fell 97.7%. Timing assertions are intentionally not
used as CI gates. Behavioral tests cover schema-limit paths, late dangling edges,
alternate wires, mutation without stale caches, duplicate-ID diagnostics,
special-name IDs, and state/overlay/destination-free edge semantics.

## Separate Node/V8 cross-check

The same source-module harness was also run in Node 24.19.0 on the same cloud
host, with the same three warmups and 15 samples. Use Node's type-transformation
flag to execute the existing TypeScript module directly:

```sh
node --experimental-transform-types scripts/benchmark-prototype-graph.mjs
node --experimental-transform-types scripts/benchmark-prototype-graph.mjs ../baseline/packages/core/src/prototype-graph.ts
```

This confirms the algorithm improvement in V8 as well as Bun. It does not measure
Electron startup or browser rendering. Small-fixture parse medians were
0.771 ms before and 0.780 ms after, again within the noise floor.

| Workload     | Operation             | Before median | After median | Before p95 | After p95 |
| ------------ | --------------------- | ------------: | -----------: | ---------: | --------: |
| Medium       | Parse/validate        |        12.536 |        2.808 |     13.503 |     6.387 |
| Medium       | Remove unrelated edge |        14.845 |        2.986 |     16.540 |     4.298 |
| Medium       | Remove last path hop  |        14.486 |        2.698 |     15.994 |     3.757 |
| Medium       | Replace edge          |        18.342 |        5.774 |     28.416 |     7.770 |
| Schema limit | Parse/validate        |       609.937 |       24.826 |    856.393 |    32.655 |
| Schema limit | Remove unrelated edge |      1098.669 |       27.103 |   1301.001 |    29.747 |
| Schema limit | Remove last path hop  |      1035.516 |       27.154 |   1183.932 |    37.050 |
| Schema limit | Replace edge          |      1046.595 |       50.186 |   1193.114 |    52.617 |
