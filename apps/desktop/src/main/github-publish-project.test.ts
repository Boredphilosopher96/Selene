import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  parseGeneratedDesignHandoff,
  prototypeGraphFixture,
  type ReactSourceWorkspace
} from '@selene/core';

import { createImmutablePublishBundle } from './designer-host-ports';
import { createInitialWorkspace } from './designer-service';
import {
  BunViteReactGeneratedProjectTemplate,
  generatedProjectFilePlanDigest
} from './generated-project-template';
import { createEmbeddedGeneratedProjectToolchainPort } from './generated-project-toolchain';
import { MktempGeneratedProjectMaterializer } from './generated-project-materializer';
import type { GeneratedProjectLockPort } from './generated-project-lock';
import {
  GitHubGeneratedProjectPublishAdapter,
  type GitHubProjectPublishTransport,
  type GitHubCommitRecord,
  type GitHubTreeRecord,
  type GitHubRefRecord,
  type GitHubPullRequestRecord
} from './github-publish';
import {
  createHostedProjectPublicationArtifact,
  generatedProjectPublicationOutputs
} from './github-publish-project';
import { issueReactBindingCompilerEvidence } from './react-binding-evidence';
import { ViteReactCompilerPort } from './react-compiler';
import { generatedReviewFiles } from './generated-review-template';
import { generatedPrototypeFiles } from './generated-prototype-template';

function publication(projectId = 'travel-2026') {
  const source = createInitialWorkspace(projectId);
  const graph = {
    ...prototypeGraphFixture,
    project: { ...prototypeGraphFixture.project, projectId }
  };
  const bundle = createImmutablePublishBundle({
    projectId,
    source,
    prototype: { graph, revision: 7 },
    scenarios: [],
    collaborationSnapshot: JSON.stringify({
      format: 'selene-collaboration/v2',
      project: { id: projectId, organizationId: 'local', name: 'Travel' },
      revisions: [],
      threads: [],
      comments: [],
      reactions: [],
      approvals: [],
      reviewThreads: [],
      aiChangeRequests: [],
      developerAnnotations: []
    }),
    designInputProvenance: {
      format: 'selene-desktop-current-workspace-design-inputs/v1',
      projectId
    },
    componentCatalog: {
      manifest: {
        format: 'selene-component-catalog-projection/v1',
        state: 'unavailable',
        reason: 'NOT_CONFIGURED'
      },
      entries: []
    },
    packageProvenance: {
      packageManager: 'bun@1.3.14',
      lockfile: { path: 'bun.lock', checksum: 'a'.repeat(64) },
      packages: [],
      dependencies: []
    }
  });
  return {
    bundle,
    plan: new BunViteReactGeneratedProjectTemplate(
      createEmbeddedGeneratedProjectToolchainPort()
    ).create(bundle)
  };
}

