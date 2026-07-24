import { describe, expect, it } from 'vitest';

import {
  codeownersPatternMatches,
  maintainersFromGovernance,
  parseCodeowners,
  verifyGovernance
} from './verify-governance.mjs';

const governance = `# Governance

## Maintainers

The current maintainer is @selene-maintainer.

## Decisions

Changes are reviewed in a pull request. Follow the Code of Conduct and report vulnerabilities through SECURITY.md.
`;

const codeowners = `* @selene-maintainer
/.github/ @selene-maintainer
/CODE_OF_CONDUCT.md @selene-maintainer
/GOVERNANCE.md @selene-maintainer
/SECURITY.md @selene-maintainer
`;

describe('governance verifier', () => {
  it('accepts explicit repository and governance ownership', () => {
    expect(verifyGovernance({ codeowners, governance })).toEqual({
      entries: 5,
      maintainers: ['@selene-maintainer']
    });
  });

  it('parses whitespace and comments while normalizing owner order', () => {
    expect(parseCodeowners('# policy\n/docs/ @second @first\n')).toEqual([
      { pattern: '/docs/', owners: ['@first', '@second'] }
    ]);
    expect(maintainersFromGovernance(governance)).toEqual(['@selene-maintainer']);
  });

  it('uses the last matching CODEOWNERS rule, as GitHub does', () => {
    expect(codeownersPatternMatches('*.md', '/GOVERNANCE.md')).toBe(true);
    expect(codeownersPatternMatches('/.github/', '/.github/workflows/ci.yml')).toBe(true);
    expect(codeownersPatternMatches('/.github/', '/GOVERNANCE.md')).toBe(false);

    const twoMaintainerGovernance = governance.replace('@selene-maintainer', '@first and @second');
    const twoMaintainerCodeowners = `${codeowners.replaceAll(
      '@selene-maintainer',
      '@first @second'
    )}/GOVERNANCE.md @first\n`;
    expect(() =>
      verifyGovernance({ codeowners: twoMaintainerCodeowners, governance: twoMaintainerGovernance })
    ).toThrow('Effective CODEOWNERS rule for /GOVERNANCE.md must name every governance maintainer');
  });

  it('rejects a missing protected policy rule, unknown owner, and malformed source', () => {
    expect(() =>
      verifyGovernance({
        codeowners: codeowners.replace('/SECURITY.md @selene-maintainer\n', ''),
        governance
      })
    ).toThrow('must explicitly protect /SECURITY.md');
    expect(() =>
      verifyGovernance({
        codeowners: codeowners.replaceAll('@selene-maintainer', '@other'),
        governance
      })
    ).toThrow('is not listed under GOVERNANCE.md maintainers');
    expect(() => parseCodeowners('* maintainer\n')).toThrow('invalid owner');
  });
});
