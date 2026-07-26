import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  parsePrototypeGraph,
  prototypeGraphFixture
} from '../../../packages/core/src/prototype-graph';
import { PrototypeFlowCanvas } from '../../../packages/ui/src/prototype-flow-canvas';

type DeferredRun = { readonly resolve: () => void; settled: boolean };

declare global {
  interface Window {
    selenePrototypeFlowHarness?: {
      callbackCount(): number;
      remount(): void;
      settle(index: number): boolean;
      showMaximumActionLabel(): void;
    };
  }
}

const callbacks: DeferredRun[] = [];
const maximumActionLabel = 'W'.repeat(160);
const maximumActionLabelGraph = parsePrototypeGraph({
  ...prototypeGraphFixture,
  nodes: prototypeGraphFixture.nodes.map((node) =>
    node.id === 'orders'
      ? {
          ...node,
          ports: node.ports.map((port) =>
            port.id === 'create' ? { ...port, label: maximumActionLabel } : port
          )
        }
      : node
  )
});

function PrototypeFlowHarness() {
  const [generation, setGeneration] = useState(0);
  const [maximumLabelScenario, setMaximumLabelScenario] = useState(false);

  useEffect(() => {
    window.selenePrototypeFlowHarness = {
      callbackCount: () => callbacks.length,
      remount: () => setGeneration((value) => value + 1),
      showMaximumActionLabel: () => setMaximumLabelScenario(true),
      settle: (index) => {
        const callback = callbacks[index];
        if (!callback || callback.settled) return false;
        callback.settled = true;
        callback.resolve();
        return true;
      }
    };
    return () => {
      delete window.selenePrototypeFlowHarness;
    };
  }, []);

  return (
    <PrototypeFlowCanvas
      key={`${generation}-${maximumLabelScenario ? 'maximum-label' : 'fixture'}`}
      graph={maximumLabelScenario ? maximumActionLabelGraph : prototypeGraphFixture}
      onGraphChange={() => undefined}
      onRunCommitted={() =>
        new Promise<void>((resolve) => {
          callbacks.push({ resolve, settled: false });
        })
      }
    />
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Prototype flow test fixture requires its root element.');
createRoot(root).render(<PrototypeFlowHarness />);