function gitTransport(projectId: string) {
  const blobMap = new Map<string, Buffer>();
  const treeMap = new Map<string, GitHubTreeRecord>();
  const commitMap = new Map<string, GitHubCommitRecord>();
  const refs = new Map<string, GitHubRefRecord>();
  const calls: string[] = [];
  const digest = (text: string) => createHash('sha1').update(text).digest('hex');
  const blobDigest = (bytes: Buffer) =>
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const marker = Buffer.from(
    JSON.stringify({
      format: 'selene-generated-project-ownership/v1',
      projectId,
      bundleDigest: 'a'.repeat(64),
      filePlanDigest: 'b'.repeat(64),
      lockDigest: 'c'.repeat(64),
      artifactDigest: 'd'.repeat(64)
    })
  );
  const markerSha = blobDigest(marker);
  blobMap.set(markerSha, marker);
  const baseTree = {
    sha: '2'.repeat(40),
    tree: [{ path: 'SELENE_OWNERSHIP.json', mode: '100644', type: 'blob', sha: markerSha }]
  };
  const base = { sha: '1'.repeat(40), tree: { sha: baseTree.sha }, parents: [] };
  treeMap.set(baseTree.sha, baseTree);
  commitMap.set(base.sha, base);
  const ref = (name: string, sha: string): GitHubRefRecord => ({
    ref: 'refs/' + name,
    object: {
      sha,
      type: 'commit',
      url: 'https://api.github.com/repos/Travel/Prototype/git/commits/' + sha
    }
  });
  refs.set('heads/main', ref('heads/main', base.sha));
  let pull: GitHubPullRequestRecord | undefined;
  const port: GitHubProjectPublishTransport = {
    async setup() {
      throw new Error('Provisioning must not run.');
    },
    async readRepository() {
      return { full_name: 'Travel/Prototype', default_branch: 'main', private: true };
    },
    async createRepository() {
      throw new Error('Provisioning must not run.');
    },
    async createBlob(_repository, content) {
      const bytes = Buffer.from(content, 'base64');
      const sha = blobDigest(bytes);
      blobMap.set(sha, bytes);
      return { sha };
    },
    async createTree(_repository, body) {
      const sha = digest(JSON.stringify(body));
      const tree = { sha, tree: [...body.tree] };
      treeMap.set(sha, tree);
      return tree;
    },
    async createCommit(_repository, body) {
      const sha = digest(JSON.stringify(body));
      const commit = {
        sha,
        tree: { sha: body.tree },
        parents: body.parents.map((parent) => ({ sha: parent }))
      };
      commitMap.set(sha, commit);
      return commit;
    },
    async readCommit(_repository, sha) {
      const value = commitMap.get(sha);
      if (!value) throw new Error('Missing commit');
      return value;
    },
    async readRecursiveTree(_repository, sha) {
      const value = treeMap.get(sha);
      if (!value) throw new Error('Missing tree');
      return value;
    },
    async readBlob(_repository, sha) {
      const value = blobMap.get(sha);
      if (!value) throw new Error('Missing blob');
      return value;
    },
    async readRef(_repository, name) {
      calls.push('read:' + name);
      if (!name.startsWith('heads/')) throw new Error('Transport requires heads/ ref');
      const value = refs.get(name);
      if (!value) throw new Error('Missing ref');
      return value;
    },
    async listHeads() {
      return [...refs.values()];
    },
    async createRef(_repository, name, sha) {
      calls.push('create:' + name);
      if (!name.startsWith('heads/')) throw new Error('Transport requires heads/ ref');
      refs.set(name, ref(name, sha));
    },
    async readPullRequest() {
      return pull;
    },
    async createDraftPullRequest(_repository, body) {
      const current = refs.get('heads/' + body.head);
      if (!current) throw new Error('Missing PR branch');
      pull = {
        html_url: 'https://github.com/Travel/Prototype/pull/7',
        title: body.title,
        body: body.body,
        draft: true,
        state: 'open',
        head: { ref: body.head, sha: current.object.sha },
        base: { ref: body.base }
      };
      return pull;
    }
  };
  return { port, calls, blobMap, treeMap };
}

