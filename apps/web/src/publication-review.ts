import {
  parseGeneratedDesignHandoff,
  parsePrototypeGraph,
  parseReactBindingCompilerEvidence,
  projectComponentCatalogManifest,
  serializeCanonicalData,
  validateDesignBaselineState,
  validateReactBindingManifest,
  type DesignBaselineState,
  type GeneratedDesignHandoff,
  type ReactSourceWorkspace
} from '@selene/core';

export interface PublicationReviewRequest {
  readonly manifestUrl: string;
  readonly manifestSha256: string;
}
export interface PublicationReviewArtifact {
  readonly kind: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface VerifiedPublicationReview {
  readonly format: 'selene-verified-publication-review/v1';
  readonly projectId: string;
  readonly immutableId: string;
  readonly bundleDigest: string;
  readonly sourceRevisionId: string;
  readonly graphRevision: number;
  readonly graphRevisionId: string;
  readonly manifestSha256: string;
  readonly baseUrl: string;
  readonly buildCommit: string | null;
  readonly baseline: DesignBaselineState;
  readonly handoff: GeneratedDesignHandoff;
  readonly source: ReactSourceWorkspace;
  readonly binding: 'unavailable' | 'compiler-bound';
  readonly artifacts: readonly PublicationReviewArtifact[];
  readonly scenarios: readonly { readonly id: string; readonly name: string }[];
}
export interface PublicationReviewLoadOptions {
  readonly pageUrl: string;
  readonly allowedArtifactOrigin?: string;
  readonly fetch?: typeof fetch;
  readonly crypto?: Crypto;
  readonly signal?: AbortSignal;
}

const digest = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const artifactKinds = [
  'handoff',
  'package',
  'lockfile',
  'prototype',
  'catalog',
  'provenance'
] as const;
function invalid(): never {
  throw new Error('Publication artifact is invalid, stale or outside the allowed origin.');
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    invalid();
  return value;
}
function id(value: unknown): string {
  const candidate = text(value, 128);
  if (!identifier.test(candidate)) invalid();
  return candidate;
}
function sha(value: unknown): string {
  const candidate = text(value, 64);
  if (!digest.test(candidate)) invalid();
  return candidate;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
function array(value: unknown, maximum = 500): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}
function publicMetadata(value: unknown): void {
  if (
    /(?:\/Users\/|\/home\/|file:\/\/|(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,})/i.test(
      JSON.stringify(value)
    )
  )
    invalid();
}
function safeUrl(value: string, options: PublicationReviewLoadOptions): URL {
  const url = new URL(value, options.pageUrl);
  const page = new URL(options.pageUrl);
  const allowed =
    options.allowedArtifactOrigin === undefined
      ? page.origin
      : new URL(options.allowedArtifactOrigin).origin;
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.origin !== page.origin && url.origin !== allowed) ||
    (url.protocol !== 'https:' && url.origin !== page.origin)
  )
    invalid();
  return url;
}
export function publicationReviewRequestFromUrl(
  pageUrl: string,
  allowedArtifactOrigin?: string
): PublicationReviewRequest | undefined {
  const url = new URL(pageUrl);
  const manifest = url.searchParams.get('publication');
  if (manifest === null) return undefined;
  const manifestSha256 = sha(url.searchParams.get('digest'));
  if (manifest.includes('\\') || /(?:^|\/)\.\.(?:\/|$)|%/i.test(manifest)) invalid();
  const resolved = safeUrl(manifest, {
    pageUrl,
    ...(allowedArtifactOrigin === undefined ? {} : { allowedArtifactOrigin })
  });
  if (!resolved.pathname.endsWith('/review/manifest.json')) invalid();
  return { manifestUrl: resolved.href, manifestSha256 };
}
async function bytesAt(
  url: URL,
  maximum: number,
  options: PublicationReviewLoadOptions
): Promise<Uint8Array> {
  const response = await (options.fetch ?? fetch)(url, {
    credentials: 'omit',
    redirect: 'error',
    ...(options.signal === undefined ? {} : { signal: options.signal })
  });
  if (!response.ok || (response.url && response.url !== url.href) || response.body === null)
    invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Apply the byte cap while streaming untrusted artifacts.
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        // oxlint-disable-next-line no-await-in-loop -- Cancel the untrusted stream immediately after it exceeds the cap.
        await reader.cancel();
        invalid();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function hash(bytes: Uint8Array, options: PublicationReviewLoadOptions): Promise<string> {
  const cryptoSource = options.crypto ?? globalThis.crypto;
  const value = await cryptoSource.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/** The manifest is pinned by the caller; remote code and identity never cross this data-only boundary. */
export async function loadPublicationReview(
  request: PublicationReviewRequest,
  options: PublicationReviewLoadOptions
): Promise<VerifiedPublicationReview> {
  const manifestUrl = safeUrl(request.manifestUrl, options);
  if (
    !manifestUrl.pathname.endsWith('/review/manifest.json') ||
    !digest.test(request.manifestSha256)
  )
    invalid();
  const bytes = await bytesAt(manifestUrl, 1024 * 1024, options);
  if ((await hash(bytes, options)) !== request.manifestSha256) invalid();
  const manifest = record(JSON.parse(decode(bytes)));
  publicMetadata(manifest);
  if (
    manifest.format !== 'selene-public-review-manifest/v1' ||
    manifest.independentAcceptance !== false
  )
    invalid();
  const projectId = id(manifest.projectId);
  const bundleDigest = sha(manifest.bundleDigest);
  const immutableId = text(manifest.immutableId, 160);
  if (immutableId !== 'bundle-sha256-' + bundleDigest) invalid();
  const sourceRevisionId = id(manifest.sourceRevisionId);
  const graphRevision = integer(manifest.graphRevision);
  const graphRevisionId = id(manifest.graphRevisionId);
  const baseline = manifest.baseline as DesignBaselineState;
  validateDesignBaselineState(baseline);
  if (baseline.projectId !== projectId) invalid();
  const build = record(manifest.build);
  if (
    build.bundleDigest !== bundleDigest ||
    build.sourceRevisionId !== sourceRevisionId ||
    build.graphRevision !== graphRevision ||
    (build.commit !== null &&
      (typeof build.commit !== 'string' || !/^[a-f0-9]{40}$/.test(build.commit)))
  )
    invalid();
  const lockDigest = sha(build.lockfileSha256);
  const base = new URL('../', manifestUrl);
  const artifacts: PublicationReviewArtifact[] = [];
  const contents = new Map<string, Uint8Array>();
  let aggregate = bytes.byteLength;
  for (const value of array(manifest.artifacts, 6)) {
    const artifact = record(value);
    const kind = text(artifact.kind, 16);
    const checksum = sha(artifact.sha256);
    const count = integer(artifact.bytes);
    if (
      !artifactKinds.some((item) => item === kind) ||
      contents.has(kind) ||
      count === 0 ||
      count > 2 * 1024 * 1024
    )
      invalid();
    const href = text(artifact.href, 256);
    if (!new RegExp('^review/artifacts/' + kind + '-' + checksum + '\\.(json|lock)$').test(href))
      invalid();
    const artifactUrl = safeUrl(new URL(href, base).href, options);
    // oxlint-disable-next-line no-await-in-loop -- Bound aggregate bytes and verify one immutable download before reading the next.
    const payload = await bytesAt(artifactUrl, count, options);
    aggregate += payload.byteLength;
    if (aggregate > 8 * 1024 * 1024 || payload.byteLength !== count) invalid();
    // oxlint-disable-next-line no-await-in-loop -- Each content-addressed artifact must match its exact bytes.
    if ((await hash(payload, options)) !== checksum) invalid();
    contents.set(kind, payload);
    artifacts.push({ kind, url: artifactUrl.href, sha256: checksum, bytes: count });
  }
  if (contents.size !== artifactKinds.length) invalid();
  const handoff = parseGeneratedDesignHandoff(decode(contents.get('handoff')!));
  const source = JSON.parse(handoff.source) as ReactSourceWorkspace;
  const publicSourceSha256 = await hash(
    new TextEncoder().encode(serializeCanonicalData(source)),
    options
  );
  if (sha(manifest.sourceSha256) !== publicSourceSha256) invalid();
  if (
    handoff.project.id !== projectId ||
    source.projectId !== projectId ||
    source.revision.id !== sourceRevisionId ||
    handoff.revision.id !== sourceRevisionId ||
    handoff.comments.length !== 0 ||
    (handoff.reviewThreads?.length ?? 0) !== 0 ||
    handoff.reproducibility.lockfile.path !== 'bun.lock' ||
    handoff.reproducibility.lockfile.checksum !== lockDigest ||
    (await hash(contents.get('lockfile')!, options)) !== lockDigest
  )
    invalid();
  const expectedChanges = baseline.changesSinceBaseline;
  if (
    JSON.stringify(handoff.baseline.exactChangesToRecheck) !== JSON.stringify(expectedChanges) ||
    handoff.baseline.currency !== baseline.currency ||
    handoff.baseline.approvalsStale !== baseline.approvalsStale
  )
    invalid();
  const packageJson = record(JSON.parse(decode(contents.get('package')!)));
  if (packageJson.packageManager !== handoff.reproducibility.packageManager) invalid();
  for (const [field, expected] of [
    ['dependencies', handoff.reproducibility.dependencies],
    ['devDependencies', handoff.reproducibility.packages]
  ] as const) {
    const actual = Object.entries(record(packageJson[field] ?? {})).map(([name, version]) => ({
      name,
      version: text(version, 128)
    }));
    const sorted = (entries: readonly { readonly name: string; readonly version: string }[]) =>
      [...entries].sort((left, right) => left.name.localeCompare(right.name));
    if (serializeCanonicalData(sorted(actual)) !== serializeCanonicalData(sorted(expected)))
      invalid();
  }
  const provenance = record(JSON.parse(decode(contents.get('provenance')!)));
  if (
    provenance.bundleDigest !== bundleDigest ||
    provenance.sourceRevisionId !== sourceRevisionId ||
    provenance.graphRevision !== graphRevision ||
    provenance.commit !== build.commit
  )
    invalid();
  const catalog = record(JSON.parse(decode(contents.get('catalog')!)));
  const projectedCatalog = projectComponentCatalogManifest(catalog, {
    projectId,
    prototypeRevision: sourceRevisionId
  });
  if (projectedCatalog.state !== 'ready') invalid();
  for (const component of array(catalog.components, 4096)) {
    const componentSource = record(record(component).source);
    const file = source.files.find((candidate) => candidate.path === componentSource.path);
    if (file === undefined || componentSource.revision !== sourceRevisionId) invalid();
    // oxlint-disable-next-line no-await-in-loop -- Bind each catalog entry to the exact canonical source file bytes.
    const fileChecksum = await hash(new TextEncoder().encode(file.content), options);
    if (sha(componentSource.checksum) !== fileChecksum) invalid();
  }
  if (
    handoff.project.storyReferences.some(
      (story) =>
        story.projectId !== projectId ||
        story.catalogRevision !== projectedCatalog.catalogRevision ||
        story.buildId !== projectedCatalog.buildId ||
        !projectedCatalog.components.some(
          (component) =>
            component.id === story.componentId &&
            component.stories.some((item) => item.id === story.storyId)
        )
    )
  )
    invalid();
  const graphProjection = record(manifest.graph);
  const scenarios = array(graphProjection.scenarios, 256).map((value) => {
    const scenario = record(value);
    return { id: id(scenario.id), name: text(scenario.name) };
  });
  let binding: VerifiedPublicationReview['binding'] = 'unavailable';
  const prototype = JSON.parse(decode(contents.get('prototype')!));
  if (
    manifest.bindingIncluded === false &&
    manifest.handoffStatus === 'draft' &&
    manifest.compilation === null
  ) {
    if (
      handoff.reactBinding !== null ||
      handoff.project.status !== 'draft' ||
      JSON.stringify(prototype) !== JSON.stringify(manifest.graph)
    )
      invalid();
  } else if (manifest.bindingIncluded === true && manifest.handoffStatus === 'compiler-bound') {
    const envelope = record(prototype);
    if (
      envelope.format !== 'selene-publication-prototype/v1' ||
      envelope.projectId !== projectId ||
      envelope.graphRevision !== graphRevision
    )
      invalid();
    const graph = parsePrototypeGraph(envelope.graph);
    if (
      graph.project.projectId !== projectId ||
      graph.revision.id !== graphRevisionId ||
      graph.id !== graphProjection.id ||
      sha(manifest.graphSha256) !==
        (await hash(new TextEncoder().encode(serializeCanonicalData(graph)), options))
    )
      invalid();
    const compilation = record(manifest.compilation);
    const receipt = record(compilation.receipt);
    const evidence = parseReactBindingCompilerEvidence(compilation.compilerEvidence);
    const sourceSha256 = publicSourceSha256;
    if (
      receipt.format !== 'selene-react-build-receipt/v1' ||
      receipt.compilerIdentity !== 'selene-vite-react-compiler/v1' ||
      receipt.projectId !== projectId ||
      receipt.sourceRevisionId !== sourceRevisionId ||
      receipt.sourceSha256 !== sourceSha256 ||
      evidence.sourceSha256 !== sourceSha256 ||
      sha(receipt.outputSha256) !== evidence.outputSha256 ||
      array(receipt.reachableFiles).some((path) => !source.files.some((file) => file.path === path))
    )
      invalid();
    validateReactBindingManifest(handoff.reactBinding, {
      graph,
      graphRevision,
      workspace: source,
      compilerEvidence: evidence
    });
    binding = 'compiler-bound';
  } else invalid();
  return {
    format: 'selene-verified-publication-review/v1',
    projectId,
    immutableId,
    bundleDigest,
    sourceRevisionId,
    graphRevision,
    graphRevisionId,
    manifestSha256: request.manifestSha256,
    baseUrl: base.href,
    buildCommit: build.commit,
    baseline,
    handoff,
    source,
    binding,
    artifacts,
    scenarios
  };
}
