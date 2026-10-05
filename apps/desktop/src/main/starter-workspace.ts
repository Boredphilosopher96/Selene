import {
  parsePrototypeGraph,
  type EnterpriseScenario,
  type PrototypeGraph,
  type ReactSourceWorkspace
} from '@selene/core';

export type StarterTemplate = 'blank' | 'dashboard' | 'review';

const definitions = {
  blank: { title: 'Blank canvas', screens: [{ id: 'canvas', route: '/', title: 'Canvas' }] },
  dashboard: {
    title: 'Operations dashboard',
    screens: [
      { id: 'dashboard', route: '/', title: 'Overview' },
      { id: 'orders', route: '/orders', title: 'Orders' }
    ]
  },
  review: {
    title: 'Design review',
    screens: [
      { id: 'review', route: '/', title: 'Review brief' },
      { id: 'decision', route: '/decision', title: 'Decision notes' }
    ]
  }
} as const;

// Authored JSX text is deliberate: direct editing must stay on the existing
// literal-only compiler-bound path, rather than mutating arbitrary expressions.
const blankContent = `
    <main className="starter starter--blank" data-selene-node-id="designer.root" style={{ display: 'grid' }}>
      <div className="blank-surface" data-selene-node-id="canvas.surface" style={{ display: 'flex', flexDirection: 'column' }}>
        <span className="eyebrow" data-selene-node-id="canvas.eyebrow">A fresh canvas</span>
        <div className="blank-mark" aria-hidden="true">+</div>
        <h1 data-selene-node-id="designer.title">Your next idea</h1>
        <p className="lede" data-selene-node-id="designer.summary">Start with a clear thought. Make it something people love.</p>
        <div className="blank-guidance" data-selene-node-id="canvas.guidance">Select this heading to edit its text, or add a component from your design system.</div>
      </div>
      {data.fixtureNote.length > 0 && <p className="sample-note fixture-note" data-selene-node-id="starter.fixture-note">{data.fixtureNote}</p>}
    </main>`;

