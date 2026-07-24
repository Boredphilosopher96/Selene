const siteStyles = `
  :root {
    color: #17231d;
    background: #f7f7f2;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-synthesis: none;
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; min-width: 20rem; background: #f7f7f2; }
  a { color: inherit; }
  .skip-link { position: fixed; top: .75rem; left: .75rem; z-index: 20; padding: .75rem 1rem; background: #17231d; color: #fff; transform: translateY(-200%); }
  .skip-link:focus { transform: translateY(0); }
  .shell { width: min(100% - 2rem, 74rem); margin: 0 auto; }
  .site-header { position: sticky; top: 0; z-index: 10; border-bottom: 1px solid rgb(23 35 29 / 10%); background: rgb(247 247 242 / 92%); backdrop-filter: blur(16px); }
  .site-header__content { display: flex; align-items: center; justify-content: space-between; min-height: 4.5rem; gap: 1rem; }
  .brand { display: inline-flex; align-items: center; gap: .65rem; font-weight: 800; letter-spacing: -.03em; text-decoration: none; }
  .brand__mark { display: grid; width: 1.8rem; aspect-ratio: 1; place-items: center; border-radius: .55rem; background: #d9ff5d; color: #17231d; font-size: 1.1rem; }
  .site-nav { display: flex; align-items: center; gap: clamp(.5rem, 2vw, 1.4rem); font-size: .9rem; }
  .site-nav a { text-decoration: none; }
  .site-nav a:hover, .site-nav a:focus-visible { text-decoration: underline; text-underline-offset: .25rem; }
  .site-nav .nav-cta { padding: .6rem .85rem; border: 1px solid #17231d; border-radius: 999px; background: #17231d; color: #fff; }
  .site-nav .nav-cta:hover, .site-nav .nav-cta:focus-visible { background: #314237; text-decoration: none; }
  .eyebrow { margin: 0 0 1rem; color: #53675a; font-size: .76rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .button-row { display: flex; flex-wrap: wrap; gap: .75rem; }
  .button { display: inline-flex; align-items: center; justify-content: center; min-height: 2.85rem; padding: .7rem 1rem; border: 1px solid #17231d; border-radius: .6rem; background: #17231d; color: #fff; font-weight: 750; text-decoration: none; }
  .button:hover, .button:focus-visible { background: #314237; }
  .button--quiet { background: transparent; color: #17231d; }
  .button--quiet:hover, .button--quiet:focus-visible { background: #e4e8df; }
  .section { padding: clamp(4rem, 9vw, 7.5rem) 0; }
  .section-title { max-width: 42rem; margin: 0; font-size: clamp(2rem, 4vw, 3.5rem); line-height: 1.03; letter-spacing: -.055em; }
  .section-intro { max-width: 42rem; margin: 1.15rem 0 0; color: #526157; font-size: 1.1rem; line-height: 1.65; }
  .site-footer { border-top: 1px solid rgb(23 35 29 / 12%); padding: 2rem 0 3rem; color: #526157; font-size: .9rem; }
  .footer-content { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; }
  .footer-links { display: flex; flex-wrap: wrap; gap: 1rem; }
  .footer-links a { text-underline-offset: .2rem; }

  @media (max-width: 38rem) {
    .site-header__content { min-height: 4rem; }
    .site-nav a:not(.nav-cta) { display: none; }
  }
`;

