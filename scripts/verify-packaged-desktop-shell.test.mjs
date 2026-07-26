import { describe, expect, it } from 'vitest';

import { rendererStylesheetPaths } from './verify-packaged-desktop-shell.mjs';

const archiveEntries = Object.freeze([
  '/out/renderer/index.html',
  '/out/renderer/assets/index-9a3c1d.css'
]);
const stylesheetLink = (href) => `<link rel="stylesheet" href="${href}">`;

describe('packaged desktop shell stylesheet paths', () => {
  it('resolves a real leading-slash ASAR out/renderer stylesheet entry', () => {
    expect(
      rendererStylesheetPaths(stylesheetLink('./assets/index-9a3c1d.css'), archiveEntries)
    ).toEqual(['out/renderer/assets/index-9a3c1d.css']);
  });

  it.each([
    '../foo.css',
    '/foo.css',
    'assets\\foo.css',
    'assets/%2e%2e/foo.css',
    'assets/index-9a3c1d.css?cache=1',
    'assets/index-9a3c1d.css#fragment',
    'https://example.invalid/shell.css'
  ])('rejects non-relative renderer stylesheet link %s', (href) => {
    expect(() => rendererStylesheetPaths(stylesheetLink(href), archiveEntries)).toThrow();
  });
});
