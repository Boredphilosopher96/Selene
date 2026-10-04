import { parsePrototypeGraph, prototypeGraphFixture, serializeCanonicalData } from '@selene/core';
import { describe, expect, it } from 'vitest';

import { validatePublicPrototypeGraph } from './generated-publication-privacy';

describe('public graph export privacy', () => {
  it('preserves meaningful ownership and exact safe graph bytes', () => {
    const graph = parsePrototypeGraph({
      ...prototypeGraphFixture,
      project: { ...prototypeGraphFixture.project, owner: 'Travel design team' },
      fixtures: { fare: '$90', tokenMode: 'semantic', password: '' }
    });
    const original = serializeCanonicalData(graph);
    expect(validatePublicPrototypeGraph(graph)).toBe(graph);
    expect(graph.project.owner).toBe('Travel design team');
    expect(serializeCanonicalData(graph)).toBe(original);
  });

  it.each([
    '/Users/private/design.md',
    '/home/private/design.md',
    'file:///private/design.md',
    'C:\\Users\\private\\design.md',
    'sk-proj-' + 'a'.repeat(32),
    'ghp_' + 'a'.repeat(36),
    'github_pat_' + 'a'.repeat(40),
    'xoxb-' + '123456789012-'.repeat(2) + 'abcdefghijklmnop',
    'AKIA' + 'A'.repeat(16),
    'Bearer ' + 'a'.repeat(32),
    '-----BEGIN PRIVATE KEY-----',
    'api_key=private-credential'
  ])('rejects unsafe graph metadata without reflecting its value: %s', (value) => {
    const base = prototypeGraphFixture;
    const graphs = [
      { ...base, project: { ...base.project, owner: value } },
      { ...base, revision: { ...base.revision, summary: value } },
      { ...base, handoff: { ...base.handoff, owner: value } },
      { ...base, fixtures: { metadata: { description: value } } },
      {
        ...base,
        nodes: base.nodes.map((node, index) =>
          index === 0
            ? {
                ...node,
                ports: node.ports.map((port, portIndex) =>
                  portIndex === 0 ? { ...port, label: value } : port
                )
              }
            : node
        )
      }
    ];
    for (const graph of graphs) {
      const valid = parsePrototypeGraph(graph);
      expect(() => validatePublicPrototypeGraph(valid)).toThrow(
        'Public prototype graph contains private metadata or credentials.'
      );
    }
  });

  it('rejects structured credential values and private fixture keys', () => {
    for (const fixtures of [
      { apiKey: 'private-value' },
      { nested: { client_secret: 'private-value' } },
      { '/Users/private': 'fixture' }
    ])
      expect(() =>
        validatePublicPrototypeGraph(parsePrototypeGraph({ ...prototypeGraphFixture, fixtures }))
      ).toThrow('private metadata or credentials');
  });
});