const dashboardContent = `
    <main className="starter starter--dashboard" data-selene-node-id="designer.root" style={{ display: 'grid' }}>
      <aside className="starter-sidebar" aria-label="Workspace identity">
        <span className="brand-symbol" aria-hidden="true">N</span>
        <strong data-selene-node-id="dashboard.brand">Northstar</strong>
        <span className="sidebar-label" data-selene-node-id="dashboard.section">Operations workspace</span>
        {screenId === 'orders' ? <span className="sidebar-current">Orders</span> : <span className="sidebar-current">Overview</span>}
        <div className="sidebar-footer">Local sample data</div>
      </aside>
      {screenId === 'orders' ? (
        <section className="starter-body" data-selene-node-id="orders.screen" style={{ display: 'flex', flexDirection: 'column' }}>
          <header className="page-heading">
            <div><span className="eyebrow">Operations / Orders</span><h1 data-selene-node-id="orders.title">Orders to watch</h1><p className="lede" data-selene-node-id="orders.summary">A focused view of the work moving through your team.</p></div>
            <button className="button button--secondary" data-selene-node-id="orders.back" data-selene-flow-node="orders" data-selene-action-port="back" onClick={() => navigateTo('dashboard')}>Back to overview</button>
          </header>
          <section className="card" data-selene-node-id="orders.table">
            <div className="card-heading"><h2 data-selene-node-id="orders.table-title">Current orders</h2><span className="muted">3 sample orders</span></div>
            <table><thead><tr><th scope="col">Order</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Total</th></tr></thead><tbody>
              <tr><td data-selene-node-id="orders.first-id">#1042</td><td data-selene-node-id="orders.first-customer">Cedar Studio</td><td><span className="badge">In progress</span></td><td>$840</td></tr>
              <tr><td>#1041</td><td>Forma Collective</td><td><span className="badge badge--amber">Needs review</span></td><td>$1,240</td></tr>
              <tr><td>#1040</td><td>Atlas Works</td><td><span className="badge badge--green">Complete</span></td><td>$620</td></tr>
            </tbody></table>
          </section>
          <p className="sample-note">Sample data for a starting design. No live orders or payments are connected.</p>
        </section>
      ) : (
        <section className="starter-body" data-selene-node-id="dashboard.screen" style={{ display: 'flex', flexDirection: 'column' }}>
          <header className="page-heading">
            <div><span className="eyebrow" data-selene-node-id="dashboard.eyebrow">Workspace overview</span><h1 data-selene-node-id="designer.title">Good work, in view.</h1><p className="lede" data-selene-node-id="designer.summary">A little clarity for your team's next move.</p></div>
            <span className="date-label">Weekly snapshot</span>
          </header>
          <section className="metric-grid" aria-label="Sample workspace metrics" data-selene-node-id="dashboard.metrics" style={{ display: 'grid', gap: 16 }}>
            <article className="card metric"><span data-selene-node-id="dashboard.metric-projects-label">Active projects</span><strong data-selene-node-id="dashboard.metric-projects-value">24</strong><p>Across 4 teams</p><span className="metric-trend">+4 this month</span></article>
            <article className="card metric"><span data-selene-node-id="dashboard.metric-orders-label">Orders in progress</span><strong data-selene-node-id="dashboard.metric-orders-value">12</strong><p>Ready for the next step</p><span className="metric-trend">3 need review</span></article>
            <article className="card metric"><span data-selene-node-id="dashboard.metric-health-label">On-time delivery</span><strong data-selene-node-id="dashboard.metric-health-value">98%</strong><p>Steady, week over week</p><span className="metric-trend">+2% this month</span></article>
          </section>
          <section className="card" data-selene-node-id="dashboard.work">
            <div className="card-heading"><div><h2 data-selene-node-id="dashboard.work-title">Active work</h2><p className="muted" data-selene-node-id="dashboard.work-summary">What your team is moving forward</p></div><button className="button" data-selene-node-id="designer.action" data-selene-flow-node="dashboard" data-selene-action-port="open-orders" onClick={() => navigateTo('orders')}>View orders</button></div>
            <table><thead><tr><th scope="col">Project</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Progress</th></tr></thead><tbody>
              <tr><td><strong data-selene-node-id="dashboard.project-one">Website refresh</strong><span className="table-detail">Brand &amp; experience</span></td><td><span className="avatar">AL</span> Alex Lee</td><td><span className="badge">In progress</span></td><td><span className="progress-track"><span style={{ width: '72%' }} /></span><span className="progress-label">72%</span></td></tr>
              <tr><td><strong data-selene-node-id="dashboard.project-two">Customer onboarding</strong><span className="table-detail">Product design</span></td><td><span className="avatar avatar--rose">MK</span> Morgan Kim</td><td><span className="badge badge--amber">In review</span></td><td><span className="progress-track"><span style={{ width: '90%' }} /></span><span className="progress-label">90%</span></td></tr>
              <tr><td><strong data-selene-node-id="dashboard.project-three">Spring collection</strong><span className="table-detail">Campaign</span></td><td><span className="avatar avatar--green">JR</span> Jamie Rivera</td><td><span className="badge badge--green">Complete</span></td><td><span className="progress-track"><span style={{ width: '100%' }} /></span><span className="progress-label">100%</span></td></tr>
            </tbody></table>
          </section>
          <p className="sample-note">A starting design with sample metrics and projects. Select any heading to make it yours.</p>
        </section>
      )}
      {data.fixtureNote.length > 0 && <p className="sample-note fixture-note" data-selene-node-id="starter.fixture-note">{data.fixtureNote}</p>}
    </main>`;