describe('arbitrary generated project publication', () => {
  it('exports compiler binding only after a real Vite build and rejects tampered compiler payloads', async () => {
    const original = publication('bound-travel');
    const source: ReactSourceWorkspace = {
      format: 'selene-react-workspace/v1',
      projectId: 'bound-travel',
      entrypoint: 'src/Travel.tsx',
      files: [
        {
          path: 'src/Travel.tsx',
          language: 'tsx',
          content:
            'export default function Travel(){return <main data-selene-node-id="travel.root"><h1>Travel home</h1></main>;}'
        }
      ],
      dependencies: ['react', 'react-dom'],
      nodes: [{ nodeId: 'travel.root', path: 'src/Travel.tsx', exportName: 'default' }],
      revision: {
        id: 'travel-source-r1',
        createdAt: '2026-09-30T00:00:00Z',
        summary: 'Travel homepage'
      }
    };
    const initial = original.bundle.prototype.graph.nodes.find(
      (node) => node.id === original.bundle.prototype.graph.initialNodeId
    )!;
    const graph = {
      ...original.bundle.prototype.graph,
      nodes: [{ ...initial, ports: [] }],
      transitions: [],
      scenarios: [
        {
          id: 'travel.home',
          name: 'Travel home',
          startNodeId: initial.id,
          expectedPath: [initial.id]
        }
      ]
    };
    const build = await new ViteReactCompilerPort().compile(source);
    expect(build.diagnostics).toEqual([]);
    expect(build.receipt?.sourceRevisionId).toBe(source.revision.id);
    const compilerEvidence = issueReactBindingCompilerEvidence(source, build.receipt!);
    const reactBinding = {
      format: 'selene-react-binding-manifest/v1' as const,
      schemaVersion: '2.0' as const,
      projectId: source.projectId,
      sourceRevisionId: source.revision.id,
      graphId: graph.id,
      graphRevision: 7,
      nodeBindings: [{ graphNodeId: graph.initialNodeId, sourceNodeId: 'travel.root' }],
      actionBindings: []
    };
    const input = {
      ...original.bundle,
      source,
      prototype: { graph, revision: 7 },
      compiledArtifact: { build, compilerEvidence, reactBinding }
    };
    // Select input fields; derived bundle digests are never accepted as a fresh input.
    const bundle = createImmutablePublishBundle({
      projectId: input.projectId,
      source,
      prototype: input.prototype,
      scenarios: input.scenarios,
      collaborationSnapshot: input.collaborationSnapshot,
      designInputProvenance: input.designInputProvenance,
      componentCatalog: input.componentCatalog,
      packageProvenance: input.packageProvenance,
      compiledArtifact: input.compiledArtifact
    });
    const plan = new BunViteReactGeneratedProjectTemplate(
      createEmbeddedGeneratedProjectToolchainPort()
    ).create(bundle);
    const seed = JSON.parse(
      plan.files.find((file) => file.path === 'selene/review-seed.json')!.content
    );
    const handoff = parseGeneratedDesignHandoff(JSON.stringify(seed.handoff));
    expect(handoff.reactBinding).toEqual(reactBinding);
    expect(seed.compilation.compilerEvidence.sourceSha256).toBe(build.receipt!.sourceSha256);
    expect(JSON.parse(handoff.source)).toEqual(source);
    expect(seed.compilation).not.toHaveProperty('sourceMap');
    expect(seed.compilation).not.toHaveProperty('code');
    expect(
      generatedProjectPublicationOutputs(bundle, plan, 'Travel/Prototype', '1'.repeat(40))
    ).toMatchObject({ handoffStatus: 'compiler-bound', bindingIncluded: true });
    const inputFields = {
      projectId: bundle.projectId,
      source: bundle.source,
      prototype: bundle.prototype,
      scenarios: bundle.scenarios,
      collaborationSnapshot: bundle.collaborationSnapshot,
      designInputProvenance: bundle.designInputProvenance,
      componentCatalog: bundle.componentCatalog,
      packageProvenance: bundle.packageProvenance
    };
    // These graphs remain compiler-bound: only non-executable metadata differs.
    for (const privateGraph of [
      { ...graph, project: { ...graph.project, owner: '/Users/private/design.md' } },
      { ...graph, revision: { ...graph.revision, summary: 'file:///private/design.md' } },
      { ...graph, fixtures: { metadata: '/home/private/design.md' } },
      { ...graph, fixtures: { apiKey: 'private-value' } }
    ]) {
      const privateBundle = createImmutablePublishBundle({
        ...inputFields,
        prototype: { graph: privateGraph, revision: 7 },
        compiledArtifact: input.compiledArtifact
      });
      expect(privateBundle.compiledArtifact?.reactBinding).toEqual(reactBinding);
      const template = new BunViteReactGeneratedProjectTemplate(
        createEmbeddedGeneratedProjectToolchainPort()
      );
      expect(() => template.create(privateBundle)).toThrow('private metadata or credentials');
      expect(() => generatedReviewFiles(privateBundle, plan.toolchain)).toThrow(
        'private metadata or credentials'
      );
      expect(() => generatedPrototypeFiles(privateBundle, 'import App from "../Travel";')).toThrow(
        'private metadata or credentials'
      );
      expect(() => createHostedProjectPublicationArtifact(privateBundle, plan)).toThrow(
        'private metadata or credentials'
      );
    }
    expect(() =>
      createImmutablePublishBundle({
        ...inputFields,
        compiledArtifact: {
          ...input.compiledArtifact,
          build: { ...build, code: build.code + '\n// tampered' }
        }
      })
    ).toThrow('compiler artifact');
    expect(() =>
      createImmutablePublishBundle({
        ...inputFields,
        compiledArtifact: {
          ...input.compiledArtifact,
          reactBinding: { ...reactBinding, graphRevision: 8 }
        }
      })
    ).toThrow('graph revision');
    expect(() =>
      createImmutablePublishBundle({
        ...inputFields,
        compiledArtifact: {
          ...input.compiledArtifact,
          compilerEvidence: {
            ...compilerEvidence,
            nodeMarkers: compilerEvidence.nodeMarkers.map((marker) => ({
              ...marker,
              guards: [{ surface: 'node' as const, operator: 'equals' as const, value: 'invented' }]
            }))
          }
        }
      })
    ).toThrow();
  });
  it('commits the sealed project bytes and heads-prefixed ref while reporting prepared static output', async () => {
    const { bundle, plan } = publication();
    const parent = await mkdtemp(join(tmpdir(), 'selene-publication-test-'));
    const materializer = new MktempGeneratedProjectMaterializer(parent);
    const lockBytes = Buffer.from('{"lockfileVersion":1}\n');
    const lockDigest = createHash('sha256').update(lockBytes).digest('hex');
    const artifactDigest = createHash('sha256')
      .update(`${bundle.bundleDigest}\0${plan.filePlanDigest}\0${lockDigest}`)
      .digest('hex');
    const lock: GeneratedProjectLockPort = {
      async resolve(lease) {
        await writeFile(join(lease.root, 'bun.lock'), lockBytes, { flag: 'wx' });
        return {
          lockBytes: lockBytes.length,
          lockDigest,
          artifactDigest,
          filePlanDigest: plan.filePlanDigest
        };
      }
    };
    const github = gitTransport(bundle.projectId);
    try {
      const receipt = await new GitHubGeneratedProjectPublishAdapter(
        materializer,
        lock,
        github.port
      ).publish(
        {
          mode: 'github-remote',
          repository: 'Travel/Prototype',
          title: 'Travel revision',
          bundle,
          plan
        },
        { signal: new AbortController().signal, progress: () => undefined }
      );
      expect(receipt.mode).toBe('github-remote');
      if (receipt.mode !== 'github-remote') throw new Error('Missing remote receipt');
      expect(receipt.hostedReview.staticReview).toEqual({
        status: 'prepared',
        reason: 'BUILD_AND_DEPLOYMENT_REQUIRED',
        workflowPath: '.github/workflows/selene-pages.yml'
      });
      expect(receipt.hostedReview.collaboration.status).toBe('pending');
      expect(receipt.generatedOutputs).toMatchObject({
        projectId: 'travel-2026',
        delivery: 'repository-source',
        handoffStatus: 'draft',
        bindingIncluded: false,
        staticBuildPaths: {
          review: 'index.html',
          prototype: 'index.html?view=prototype',
          catalog: 'storybook/'
        }
      });
      expect(receipt.generatedOutputs?.sourceArchiveUrl).toBe(
        `https://github.com/travel/prototype/archive/${receipt.commitSha}.tar.gz`
      );
      expect(
        github.calls.every(
          (call) => call.startsWith('read:heads/') || call.startsWith('create:heads/')
        )
      ).toBe(true);
      const tree = github.treeMap.get(receipt.treeSha)!;
      for (const file of plan.files) {
        const entry = tree.tree.find((item) => item.path === file.path)!;
        expect(github.blobMap.get(entry.sha!)?.toString()).toBe(file.content);
      }
      expect(github.blobMap.get(tree.tree.find((file) => file.path === 'bun.lock')!.sha!)).toEqual(
        lockBytes
      );
      expect(await readdir(parent)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('rejects cross-project graphs and mutated seeds before advertising artifact output', () => {
    const { bundle, plan } = publication();
    const artifact = createHostedProjectPublicationArtifact(bundle, plan);
    expect(artifact.prototype.graph.project.projectId).toBe(bundle.projectId);
    expect(artifact.source.workspace.files).toEqual(bundle.source.files);
    expect(artifact.handoff).toEqual({
      status: 'draft',
      compilerBinding: null,
      hostedInspection: 'unavailable'
    });
    expect(() =>
      generatedProjectPublicationOutputs(
        {
          ...bundle,
          prototype: {
            ...bundle.prototype,
            graph: {
              ...bundle.prototype.graph,
              project: { ...bundle.prototype.graph.project, projectId: 'another-project' }
            }
          }
        },
        plan,
        'Travel/Prototype',
        '1'.repeat(40)
      )
    ).toThrow('immutable project');
    const seedFile = plan.files.find((file) => file.path === 'selene/review-seed.json')!;
    expect(() =>
      generatedProjectPublicationOutputs(
        bundle,
        {
          ...plan,
          files: plan.files.map((file) => (file === seedFile ? { ...file, content: '{}\n' } : file))
        },
        'Travel/Prototype',
        '1'.repeat(40)
      )
    ).toThrow('digest');
    const rewritten = {
      ...plan,
      files: plan.files.map((file) => (file === seedFile ? { ...file, content: '{}\n' } : file))
    };
    expect(() =>
      generatedProjectPublicationOutputs(
        bundle,
        { ...rewritten, filePlanDigest: generatedProjectFilePlanDigest(rewritten) },
        'Travel/Prototype',
        '1'.repeat(40)
      )
    ).toThrow('review bytes');
    const alteredSource = {
      ...plan,
      files: plan.files.map((file) =>
        file.path === bundle.source.entrypoint
          ? { ...file, content: file.content + '\n// altered' }
          : file
      )
    };
    expect(() =>
      generatedProjectPublicationOutputs(
        bundle,
        { ...alteredSource, filePlanDigest: generatedProjectFilePlanDigest(alteredSource) },
        'Travel/Prototype',
        '1'.repeat(40)
      )
    ).toThrow('source or review bytes');
  });
});
