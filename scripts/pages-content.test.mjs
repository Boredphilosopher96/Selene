import { describe, expect, it } from 'vitest';

import { documentationIndexPage, pagesStyles, publicLandingPage } from './pages-content.mjs';

describe('public Pages content', () => {
  it('gives the landing page a usable shell and first-project onboarding path', () => {
    const page = publicLandingPage();

    expect(page).toContain('<nav class="site-nav" aria-label="Primary navigation">');
    expect(page).toContain('href="./demo/"');
    expect(page).toContain('href="./storybook/"');
    expect(page).toContain('href="./docs/"');
    expect(page).toContain('id="get-started"');
    expect(page).toContain('Your first project');
    expect(page).toContain('point or region');
    expect(page).toContain('Keep review and AI direction distinct');
    expect(page).not.toContain('node-level comment');
    expect(page).toContain('bun run dev:web');
    expect(page).toContain('Skip to content');
    expect(page).toContain('Selene is open source and local-first.');
  });

  it('makes the deployed documentation discoverable from the same public shell', () => {
    const page = documentationIndexPage();

    expect(page).toContain('<title>Selene documentation</title>');
    expect(page).toContain('aria-current="page" href="./">Docs</a>');
    expect(page).toContain('./architecture/README.md');
    expect(page).toContain('./architecture/ADR-0005-trust-boundaries.md');
    expect(page).toContain('Skip to content');
  });

  it('keeps responsive and keyboard-visible affordances in the public shell', () => {
    expect(pagesStyles).toContain('.skip-link:focus');
    expect(pagesStyles).toContain('@media (max-width: 38rem)');
    expect(pagesStyles).toContain('.site-header { position: sticky');
  });
});