const reviewContent = `
    <main className="starter starter--review" data-selene-node-id="designer.root" style={{ display: 'flex', flexDirection: 'column' }}>
      <header className="review-brand"><span className="brand-symbol" aria-hidden="true">F</span><strong data-selene-node-id="review.brand">Forma</strong><span className="muted">Design review</span><span className="badge badge--amber">Draft concept</span></header>
      {screenId === 'decision' ? (
        <section className="review-body" data-selene-node-id="decision.screen" style={{ display: 'flex', flexDirection: 'column' }}>
          <header className="page-heading"><div><span className="eyebrow">Review / Decision</span><h1 data-selene-node-id="decision.title">Make the next step clear.</h1><p className="lede" data-selene-node-id="decision.summary">Capture the direction, the open questions, and the work that follows.</p></div><button className="button button--secondary" data-selene-node-id="decision.back" data-selene-flow-node="decision" data-selene-action-port="back" onClick={() => navigateTo('review')}>Back to brief</button></header>
          <article className="card decision-card" data-selene-node-id="decision.notes" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}><span className="eyebrow">Decision notes</span><h2 data-selene-node-id="decision.notes-title">A direction worth exploring</h2><p data-selene-node-id="decision.notes-summary">Keep the warm welcome and the focused primary action. Simplify the supporting details before the next review.</p><hr /><h3 data-selene-node-id="decision.next-title">Next steps</h3><ul className="plain-list"><li data-selene-node-id="decision.next-one">Refine the hierarchy of the first screen</li><li data-selene-node-id="decision.next-two">Check the experience on a smaller viewport</li><li data-selene-node-id="decision.next-three">Bring the next iteration back for feedback</li></ul></article>
          <p className="sample-note">Example decision notes. Edit this source-backed content to reflect your team's review.</p>
        </section>
      ) : (
        <section className="review-body" data-selene-node-id="review.screen" style={{ display: 'flex', flexDirection: 'column' }}>
          <header className="page-heading"><div><span className="eyebrow" data-selene-node-id="review.eyebrow">Onboarding / First impression</span><h1 data-selene-node-id="designer.title">A calmer first hello.</h1><p className="lede" data-selene-node-id="designer.summary">A focused review of the welcome experience, from first glance to first action.</p></div><button className="button" data-selene-node-id="designer.action" data-selene-flow-node="review" data-selene-action-port="open-decision" onClick={() => navigateTo('decision')}>Open decision</button></header>
          <div className="review-grid" data-selene-node-id="review.content" style={{ display: 'grid', gap: 24 }}>
            <article className="card artifact-card" data-selene-node-id="review.artifact"><div className="card-heading"><h2 data-selene-node-id="review.artifact-title">Welcome concept</h2><span className="muted">Sample design</span></div><div className="concept-surface"><div className="concept-orbit" aria-hidden="true"><span /></div><span className="eyebrow" data-selene-node-id="review.concept-eyebrow">Room to begin</span><h3 data-selene-node-id="review.concept-title">Make space for great work.</h3><p data-selene-node-id="review.concept-summary">One place for your ideas, your team, and what comes next.</p><span className="concept-label">Welcome screen concept</span></div><p className="artifact-caption" data-selene-node-id="review.artifact-caption">A warmer introduction with fewer choices and a clearer starting point.</p></article>
            <aside className="review-brief" aria-label="Review brief" data-selene-node-id="review.brief" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}><section className="card brief-card"><span className="eyebrow">The intent</span><h2 data-selene-node-id="review.intent-title">Clarity before complexity</h2><p data-selene-node-id="review.intent-summary">Help a new teammate understand the value of the workspace before asking them to set it up.</p></section><section className="card brief-card"><h2 data-selene-node-id="review.questions-title">Questions for review</h2><ol className="review-questions"><li data-selene-node-id="review.question-one">Is the first action easy to find?</li><li data-selene-node-id="review.question-two">Does the copy feel human and useful?</li><li data-selene-node-id="review.question-three">What can we remove?</li></ol></section></aside>
          </div>
          <p className="sample-note">A sample review brief. The concept and notes are editable React source, with no live approvals connected.</p>
        </section>
      )}
      {data.fixtureNote.length > 0 && <p className="sample-note fixture-note" data-selene-node-id="starter.fixture-note">{data.fixtureNote}</p>}
    </main>`;

