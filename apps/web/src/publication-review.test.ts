import { createHash, webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import {
  createGeneratedDesignHandoff,
  serializeCanonicalData,
  type ReactSourceWorkspace
} from '@selene/core';

import { loadPublicationReview, publicationReviewRequestFromUrl } from './publication-review';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const pageUrl = 'https://review.example.test/review/';

function fixture() {
  const source: ReactSourceWorkspace = {
    format: 'selene-react-workspace/v1',
    projectId: 'travel-demo',
    entrypoint: 'src/Travel.tsx',
    files: [
      {
        path: 'src/Travel.tsx',
        language: 'tsx',
        content:
          'export default function Travel(){return <main data-selene-node-id="travel.root">Travel home</main>;}'
      }
    ],
    dependencies: ['react', 'react-dom'],
    nodes: [{ nodeId: 'travel.root', path: 'src/Travel.tsx', exportName: 'default' }],
    revision: {
      id: 'travel-source-r9',
      createdAt: '2026-09-30T00:00:00Z',
      summary: 'Travel source'
    }
  };
  const baseline = {
    projectId: source.projectId,
    readiness: 'draft' as const,
    currency: 'none' as const,
    approvalsStale: false,
    changesSinceBaseline: []
  };
  const lock = '{"lockfileVersion":1}\n';
  const lockDigest = sha(lock);
  const reference = {
    format: 'selene-canonical-story-reference/v1' as const,
    projectId: source.projectId,
    catalogRevision: 'catalog-travel-r9',
    buildId: 'storybook-travel-r9',
    componentId: 'Travel',
    storyId: 'Travel--default'
  };
  const handoff = createGeneratedDesignHandoff({
    workspace: source,
    baseline,
    comments: [],
    developerDirections: ['Recheck the travel fare.'],
    scenarios: [],
    reproducibility: {
      packageManager: 'bun@1.3.14',
      lockfile: { path: 'bun.lock', checksum: lockDigest },
      packages: [],
      dependencies: [{ name: 'react', version: '19.2.8' }]
    },
    project: {
      id: source.projectId,
      owner: 'Travel',
      status: 'draft',
      routes: ['/'],
      storybook: [{ component: 'Travel', url: './storybook/' }],
      storyReferences: [reference],
      acceptanceCriteria: ['Verify travel navigation.']
    },
    agentInstructions: ['Treat this as a draft handoff.']
  });
  const graph = {
    id: 'travel-flow',
    name: 'Travel checkout',
    initialNodeId: 'home',
    nodes: [{ id: 'home', label: 'Travel home', kind: 'screen', route: '/', ports: [] }],
    transitions: [],
    scenarios: [
      { id: 'book-trip', name: 'Book a trip', startNodeId: 'home', expectedPath: ['home'] }
    ]
  };
  const catalog = {
    format: 'selene-component-catalog/v1',
    schemaVersion: '1.0',
    projectId: source.projectId,
    provenance: {
      generator: 'selene-bun-vite-react/v1',
      revision: reference.catalogRevision,
      generatedAt: source.revision.createdAt
    },
    builtFromPrototypeRevision: source.revision.id,
    designSystem: [
      {
        packageName: '@selene/local-project',
        version: '0.0.0',
        tokenSource: 'canonical-react-workspace'
      }
    ],
    storybook: {
      url: './storybook/',
      outputDirectory: 'storybook-static',
      buildId: reference.buildId
    },
    components: [
      {
        id: 'Travel',
        owner: 'Travel',
        source: {
          path: source.entrypoint,
          exportName: 'default',
          revision: source.revision.id,
          checksum: sha(source.files[0]!.content)
        },
        props: [],
        requiredCoverage: ['responsive', 'accessibility'],
        stories: [
          {
            id: reference.storyId,
            file: 'src/Travel.stories.tsx',
            exportName: 'Default',
            coverage: ['responsive', 'accessibility']
          }
        ]
      }
    ]
  };
  const bundleDigest = 'a'.repeat(64);
  const blobs = new Map<string, string>();
  const artifactTexts = {
    handoff: json(handoff),
    package: json({
      packageManager: 'bun@1.3.14',
      dependencies: { react: '19.2.8' },
      devDependencies: {}
    }),
    lockfile: lock,
    prototype: json(graph),
    catalog: json(catalog),
    provenance: json({
      format: 'selene-generated-package-provenance/v1',
      bundleDigest,
      sourceRevisionId: source.revision.id,
      graphRevision: 7,
      commit: null
    })
  };
  const artifacts = Object.entries(artifactTexts).map(([kind, content]) => {
    const checksum = sha(content);
    const href =
      'review/artifacts/' + kind + '-' + checksum + '.' + (kind === 'lockfile' ? 'lock' : 'json');
    blobs.set('https://review.example.test/travel/' + href, content);
    return { kind, href, sha256: checksum, bytes: Buffer.byteLength(content) };
  });
  const manifest = {
    format: 'selene-public-review-manifest/v1',
    projectId: source.projectId,
    immutableId: 'bundle-sha256-' + bundleDigest,
    bundleDigest,
    sourceRevisionId: source.revision.id,
    sourceSha256: sha(serializeCanonicalData(JSON.parse(handoff.source))),
    graphRevision: 7,
    graphRevisionId: 'travel-flow-r7',
    graphSha256: null,
    baseline,
    graph,
    compilation: null,
    bindingIncluded: false,
    handoffStatus: 'draft',
    independentAcceptance: false,
    build: {
      commit: null,
      bundleDigest,
      sourceRevisionId: source.revision.id,
      graphRevision: 7,
      lockfileSha256: lockDigest,
      bunVersion: '1.3.14'
    },
    artifacts
  };
  const manifestUrl = 'https://review.example.test/travel/review/manifest.json';
  const text = json(manifest);
  blobs.set(manifestUrl, text);
  const calls: RequestInit[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(init ?? {});
    const value = blobs.get(String(input));
    return new Response(value ?? 'Missing', { status: value === undefined ? 404 : 200 });
  };
  return {
    manifest,
    manifestUrl,
    blobs,
    calls,
    fetch,
    request: { manifestUrl, manifestSha256: sha(text) }
  };
}

describe('arbitrary publication review boundary', () => {
  it('loads a checksum-pinned Travel manifest and exact portable artifacts without identity credentials', async () => {
    const data = fixture();
    const review = await loadPublicationReview(data.request, {
      pageUrl,
      fetch: data.fetch,
      crypto: webcrypto as Crypto
    });
    expect(review).toMatchObject({
      projectId: 'travel-demo',
      sourceRevisionId: 'travel-source-r9',
      graphRevision: 7,
      binding: 'unavailable',
      baseUrl: 'https://review.example.test/travel/'
    });
    expect(review.scenarios).toEqual([{ id: 'book-trip', name: 'Book a trip' }]);
    expect(review.artifacts).toHaveLength(6);
    expect(review.source.files[0]?.content).toContain('Travel home');
    expect(
      data.calls.every((call) => call.credentials === 'omit' && call.redirect === 'error')
    ).toBe(true);
  });
  it('rejects changed bytes and caller-unpinned or unapproved manifest origins', async () => {
    const data = fixture();
    const artifact = data.manifest.artifacts[0]!;
    data.blobs.set('https://review.example.test/travel/' + artifact.href, 'tampered');
    await expect(
      loadPublicationReview(data.request, {
        pageUrl,
        fetch: data.fetch,
        crypto: webcrypto as Crypto
      })
    ).rejects.toThrow();
    expect(() =>
      publicationReviewRequestFromUrl(pageUrl + '?publication=/travel/review/manifest.json')
    ).toThrow();
    expect(() =>
      publicationReviewRequestFromUrl(
        pageUrl +
          '?publication=https://other.example.test/review/manifest.json&digest=' +
          'a'.repeat(64)
      )
    ).toThrow();
    expect(
      publicationReviewRequestFromUrl(
        pageUrl + '?publication=/travel/review/manifest.json&digest=' + 'a'.repeat(64)
      )
    ).toEqual({
      manifestUrl: 'https://review.example.test/travel/review/manifest.json',
      manifestSha256: 'a'.repeat(64)
    });
  });
  it('rejects public host locations, forged binding claims and a cross-project catalog', async () => {
    for (const mutate of [
      (manifest: ReturnType<typeof fixture>['manifest']) => ({
        ...manifest,
        graph: { ...manifest.graph, name: '/Users/private/Travel' }
      }),
      (manifest: ReturnType<typeof fixture>['manifest']) => ({
        ...manifest,
        bindingIncluded: true,
        handoffStatus: 'compiler-bound'
      })
    ]) {
      const data = fixture();
      const content = json(mutate(data.manifest));
      data.blobs.set(data.manifestUrl, content);
      // oxlint-disable-next-line no-await-in-loop -- Check each distinct hostile manifest independently.
      await expect(
        loadPublicationReview(
          { manifestUrl: data.manifestUrl, manifestSha256: sha(content) },
          { pageUrl, fetch: data.fetch, crypto: webcrypto as Crypto }
        )
      ).rejects.toThrow();
    }
    const data = fixture();
    const artifact = data.manifest.artifacts.find((item) => item.kind === 'catalog')!;
    const oldUrl = 'https://review.example.test/travel/' + artifact.href;
    const catalog = JSON.parse(data.blobs.get(oldUrl)!);
    catalog.projectId = 'another-project';
    const content = json(catalog);
    const checksum = sha(content);
    artifact.href = 'review/artifacts/catalog-' + checksum + '.json';
    artifact.sha256 = checksum;
    artifact.bytes = Buffer.byteLength(content);
    data.blobs.set('https://review.example.test/travel/' + artifact.href, content);
    const manifest = json(data.manifest);
    data.blobs.set(data.manifestUrl, manifest);
    await expect(
      loadPublicationReview(
        { manifestUrl: data.manifestUrl, manifestSha256: sha(manifest) },
        { pageUrl, fetch: data.fetch, crypto: webcrypto as Crypto }
      )
    ).rejects.toThrow();
  });
});
