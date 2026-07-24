import { describe, expect, it } from 'vitest';

import {
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
