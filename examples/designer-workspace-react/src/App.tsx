import { useState } from 'react';

type Route = '/' | '/orders' | '/settings';
type DashboardState = 'default' | 'busy';

function Dashboard({ state }: { readonly state: DashboardState }) {
  return (
    <section data-selene-node-id="dashboard.root">
      <header data-selene-node-id="dashboard.hero">
        <p>Tuesday, July 23</p>
        <h1>{state === 'busy' ? 'A focused day ahead.' : 'Good morning, Mina.'}</h1>
        <p>
          {state === 'busy'
            ? '3 items are waiting on a decision.'
            : 'Here is what needs attention.'}
        </p>
      </header>
      <div data-selene-node-id="dashboard.metrics">Revenue $12,480 · 18 open orders</div>
    </section>
  );
}

function Orders() {
  return (
    <section data-selene-node-id="orders.root">
      <h1 data-selene-node-id="orders.title">Orders</h1>
      <div data-selene-node-id="orders.table">#1048 · Processing</div>
    </section>
  );
}

function Settings() {
  return (
    <section data-selene-node-id="settings.root">
      <aside data-selene-node-id="settings.sidebar">General · Members</aside>
      <h1 data-selene-node-id="settings.preferences">General preferences</h1>
    </section>
  );
}

/** A real React sample: routes and visual states are controlled without HTML-string output. */
export function App() {
  const [route, setRoute] = useState<Route>('/');
  const [dashboardState, setDashboardState] = useState<DashboardState>('default');
  return (
    <main>
      <nav aria-label="Sample routes">
        <button onClick={() => setRoute('/')}>Dashboard</button>
        <button onClick={() => setRoute('/orders')}>Orders</button>
        <button onClick={() => setRoute('/settings')}>Settings</button>
        <button
          onClick={() => setDashboardState((state) => (state === 'default' ? 'busy' : 'default'))}
        >
          Toggle dashboard state
        </button>
      </nav>
      {route === '/' ? (
        <Dashboard state={dashboardState} />
      ) : route === '/orders' ? (
        <Orders />
      ) : (
        <Settings />
      )}
    </main>
  );
}