const stylesheet = `
*{box-sizing:border-box}body{margin:0;background:#f6f7fb;color:#242638;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}.starter{min-height:100vh;font-size:14px;line-height:1.5}.starter h1,.starter h2,.starter h3,.starter p{margin:0}.starter h1{font-size:clamp(28px,3.4vw,40px);letter-spacing:-.045em;line-height:1.2;font-weight:650}.starter h2{font-size:16px;letter-spacing:-.015em;font-weight:650}.starter h3{font-size:15px}.starter button{font:inherit;cursor:pointer}.eyebrow{text-transform:uppercase;letter-spacing:.13em;font-size:10px;font-weight:700;color:#656780;display:block;margin-bottom:12px}.lede{color:#656779;font-size:14px;line-height:1.7;margin-top:12px!important;max-width:540px}.muted{color:#656779;font-size:12px}.brand-symbol{background:#5552c9;color:#fff;display:inline-grid;place-items:center;width:30px;height:30px;border-radius:9px;font-size:15px;font-weight:750}.starter--dashboard{grid-template-columns:174px minmax(0,1fr)}.starter-sidebar{background:#fff;border-right:1px solid #e7e8ef;padding:28px 22px;display:flex;flex-direction:column;gap:14px}.starter-sidebar>strong{font-size:17px;letter-spacing:-.03em}.sidebar-label{color:#656779;font-size:10px}.sidebar-current{background:#f0effc;border-radius:7px;color:#4d49a7;padding:10px 12px;font-size:12px;font-weight:650;margin-top:24px}.sidebar-footer{margin-top:auto;padding-top:32px;color:#656779;font-size:10px}.starter-body{padding:38px clamp(20px,4vw,48px);gap:26px;min-width:0;max-width:1200px;width:100%;margin:auto}.page-heading{display:flex;align-items:center;justify-content:space-between;gap:20px}.date-label{font-size:11px;color:#656779;white-space:nowrap;padding:8px 12px;border:1px solid #e3e4ed;border-radius:7px;background:#fff}.metric-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.card{border:1px solid #e5e6ef;border-radius:12px;background:#fff;overflow:hidden;box-shadow:0 2px 4px #25265302}.metric{padding:22px;position:relative}.metric>span:first-child{color:#656779;font-size:11px;font-weight:550}.metric>strong{display:block;font-size:32px;letter-spacing:-.04em;font-weight:650;margin-top:8px}.metric>p{color:#656779;font-size:11px;margin-top:3px}.metric-trend{display:block;color:#4b548f;font-size:10px;margin-top:22px}.card-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px}.card-heading p{margin-top:5px}.button{border:1px solid #514cc1;border-radius:8px;background:#5853cb;color:white;padding:10px 15px;min-height:40px;font-size:12px!important;font-weight:600;white-space:nowrap;box-shadow:0 2px 3px #4f46a914}.button:hover{background:#4742b0}.button:focus-visible{outline:3px solid #a7a4ec;outline-offset:3px}.button--secondary{background:#fff;color:#5551ad;border-color:#dddef0;box-shadow:none}.button--secondary:hover{background:#f3f2fb}table{width:100%;border-collapse:collapse;text-align:left;table-layout:fixed}th{color:#656779;font-weight:550;font-size:10px;background:#fafbfe;letter-spacing:.015em}th,td{padding:15px 24px;border-top:1px solid #eff0f5;overflow-wrap:anywhere}td{font-size:11px;vertical-align:middle}td:first-child{width:34%}th:first-child{width:34%}td strong{font-weight:600}.table-detail{display:block;font-size:10px;color:#656779;margin-top:4px}.avatar{width:23px;height:23px;display:inline-grid;place-items:center;border-radius:50%;background:#eeedff;color:#595296;font-size:8px;font-weight:650;margin-right:7px}.avatar--rose{background:#faeef2;color:#8c4f64}.avatar--green{background:#e8f4ef;color:#466d5d}.badge{display:inline-block;border-radius:5px;background:#eeedfb;color:#6860a4;font-size:9px;font-weight:600;padding:4px 7px;white-space:nowrap}.badge--amber{background:#faf1de;color:#855b17}.badge--green{background:#e8f3ee;color:#3d6d59}.progress-track{display:inline-block;vertical-align:middle;background:#eeedf5;width:52px;height:4px;border-radius:4px;margin-right:7px;overflow:hidden}.progress-track>span{display:block;background:#716adc;height:100%;border-radius:4px}.progress-label{font-size:9px;color:#656779}.sample-note{font-size:10px!important;color:#656779;text-align:center}.review-brand{display:flex;align-items:center;gap:12px;padding:20px 32px;background:#fff;border-bottom:1px solid #e5e6ef}.review-brand>strong{font-size:17px;letter-spacing:-.03em}.review-brand>.badge{margin-left:auto}.review-body{width:100%;max-width:1110px;margin:auto;padding:40px 36px;gap:28px}.review-grid{grid-template-columns:minmax(0,1.6fr) minmax(230px,1fr);align-items:start}.concept-surface{padding:30px 24px 34px;min-height:330px;background:#f1f0fb;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;margin:0 16px;border-radius:8px;position:relative;overflow:hidden}.concept-orbit{width:86px;height:86px;border-radius:50%;background:linear-gradient(135deg,#b6b1ef,#e4d7eb);display:grid;place-items:center;margin-bottom:25px;border:1px solid #ffffffaa}.concept-orbit>span{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#f7e8ed,#8e88d1);box-shadow:6px 6px 18px #6e61a13b}.concept-surface h3{font-size:26px;letter-spacing:-.045em;max-width:290px;line-height:1.25;font-weight:650}.concept-surface p{font-size:11px;color:#66617f;max-width:235px;margin-top:12px}.concept-label{font-size:9px;color:#696283;border:1px solid #d7d3ed;border-radius:5px;padding:5px 9px;margin-top:24px}.artifact-caption{padding:20px 24px;color:#656779;font-size:11px}.brief-card{padding:24px}.brief-card>p{margin-top:12px;color:#656779;font-size:12px;line-height:1.8}.review-questions{margin:16px 0 0;padding-left:17px;color:#656779;font-size:12px;line-height:1.7}.review-questions>li+li{margin-top:14px}.decision-card{max-width:700px;padding:30px}.decision-card>p{font-size:14px;line-height:1.8;color:#656779}.decision-card hr{border:0;border-top:1px solid #e9eaf2;margin:8px 0}.plain-list{margin:0;padding-left:20px;color:#656779;line-height:2}.fixture-note{padding:12px 20px;border:1px solid #dedfeb;border-radius:8px;background:#fff}.starter--blank>.fixture-note{max-width:720px;width:100%}.starter--dashboard>.fixture-note{grid-column:1/-1;margin:0 24px 24px}.starter--review>.fixture-note{margin:0 auto 24px;max-width:1040px}.starter--blank{place-items:center;padding:48px 24px;background:radial-gradient(#dfe0eb 1px,transparent 1px);background-size:18px 18px}.blank-surface{align-items:center;justify-content:center;text-align:center;max-width:720px;width:100%;min-height:420px;background:#fff;border:1px solid #e5e6ef;border-radius:16px;padding:48px 28px;box-shadow:0 12px 40px #34355005}.blank-mark{height:52px;width:52px;display:grid;place-items:center;background:#f0effb;color:#645bb0;border-radius:14px;font-size:29px;font-weight:300;margin:12px 0 22px}.blank-surface h1{font-size:42px}.blank-guidance{color:#656779;font-size:11px;max-width:330px;margin-top:32px;line-height:1.8}@media(max-width:860px){.starter--dashboard{grid-template-columns:1fr}.starter-sidebar{padding:16px 24px;flex-direction:row;align-items:center;border-right:0;border-bottom:1px solid #e7e8ef}.sidebar-label,.sidebar-current,.sidebar-footer{display:none}.starter-body{padding:28px 24px}.review-body{padding:30px 24px}.review-grid{grid-template-columns:minmax(0,1fr)}.review-brief{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px!important}}@media(max-width:540px){.page-heading{align-items:flex-start;flex-direction:column}.metric-grid{grid-template-columns:1fr}.metric{padding:18px}.metric-trend{margin-top:12px}.card-heading{padding:18px;align-items:flex-start;flex-wrap:wrap}th,td{padding:12px 10px}td{font-size:10px}.avatar{display:none}.progress-track{width:25px}.badge{font-size:8px;padding:3px 4px}.review-brand{padding:16px 20px}.review-brand>.muted{display:none}.review-brief{grid-template-columns:1fr}.review-body,.starter-body{padding:26px 18px}.concept-surface h3{font-size:24px}.blank-surface{min-height:360px;padding:30px 20px}.blank-surface h1{font-size:34px}.starter--blank{padding:24px 18px}.date-label{display:none}}
`;

