import { describe, expect, it } from 'vitest';

import { createPreviewSecurityPolicy } from './preview-adapter';
import {
  StoryPreviewAuthority,
  UnconfiguredStoryPreviewBuildPort,
  type StoryPreviewBuildPort,
  type StoryPreviewIdentity
} from './story-preview-authority';

function catalog(revision = 'catalog-r1') {
  return {
    format: 'selene-component-catalog/v1',
    schemaVersion: '1.0',
    projectId: 'orders',
    provenance: {
      generator: 'selene-test',
      revision,
      generatedAt: '2026-07-24T00:00:00.000Z'
    },
    builtFromPrototypeRevision: 'orders-r1',
    designSystem: [
      {
        packageName: '@selene/ui',
        version: '1.0.0',
        tokenSource: '@selene/tokens@1.0.0'
      }
    ],
    storybook: {
      url: 'https://private.example.test/storybook',
      outputDirectory: '/private/storybook-static',
      buildId: `${revision}-build`
    },
    components: [
      {
        id: 'order-card',
        owner: 'orders-design',
        source: {
          path: '/private/src/OrderCard.tsx',
          exportName: 'OrderCard',
          revision: 'orders-r1'
        },
        props: [{ name: 'disabled', type: 'boolean', required: false }],
        requiredCoverage: ['disabled', 'accessibility'],
        stories: [
          {
            id: 'order-card-default',
            file: '/private/src/OrderCard.stories.tsx',
            exportName: 'Default',
            coverage: ['accessibility']
          },
          {
            id: 'order-card-disabled',
            file: '/private/src/OrderCard.stories.tsx',
            exportName: 'Disabled',
            coverage: ['disabled']
          }
        ]
      }
    ]
  };
}

const identity: StoryPreviewIdentity = {
  projectId: 'orders',
  sourceRevisionId: 'orders-r1',
  catalogRevision: 'catalog-r1',
  buildId: 'catalog-r1-build',
  componentId: 'order-card',
  storyId: 'order-card-default'
};

function published(identityValue: StoryPreviewIdentity) {
  const policy = createPreviewSecurityPolicy('selene-preview://local', 'n'.repeat(24));
  return {
    url: `selene-preview://local/${identityValue.storyId}/index.html`,
    revisionId: `${identityValue.buildId}:${identityValue.storyId}`,
    policy
  };
}

function supportedBuilder(): StoryPreviewBuildPort {
  return {
    supports: () => true,
    build: async (identityValue) => published(identityValue)
  };
}

function deterministicCapabilityIds(): () => string {
  let next = 0;
  return () => String((next += 1)).padStart(32, '0');
}

describe('StoryPreviewAuthority', () => {
  it('issues one stable exact-bound capability and publishes only redacted identity', async () => {
    const authority = new StoryPreviewAuthority({ current: () => catalog() }, supportedBuilder(), {
      capabilityId: deterministicCapabilityIds()
    });

    const ticket = authority.issue(identity);
    expect(ticket).toBeDefined();
    expect(authority.issue(identity)).toEqual(ticket);
    const result = await authority.build(4, ticket);

    expect(result).toMatchObject({
      projectId: 'orders',
      sourceRevisionId: 'orders-r1',
      catalogRevision: 'catalog-r1',
      buildId: 'catalog-r1-build',
      componentId: 'order-card',
      storyId: 'order-card-default'
    });
    expect(JSON.stringify(result)).not.toContain('capabilityId');
    expect(JSON.stringify(ticket)).not.toContain('/private/');
    expect(JSON.stringify(ticket)).not.toContain('private.example.test');
  });

  it('rejects token or identity tampering and catalog drift', async () => {
    let current = catalog();
    const authority = new StoryPreviewAuthority({ current: () => current }, supportedBuilder(), {
      capabilityId: deterministicCapabilityIds()
    });
    const ticket = authority.issue(identity);
    if (ticket === undefined) throw new Error('fixture capability was not issued');

    await expect(authority.build(1, { ...ticket, storyId: 'order-card-disabled' })).rejects.toThrow(
      'invalid or stale'
    );
    await expect(authority.build(1, { ...ticket, capabilityId: 'z'.repeat(32) })).rejects.toThrow(
      'invalid or stale'
    );

    current = catalog('catalog-r2');
    await expect(authority.build(1, ticket)).rejects.toThrow('invalid or stale');
  });

  it('does not issue renderer authority without a configured trusted builder', () => {
    const authority = new StoryPreviewAuthority(
      { current: () => catalog() },
      new UnconfiguredStoryPreviewBuildPort()
    );

    expect(authority.issue(identity)).toBeUndefined();
  });

  it('revokes least-recently-issued capabilities at the configured bound', async () => {
    const authority = new StoryPreviewAuthority({ current: () => catalog() }, supportedBuilder(), {
      maximumCapabilities: 1,
      capabilityId: deterministicCapabilityIds()
    });
    const first = authority.issue(identity);
    const second = authority.issue({ ...identity, storyId: 'order-card-disabled' });
    if (first === undefined || second === undefined)
      throw new Error('fixture capabilities were not issued');

    await expect(authority.build(1, first)).rejects.toThrow('invalid or stale');
    await expect(authority.build(1, second)).resolves.toMatchObject({
      storyId: 'order-card-disabled'
    });
  });
});
