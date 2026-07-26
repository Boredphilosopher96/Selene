import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { prototypeGraphFixture } from '../../../packages/core/src/prototype-graph';
import { PrototypeFlowCanvas } from '../../../packages/ui/src/prototype-flow-canvas';

type DeferredRun = { readonly resolve: () => void; settled: boolean };

declare global {
  interface Window {
    selenePrototypeFlowHarness?: {
      callbackCount(): number;
      remount(): void;
      settle(index: number): boolean;
    };
  }
}

const callbacks: DeferredRun[] = [];

function PrototypeFlowHarness() {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    window.selenePrototypeFlowHarness = {
      callbackCount: () => callbacks.length,
      remount: () => setGeneration((value) => value + 1),
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
      key={generation}
      graph={prototypeGraphFixture}
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