function sourceFor(template: StarterTemplate): string {
  const content = { blank: blankContent, dashboard: dashboardContent, review: reviewContent }[
    template
  ];
  return `import { useEffect, useLayoutEffect, useState } from 'react';
import './preview.css';
import data from './preview-data.json';

export default function App() {
  const descriptorScreenId = document.documentElement.dataset.previewScreenId;
  const initialScreenId = data.screens.some((screen) => screen.id === descriptorScreenId)
    ? descriptorScreenId! : data.initialScreenId;
  const [screenId, setScreenId] = useState(initialScreenId);
  const navigateTo = (id: string) => {
    const next = data.screens.find((screen) => screen.id === id);
    if (!next) return;
    window.history.pushState({ screen: id }, '', next.route);
    setScreenId(id);
  };
  useLayoutEffect(() => {
    const initial = data.screens.find((screen) => screen.id === initialScreenId);
    if (initial) window.history.replaceState({ screen: initial.id }, '', initial.route);
  }, [initialScreenId]);
  useEffect(() => {
    const onRuntime = (event: Event) => {
      const id = (event as CustomEvent<{ activeNodeId?: string }>).detail?.activeNodeId;
      const next = data.screens.find((screen) => screen.id === id);
      if (!next) return;
      window.history.replaceState({ screen: next.id }, '', next.route);
      setScreenId(next.id);
    };
    const onPopState = () => {
      const next = data.screens.find((screen) => screen.route === window.location.pathname);
      if (next) setScreenId(next.id);
    };
    window.addEventListener('selene-runtime-state', onRuntime);
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('selene-runtime-state', onRuntime);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);
  return (${content}
  );
}
`;
}

