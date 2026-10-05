import { performance } from 'node:perf_hooks';

import {
  DesktopDesignerApplicationService,
  DeterministicDesignerFixtureAdapter
} from '../../apps/desktop/src/main/designer-service';
import { createEmbeddedBuildMetadataPort } from '../../apps/desktop/src/main/build-metadata';
import {
  DesktopDesignSystemIntake,
  createLocalCatalogFixturePort
} from '../../apps/desktop/src/main/designer-setup-host';
import { desktopDesignInputRuntime } from '../../apps/desktop/src/main/design-input-runtime';

// Measures the real headless service only. This is not an Electron latency or FPS claim.
const service = new DesktopDesignerApplicationService(
  createEmbeddedBuildMetadataPort(),
  undefined,
  {
    async read() {
      return undefined;
    },
    async compareAndSwap() {
      throw new Error('Persistence is outside this observation.');
    },
    async recoverFromFixture() {
      throw new Error('Recovery is outside this observation.');
    }
  },
  new DesktopDesignSystemIntake(createLocalCatalogFixturePort(), desktopDesignInputRuntime),
  'local-designer-11111111-1111-4111-8111-111111111111'
);
service.registerAgent(new DeterministicDesignerFixtureAdapter());
const scenario = service.snapshot().scenarios[0]!.id;
function measure(count: number) {
  const times: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = performance.now();
    service.selectScenario(scenario);
    times.push(performance.now() - start);
  }
  const sorted = times.toSorted((left, right) => left - right);
  const snapshot = service.snapshot();
  return {
    count,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
    transientNotices: snapshot.activity.length,
    snapshotJsonCharacters: JSON.stringify(snapshot).length,
    rssBytes: process.memoryUsage().rss
  };
}
console.log(
  JSON.stringify({ initial: measure(200), longSession: measure(10000), after: measure(200) })
);