function shell({ title, description, current = 'home', body }) {
  const root = current === 'docs' ? '../' : './';
  const docs = current === 'docs' ? './' : './docs/';
  const nav = (label, href, key) =>
    `<a${current === key ? ' aria-current="page"' : ''} href="${href}">${label}</a>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="${description}" />
    <meta name="theme-color" content="#f7f7f2" />
    <title>${title}</title>
    <style>${pagesStyles}</style>
  </head>
  <body>
    <a class="skip-link" href="#main-content">Skip to content</a>
    <header class="site-header">
      <div class="shell site-header__content">
        <a class="brand" href="${root}" aria-label="Selene home"><span class="brand__mark" aria-hidden="true">S</span>Selene</a>
        <nav class="site-nav" aria-label="Primary navigation">
          ${nav('Why Selene', `${root}#why-selene`, 'why')}
          ${nav('Get started', `${root}#get-started`, 'start')}
          ${nav('Docs', docs, 'docs')}
          <a class="nav-cta" href="${root}demo/">Open the demo <span aria-hidden="true">→</span></a>
        </nav>
      </div>
    </header>
    <main id="main-content">${body}</main>
    <footer class="site-footer">
      <div class="shell footer-content">
        <span>Selene is open source and local-first.</span>
        <nav class="footer-links" aria-label="Footer navigation">
          <a href="${root}demo/">Web demo</a>
          <a href="${root}storybook/">Component Storybook</a>
          <a href="${docs}">Architecture docs</a>
          <a href="https://github.com/Boredphilosopher96/Selene">GitHub</a>
        </nav>
      </div>
    </footer>
  </body>
</html>`;
}

export function publicLandingPage() {
  return shell({
    title: 'Selene — design intent, shipped as React',
    description:
      'Selene is a local-first workspace for turning design intent into reviewable React source.',
    body: `
      <section class="hero section">
        <div class="shell hero__grid">
          <div class="hero__copy">
            <p class="eyebrow">The local-first designer workspace</p>
            <h1>Make the next design decision in the real product.</h1>
            <p class="hero__lede">Selene turns conversations, visual review, and design-system context into reviewable React source—without making your team depend on one model, vendor, or hosted workspace.</p>
            <div class="button-row">
              <a class="button" href="./demo/">Try the web demo <span aria-hidden="true">→</span></a>
              <a class="button button--quiet" href="#get-started">See your first project</a>
            </div>
            <p class="hero__note">Pre-alpha, open source, and designed to keep projects portable.</p>
          </div>
          <div class="product-frame" aria-label="Illustration of a Selene review workspace">
            <div class="product-frame__topbar"><span class="window-dots" aria-hidden="true">● ● ●</span><span>Northstar / dashboard.tsx</span><span class="product-frame__status">In review</span></div>
            <div class="product-frame__content">
              <aside><strong>Northstar</strong><span>Dashboard</span><span>Orders</span><span>Settings</span></aside>
              <div class="product-canvas">
                <div class="product-canvas__heading"><span><small>Dashboard</small><strong>Good morning, Mina</strong></span><span class="product-button">Share review</span></div>
                <div class="metric-row"><span><small>Open decisions</small><strong>12</strong><em>+3 this week</em></span><span><small>Ready for handoff</small><strong>8</strong><em>Reviewed</em></span></div>
                <div class="activity-card"><small>Revenue</small><div class="activity-card__line" aria-hidden="true"></div><p>One comment is anchored to this component.</p></div>
                <div class="review-pin"><span>1</span><p><strong>Mina</strong><br />Make this count easier to scan.</p></div>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section class="signal-band" aria-label="Selene principles"><div class="shell signal-band__content"><span>React source is the artifact.</span><span>Local work needs no account.</span><span>Every handoff has context.</span></div></section>
      <section class="section" id="why-selene">
        <div class="shell">
          <p class="eyebrow">Designed for the work between idea and merge</p>
          <h2 class="section-title">A design workspace that speaks product, not mockup.</h2>
          <p class="section-intro">Keep the conversation close to the implementation. Selene helps designers review the states and flows people will actually use, then produces context developers can trust.</p>
          <div class="feature-grid">
            <article class="feature-card"><p class="feature-card__number">01</p><h3>Review the real states</h3><p>Navigate live React screens, inspect empty and busy states, and leave comments on stable UI nodes instead of an image.</p></article>
            <article class="feature-card"><p class="feature-card__number">02</p><h3>Choose your agent</h3><p>Bring a local or custom coding agent through a portable adapter protocol. The workspace stays yours when your tooling changes.</p></article>
            <article class="feature-card"><p class="feature-card__number">03</p><h3>Hand off with proof</h3><p>Record a review baseline, see what changed afterward, and give developers the directions and provenance behind a decision.</p></article>
          </div>
        </div>
      </section>
      <section class="section workflow-section" id="get-started">
        <div class="shell workflow-layout">
          <div><p class="eyebrow">Your first project</p><h2 class="section-title">From clone to a useful review in an afternoon.</h2><p class="section-intro">The web demo is an account-free way to see the core loop. When you are ready, run the same workspace locally and bring your own project context.</p><div class="button-row"><a class="button" href="./demo/">Open the guided demo <span aria-hidden="true">→</span></a><a class="button button--quiet" href="./docs/">Read the architecture</a></div></div>
          <ol class="onboarding-list" aria-label="Getting started steps">
            <li><span>1</span><div><strong>Start with a working screen</strong><p>Open the demo, switch between live states, and select a node you want to discuss.</p></div></li>
            <li><span>2</span><div><strong>Leave a decision, not a sticky note</strong><p>Add a node-level comment and a developer direction. Export the portable workspace when the review is ready.</p></div></li>
            <li><span>3</span><div><strong>Run Selene locally</strong><p>Clone the repository, install with Bun, and use the web or desktop workspace with no required hosted service.</p><code>bun install --frozen-lockfile<br />bun run dev:web</code></div></li>
          </ol>
        </div>
      </section>
      <section class="section closing-section"><div class="shell closing-card"><p class="eyebrow">Build a calmer handoff</p><h2>Make design decisions visible all the way to React.</h2><p>Explore the public demo, inspect the component system, or dig into the local-first architecture.</p><div class="button-row"><a class="button" href="./demo/">Open the demo <span aria-hidden="true">→</span></a><a class="button button--quiet" href="./storybook/">Browse components</a></div></div></section>
    `
  });
}

export function documentationIndexPage() {
  return shell({
    title: 'Selene documentation',
    description: 'Architecture and deployment documentation for the Selene local-first workspace.',
    current: 'docs',
    body: `
      <section class="docs-hero section"><div class="shell"><p class="eyebrow">Selene documentation</p><h1>Build with clear boundaries.</h1><p>Selene keeps design policy, local runtime behavior, collaboration, and extension contracts explicit. Start with the architecture overview, then follow the concern you are working on.</p></div></section>
      <section class="docs-links"><div class="shell"><a href="./architecture/README.md"><span>Architecture</span><strong>How the workspace is separated <b aria-hidden="true">→</b></strong></a><a href="./architecture/ADR-0001-local-first-headless-core.md"><span>ADR 0001</span><strong>Local-first, headless core <b aria-hidden="true">→</b></strong></a><a href="./architecture/ADR-0002-react-source-model.md"><span>ADR 0002</span><strong>React source as the design artifact <b aria-hidden="true">→</b></strong></a><a href="./architecture/ADR-0003-portable-agent-protocol.md"><span>ADR 0003</span><strong>Portable agent protocol <b aria-hidden="true">→</b></strong></a><a href="./architecture/ADR-0004-federated-design-inputs.md"><span>ADR 0004</span><strong>Federated design inputs <b aria-hidden="true">→</b></strong></a><a href="./architecture/ADR-0005-trust-boundaries.md"><span>ADR 0005</span><strong>Trust boundaries <b aria-hidden="true">→</b></strong></a></div></section>
    `
  });
}

export const pagesStyles = `
  ${siteStyles}
  .hero { overflow: hidden; padding-top: clamp(3.5rem, 8vw, 7rem); }
  .hero__grid { display: grid; grid-template-columns: minmax(0, .96fr) minmax(27rem, 1.04fr); align-items: center; gap: clamp(2.5rem, 6vw, 6rem); }
  h1 { max-width: 10ch; margin: 0; font-size: clamp(3.25rem, 7vw, 6.4rem); line-height: .93; letter-spacing: -.075em; }
  .hero__lede { max-width: 35rem; margin: 1.5rem 0; color: #435449; font-size: 1.15rem; line-height: 1.65; }
  .hero__note { margin: 1rem 0 0; color: #65756a; font-size: .84rem; }
  .product-frame { overflow: hidden; border: 1px solid #cdd4c8; border-radius: 1rem; background: #fff; box-shadow: 0 2rem 5rem rgb(22 34 28 / 16%); font-size: .72rem; transform: rotate(1.5deg); }
  .product-frame__topbar { display: flex; align-items: center; justify-content: space-between; gap: .5rem; padding: .85rem 1rem; border-bottom: 1px solid #e1e6dd; color: #68766c; }
  .window-dots { color: #dce3d8; letter-spacing: .15rem; white-space: nowrap; }
  .product-frame__status { padding: .25rem .45rem; border-radius: 999px; background: #e7f8bd; color: #34531f; font-weight: 700; }
  .product-frame__content { display: grid; grid-template-columns: 8.5rem 1fr; min-height: 25rem; }
  .product-frame aside { display: flex; flex-direction: column; gap: .85rem; padding: 1.15rem .85rem; background: #f1f3ee; color: #738076; }
  .product-frame aside strong { margin-bottom: .65rem; color: #26362b; }
  .product-frame aside span:first-of-type { padding: .5rem; border-radius: .35rem; background: #d9ff5d; color: #26362b; font-weight: 700; }
  .product-canvas { position: relative; padding: 1.5rem; background: #fbfcf9; }
  .product-canvas__heading { display: flex; align-items: start; justify-content: space-between; gap: .75rem; }
  .product-canvas__heading span { display: grid; gap: .25rem; }
  .product-canvas small { color: #78847a; font-size: .68rem; }
  .product-canvas strong { color: #1b2c21; font-size: 1.2rem; letter-spacing: -.04em; }
  .product-button { border-radius: .3rem; background: #17231d; color: #fff; padding: .45rem .6rem; }
  .metric-row { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin: 1.5rem 0 .75rem; }
  .metric-row span, .activity-card { display: grid; gap: .35rem; padding: .85rem; border: 1px solid #e1e7dd; border-radius: .55rem; background: #fff; }
  .metric-row strong { font-size: 1.65rem; }
  .metric-row em { color: #487144; font-size: .65rem; font-style: normal; }
  .activity-card { min-height: 8rem; }
  .activity-card__line { height: 2.5rem; margin-top: .5rem; border-radius: .3rem .3rem 0 0; background: linear-gradient(135deg, transparent 25%, #d9ff5d 25% 30%, transparent 30% 48%, #d9ff5d 48% 53%, transparent 53%), linear-gradient(#f1f4ee, #f1f4ee); }
  .activity-card p { margin: 0; color: #6b786d; }
  .review-pin { position: absolute; right: 1.75rem; bottom: 1.4rem; display: flex; align-items: start; gap: .5rem; width: 12rem; padding: .65rem; border: 1px solid #b8c6ad; border-radius: .45rem; background: #f7ffd9; box-shadow: 0 .5rem 1.5rem rgb(23 35 29 / 12%); }
  .review-pin span { display: grid; flex: 0 0 auto; width: 1.25rem; aspect-ratio: 1; place-items: center; border-radius: 50%; background: #17231d; color: #fff; font-weight: 700; }
  .review-pin p { margin: 0; color: #536156; line-height: 1.45; }
  .review-pin strong { font-size: .72rem; }
  .signal-band { border-block: 1px solid #d7ddd3; background: #e8ece4; }
  .signal-band__content { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; padding: 1.2rem 0; color: #3e5044; font-size: .86rem; font-weight: 700; text-align: center; }
  .feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin-top: 3rem; }
  .feature-card { min-height: 17rem; padding: 1.5rem; border-radius: .8rem; background: #e9ede5; }
  .feature-card:nth-child(2) { background: #17231d; color: #fff; }
  .feature-card__number { margin: 0 0 3rem; color: #6d7e71; font-size: .8rem; font-weight: 800; }
  .feature-card:nth-child(2) .feature-card__number { color: #d9ff5d; }
  .feature-card h3 { margin: 0; font-size: 1.45rem; letter-spacing: -.04em; }
  .feature-card p:last-child { color: #526157; line-height: 1.6; }
  .feature-card:nth-child(2) p:last-child { color: #d8e1d7; }
  .workflow-section { background: #e3ff8c; }
  .workflow-layout { display: grid; grid-template-columns: .9fr 1.1fr; gap: clamp(2rem, 7vw, 7rem); }
  .onboarding-list { display: grid; gap: 1rem; margin: 0; padding: 0; list-style: none; counter-reset: steps; }
  .onboarding-list li { display: grid; grid-template-columns: 2rem 1fr; gap: 1rem; padding: 1.2rem 0; border-top: 1px solid rgb(23 35 29 / 22%); }
  .onboarding-list li > span { display: grid; width: 1.7rem; height: 1.7rem; place-items: center; border-radius: 50%; background: #17231d; color: #fff; font-size: .75rem; font-weight: 800; }
  .onboarding-list strong { font-size: 1.15rem; letter-spacing: -.025em; }
  .onboarding-list p { margin: .45rem 0 0; color: #3c5240; line-height: 1.55; }
  code { display: block; margin-top: .85rem; padding: .7rem; overflow-x: auto; border-radius: .35rem; background: #17231d; color: #e7ff9f; font: .78rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .closing-section { padding-top: 4rem; }
  .closing-card { padding: clamp(2rem, 6vw, 4rem); border-radius: 1rem; background: #17231d; color: #fff; }
  .closing-card .eyebrow, .closing-card p { color: #cdd8cd; }
  .closing-card h2 { max-width: 17ch; margin: 0; font-size: clamp(2.2rem, 5vw, 4rem); line-height: .98; letter-spacing: -.065em; }
  .closing-card > p:not(.eyebrow) { max-width: 38rem; line-height: 1.6; }
  .closing-card .button { border-color: #d9ff5d; background: #d9ff5d; color: #17231d; }
  .closing-card .button--quiet { border-color: #fff; background: transparent; color: #fff; }
  .docs-hero { border-bottom: 1px solid #d7ddd3; }
  .docs-hero h1 { max-width: 15ch; }
  .docs-hero p:last-child { max-width: 43rem; margin: 1.4rem 0 0; color: #526157; font-size: 1.1rem; line-height: 1.65; }
  .docs-links { padding: 1.5rem 0 5rem; }
  .docs-links > div { display: grid; grid-template-columns: repeat(2, 1fr); border-top: 1px solid #d7ddd3; }
  .docs-links a { display: grid; gap: .45rem; min-height: 8rem; padding: 1.5rem; border-right: 1px solid #d7ddd3; border-bottom: 1px solid #d7ddd3; text-decoration: none; }
  .docs-links a:nth-child(2n) { border-right: 0; }
  .docs-links a:hover, .docs-links a:focus-visible { background: #e3ff8c; }
  .docs-links span { color: #607266; font-size: .75rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .docs-links strong { display: flex; justify-content: space-between; gap: 1rem; font-size: 1.15rem; letter-spacing: -.025em; }

  @media (max-width: 52rem) {
    .hero__grid, .workflow-layout { grid-template-columns: 1fr; }
    .product-frame { max-width: 36rem; transform: none; }
    .feature-grid { grid-template-columns: 1fr; }
    .feature-card { min-height: auto; }
    .feature-card__number { margin-bottom: 1.5rem; }
  }
  @media (max-width: 38rem) {
    .shell { width: min(100% - 1.25rem, 74rem); }
    h1 { font-size: clamp(3rem, 16vw, 4.75rem); }
    .signal-band__content { grid-template-columns: 1fr; }
    .product-frame__content { grid-template-columns: 6.5rem 1fr; }
    .product-canvas { padding: 1rem; }
    .review-pin { display: none; }
    .docs-links > div { grid-template-columns: 1fr; }
    .docs-links a, .docs-links a:nth-child(2n) { border-right: 0; }
  }
`;