export function createStarterWorkspace(
  projectId: string,
  template: StarterTemplate
): ReactSourceWorkspace {
  const definition = definitions[template];
  const source = sourceFor(template);
  return {
    format: 'selene-react-workspace/v1',
    projectId,
    entrypoint: 'src/App.tsx',
    files: [
      { path: 'src/App.tsx', language: 'tsx', content: source },
      { path: 'src/preview.css', language: 'css', content: stylesheet },
      {
        path: 'src/preview-data.json',
        language: 'json',
        content: `${JSON.stringify(
          {
            format: 'selene-desktop-preview-data/v1',
            starterTemplate: template,
            fixtureNote: '',
            initialScreenId: definition.screens[0].id,
            screens: definition.screens
          },
          null,
          2
        )}\n`
      }
    ],
    dependencies: ['react', 'react-dom', 'react-dom/client'],
    nodes: [...source.matchAll(/data-selene-node-id="([^"]+)"/g)]
      .map((match) => ({ nodeId: match[1]!, path: 'src/App.tsx', exportName: 'default' }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    revision: {
      id: `${projectId}-${template}-r1`,
      createdAt: '2026-10-04T00:00:00.000Z',
      summary: `${definition.title} starter`
    }
  };
}

/** Built-in starter topology is content only; compiler evidence still owns every action/element grant. */
export function starterPrototypeGraphForWorkspace(
  workspace: ReactSourceWorkspace
): PrototypeGraph | undefined {
  const file = workspace.files.find(
    (candidate) => candidate.path === 'src/preview-data.json' && candidate.language === 'json'
  );
  if (file === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(file.content) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const manifest = value as {
    format?: unknown;
    starterTemplate?: unknown;
    fixtureNote?: unknown;
    initialScreenId?: unknown;
    screens?: unknown;
  };
  const template = manifest.starterTemplate;
  if (
    manifest.format !== 'selene-desktop-preview-data/v1' ||
    typeof manifest.fixtureNote !== 'string' ||
    (template !== 'blank' && template !== 'dashboard' && template !== 'review')
  )
    return undefined;
  const definition = definitions[template];
  if (
    manifest.initialScreenId !== definition.screens[0].id ||
    !Array.isArray(manifest.screens) ||
    manifest.screens.length !== definition.screens.length ||
    manifest.screens.some(
      (screen, index) =>
        typeof screen !== 'object' ||
        screen === null ||
        screen.id !== definition.screens[index]!.id ||
        screen.route !== definition.screens[index]!.route
    )
  )
    return undefined;
  const first = definition.screens[0];
  const second = definition.screens[1];
  const portId = template === 'dashboard' ? 'open-orders' : 'open-decision';
  return parsePrototypeGraph({
    format: 'selene-prototype-graph/v1',
    id: `${template}-starter-flow`,
    name: definition.title,
    project: { projectId: workspace.projectId, owner: 'Local design' },
    revision: { ...workspace.revision },
    handoff: {
      status: 'draft',
      owner: 'Local design',
      summary: `${definition.title} starting design`
    },
    initialNodeId: first.id,
    nodes: definition.screens.map((screen, index) => ({
      id: screen.id,
      kind: 'screen',
      label: screen.title,
      route: screen.route,
      position: { x: index * 440, y: 0 },
      ports:
        second === undefined
          ? []
          : index === 0
            ? [
                {
                  id: portId,
                  label: template === 'dashboard' ? 'View orders' : 'Open decision',
                  trigger: 'click'
                }
              ]
            : [{ id: 'back', label: 'Back', trigger: 'click' }]
    })),
    transitions:
      second === undefined
        ? []
        : [
            {
              id: `${first.id}-${second.id}`,
              kind: 'navigate',
              from: { nodeId: first.id, portId },
              to: { nodeId: second.id }
            },
            {
              id: `${second.id}-back`,
              kind: 'navigate',
              from: { nodeId: second.id, portId: 'back' },
              to: { nodeId: first.id }
            }
          ],
    scenarios: [
      {
        id: `${template}-start`,
        name: definition.title,
        startNodeId: first.id,
        expectedPath: second === undefined ? [first.id] : [first.id, second.id]
      },
      ...(second === undefined
        ? []
        : [
            {
              id: `${second.id}-default`,
              name: second.title,
              startNodeId: second.id,
              expectedPath: [second.id, first.id]
            }
          ])
    ],
    fixtures: { content: 'Local sample starter' }
  });
}

/** A built-in starter only renders its current authored design, not enterprise fixture states. */
export function starterScenariosForWorkspace(
  workspace: ReactSourceWorkspace,
  persistedGraph?: PrototypeGraph
): readonly EnterpriseScenario[] | undefined {
  // Accepted agent revisions can replace the data manifest. The durable project
  // graph still owns the starting design's truthful scenario context.
  const graph =
    persistedGraph?.project.projectId === workspace.projectId &&
    ['blank-starter-flow', 'dashboard-starter-flow', 'review-starter-flow'].includes(
      persistedGraph.id
    )
      ? persistedGraph
      : starterPrototypeGraphForWorkspace(workspace);
  if (graph === undefined) return undefined;
  return [
    {
      id: `${graph.id.slice(0, -'-starter-flow'.length)}-start`,
      title: `${graph.name} · Current design`,
      state: 'success',
      role: 'editor',
      permissions: ['read', 'edit'],
      featureFlags: {},
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      theme: 'light',
      brand: 'Starter',
      tokenMode: 'raw',
      accessibility: { initialFocus: 'designer.title', reducedMotion: true, keyboardPath: [] },
      navigation: graph.nodes
        .filter((node) => node.kind === 'screen')
        .map((node) => ({ action: node.label, route: node.route! })),
      fixture: {
        heading: graph.name,
        summary: 'Current authored starter with local sample content.',
        rows: []
      }
    }
  ];
}
