import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { parsePrototypeGraph, type PrototypeGraph } from '@selene/core';

import { PrototypeFlowCanvas } from './prototype';
import { Button, Card, StatusBadge } from './index';

const cockpitGraph = parsePrototypeGraph({
  format: 'selene-prototype-graph/v1',
  id: 'desktop-cockpit-flow',
  name: 'Desktop cockpit checkout',
  project: { projectId: 'desktop-cockpit', owner: 'Selene' },
  revision: { id: 'cockpit-r1', createdAt: '2026-07-24T19:00:00.000Z', summary: 'Cockpit visual fixture' },
  handoff: { status: 'draft', owner: 'Selene', summary: 'Interactive cockpit fixture' },
  initialNodeId: 'catalog',
  nodes: [
    { id: 'catalog', kind: 'screen', label: 'Catalog', route: '/', position: { x: 32, y: 72 }, ports: [{ id: 'open-order', label: 'Open order', trigger: 'click' }] },
    { id: 'order', kind: 'screen', label: 'Order details', route: '/orders/42', position: { x: 360, y: 72 }, ports: [{ id: 'back', label: 'Back', trigger: 'click' }, { id: 'show-note', label: 'Show review note', trigger: 'click' }] },
    { id: 'note', kind: 'overlay', label: 'Review note', dismissible: true, position: { x: 700, y: 250 }, ports: [{ id: 'dismiss', label: 'Dismiss', trigger: 'click' }] }
  ],
  transitions: [
    { id: 'catalog-open-order', kind: 'navigate', from: { nodeId: 'catalog', portId: 'open-order' }, to: { nodeId: 'order' } },
    { id: 'order-back', kind: 'back', from: { nodeId: 'order', portId: 'back' } },
    { id: 'order-show-note', kind: 'open-overlay', from: { nodeId: 'order', portId: 'show-note' }, to: { nodeId: 'note' } },
    { id: 'note-dismiss', kind: 'close-overlay', from: { nodeId: 'note', portId: 'dismiss' }, to: { nodeId: 'note' } }
  ],
  scenarios: [{ id: 'review-order', name: 'Review order', startNodeId: 'catalog', expectedPath: ['catalog', 'order', 'note'] }],
  fixtures: { reviewThread: 'Verify the total remains visible after opening the note.' }
});

function DesktopCockpitStory() {
  const [graph, setGraph] = useState<PrototypeGraph>(cockpitGraph);
  const [selectedPin, setSelectedPin] = useState('pin-total');
  return (
    <main aria-label="Desktop designer cockpit" className="sl-theme" style={{ background: '#f6f7fb', color: '#172033', minHeight: 760, padding: 20 }}>
      <header style={{ alignItems: 'center', display: 'flex', gap: 12, justifyContent: 'space-between' }}>
        <div><strong>Selene</strong><span style={{ marginLeft: 8 }}>Desktop production designer</span></div>
        <div style={{ alignItems: 'center', display: 'flex', gap: 8 }}><StatusBadge tone="success">Saved locally</StatusBadge><Button>Render revision</Button><Button>Ready for review</Button></div>
      </header>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'minmax(190px, 1fr) minmax(420px, 2.5fr) minmax(220px, 1fr)', marginTop: 18 }}>
        <Card>
          <h2>AI change request</h2>
          <label>Instruction<textarea defaultValue="Make the primary action clearer." /></label>
          <Button>Target preview region</Button>
          <p>AI targeting is separate from persistent artifact pins.</p>
          <h3>Review thread</h3><p>Open · Verify total visibility</p><Button>Resolve thread</Button>
        </Card>
        <Card>
          <header style={{ display: 'flex', justifyContent: 'space-between' }}><strong>Compiled React artifact</strong><code>cockpit-r1</code></header>
          <div aria-label="Compiled preview with spatial pins" style={{ background: 'white', border: '1px solid #d6d9e5', height: 220, marginTop: 12, padding: 20, position: 'relative' }}>
            <h2>Order #42</h2><p>Review order contents and confirm shipment.</p><Button>Show review note</Button>
            <button aria-label="Select artifact pin order total" aria-pressed={selectedPin === 'pin-total'} onClick={() => setSelectedPin('pin-total')} style={{ background: '#f5f3ff', border: selectedPin === 'pin-total' ? '3px solid #4c1d95' : '2px solid #7c3aed', borderRadius: '50%', height: 24, left: '72%', position: 'absolute', top: '58%', width: 24 }}>•</button>
          </div>
          <p>Selected persistent pin: {selectedPin === 'pin-total' ? 'Order total' : 'None'}</p>
        </Card>
        <Card>
          <h2>Guided local setup</h2><p>Demo catalog fixture · staged only</p>
          <label>Package<input defaultValue="@selene/design-tokens" /></label>
          <Button>Inspect package</Button>
          <label>Template<select defaultValue="dashboard"><option>Blank</option><option>Dashboard</option><option>Review</option></select></label>
          <Button>Create project</Button>
        </Card>
      </div>
      <Card style={{ marginTop: 16 }}>
        <h2>Saved prototype flow</h2><p>Editable graph fixture with accessible keyboard controls and persistent host-owned revision state.</p>
        <PrototypeFlowCanvas graph={graph} onGraphChange={setGraph} />
      </Card>
    </main>
  );
}

const meta = { title: 'Desktop/Cockpit', component: DesktopCockpitStory, parameters: { layout: 'fullscreen' } } satisfies Meta<typeof DesktopCockpitStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Interactive: Story = {};
