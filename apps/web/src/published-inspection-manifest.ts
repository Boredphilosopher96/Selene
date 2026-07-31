import type { HostedInspectionTarget } from './hosted-review-inspection';
import inspectionEnvelope from './orders-review-inspection-manifest.json';

export const publishedInspectionManifestFormat = 'selene-published-inspection-manifest/v1' as const;
export const publishedInspectionAttestationFormat = 'selene-sha256-attestation/v1' as const;

export type HostedReviewRole = 'anonymous' | 'commenter' | 'designer' | 'developer';

export interface CanonicalStoryReference {
  readonly format: 'selene-canonical-story-reference/v1';
  readonly projectId: string;
  readonly catalogRevision: string;
  readonly buildId: string;
  readonly componentId: string;
  readonly storyId: string;
}

export interface PublishedInspectionTarget {
  readonly id: string;
  readonly target: HostedInspectionTarget;
  readonly screen: string;
  readonly scenarios: readonly string[];
  readonly changeSinceBaseline: 'changed' | 'unchanged';
  readonly directions: readonly string[];
  readonly story: CanonicalStoryReference;
}

export interface PublishedInspectionManifest {
  readonly format: typeof publishedInspectionManifestFormat;
  readonly artifact: {
    readonly projectId: string;
    readonly artifactId: string;
    readonly revisionId: string;
    readonly baselineId: string;
    readonly sourceDigest: string;
  };
  readonly locks: {
    readonly source: RevisionLock;
    readonly graph: RevisionLock;
    readonly binding: RevisionLock;
    readonly designSystem: {
      readonly package: string;
      readonly version: string;
      readonly digest: string;
    };
    readonly catalog: {
      readonly revisionId: string;
      readonly buildId: string;
      readonly digest: string;
    };
  };
  readonly deployment: {
    readonly deploymentId: string;
    readonly state: 'verified';
    readonly digest: string;
  };
  readonly policy: Readonly<Record<HostedReviewRole, { readonly inspect: boolean }>>;
  readonly targets: readonly PublishedInspectionTarget[];
  readonly targetById: Readonly<Record<string, PublishedInspectionTarget>>;
  readonly attestation: {
    readonly format: typeof publishedInspectionAttestationFormat;
    readonly algorithm: 'sha256';
    readonly payloadDigest: string;
  };
}

interface RevisionLock {
  readonly revisionId: string;
  readonly digest: string;
}

export type PublishedInspectionVerification =
  | { readonly ok: true; readonly manifest: PublishedInspectionManifest }
  | {
      readonly ok: false;
      readonly code: 'invalid' | 'stale' | 'unauthorized' | 'unverified';
      readonly message: string;
    };

export interface ExpectedPublishedArtifact {
  readonly projectId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly baselineId: string;
  readonly sourceDigest: string;
}

const identifier = /^[A-Za-z@][A-Za-z0-9._:/@# -]{0,255}$/;
const digest = /^[a-f0-9]{64}$/;
const version =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const sourcePath = /^src\/[A-Za-z0-9._/-]{1,220}$/;
const roles = ['anonymous', 'commenter', 'designer', 'developer'] as const;
const encoder = new TextEncoder();

export const ordersReviewInspectionEnvelope: unknown = inspectionEnvelope;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Published inspection ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Published inspection ${label} fields are invalid`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !identifier.test(value)) {
    throw new Error(`Published inspection ${label} is invalid`);
  }
  return value;
}

function safeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`Published inspection ${label} is invalid`);
  }
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code === undefined ||
      code <= 31 ||
      code === 127 ||
      character === '<' ||
      character === '>'
    ) {
      throw new Error(`Published inspection ${label} is invalid`);
    }
  }
  return value;
}

function digestText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !digest.test(value)) {
    throw new Error(`Published inspection ${label} digest is invalid`);
  }
  return value;
}

function versionText(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !version.test(value)) {
    throw new Error('Published inspection package version is invalid');
  }
  return value;
}

function sourcePathText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !sourcePath.test(value) ||
    value.includes('//') ||
    value.split('/').includes('..')
  ) {
    throw new Error('Published inspection source path is invalid');
  }
  return value;
}

function boundedList(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`Published inspection ${label} is invalid`);
  }
  return Object.freeze(value.map((item) => text(item, label)));
}

function boundedTextList(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) {
    throw new Error(`Published inspection ${label} is invalid`);
  }
  return Object.freeze(value.map((item) => safeText(item, label)));
}

function revisionLock(value: unknown, label: string): RevisionLock {
  const lock = record(value, `${label} lock`);
  exactKeys(lock, ['revisionId', 'digest'], `${label} lock`);
  return Object.freeze({
    revisionId: text(lock.revisionId, `${label} revision`),
    digest: digestText(lock.digest, label)
  });
}

function ownedTarget(value: unknown): HostedInspectionTarget {
  const target = record(value, 'target');
  const allowed = [
    'field',
    'component',
    'sourcePath',
    'exportName',
    'packageName',
    'packageVersion',
    'owner',
    'authoredProps',
    'token'
  ];
  if (Object.keys(target).some((key) => !allowed.includes(key))) {
    throw new Error('Published inspection target fields are invalid');
  }
  const tokenValue = target.token;
  let token: HostedInspectionTarget['token'];
  if (tokenValue !== undefined) {
    const tokenRecord = record(tokenValue, 'token');
    exactKeys(tokenRecord, ['name', 'value'], 'token');
    token = Object.freeze({
      name: text(tokenRecord.name, 'token name'),
      value: safeText(tokenRecord.value, 'token value')
    });
  }
  return Object.freeze({
    field: text(target.field, 'field'),
    component: text(target.component, 'component'),
    sourcePath: sourcePathText(target.sourcePath),
    exportName: text(target.exportName, 'export'),
    packageName: text(target.packageName, 'package'),
    packageVersion: versionText(target.packageVersion),
    owner: safeText(target.owner, 'owner'),
    authoredProps: boundedTextList(target.authoredProps, 'authored props', 24),
    ...(token === undefined ? {} : { token })
  });
}

function storyReference(
  value: unknown,
  artifact: PublishedInspectionManifest['artifact'],
  catalog: PublishedInspectionManifest['locks']['catalog']
): CanonicalStoryReference {
  const story = record(value, 'Storybook reference');
  exactKeys(
    story,
    ['format', 'projectId', 'catalogRevision', 'buildId', 'componentId', 'storyId'],
    'Storybook reference'
  );
  if (story.format !== 'selene-canonical-story-reference/v1') {
    throw new Error('Published inspection Storybook reference format is invalid');
  }
  const owned = Object.freeze({
    format: 'selene-canonical-story-reference/v1' as const,
    projectId: text(story.projectId, 'Storybook project'),
    catalogRevision: text(story.catalogRevision, 'Storybook catalog revision'),
    buildId: text(story.buildId, 'Storybook build'),
    componentId: text(story.componentId, 'Storybook component'),
    storyId: text(story.storyId, 'Storybook story')
  });
  if (
    owned.projectId !== artifact.projectId ||
    owned.catalogRevision !== catalog.revisionId ||
    owned.buildId !== catalog.buildId
  ) {
    throw new Error('Published inspection Storybook reference is stale');
  }
  return owned;
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 24) throw new Error('Published inspection manifest is too deep');
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    if (encoder.encode(value).byteLength > 16_384) {
      throw new Error('Published inspection manifest string is oversized');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error('Published inspection manifest array is oversized');
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (keys.length > 256) throw new Error('Published inspection manifest object is oversized');
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`)
      .join(',')}}`;
  }
  throw new Error('Published inspection manifest contains an unsupported value');
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function payloadDigest(payload: unknown, cryptoSource: Crypto): Promise<string> {
  if (cryptoSource.subtle === undefined) throw new Error('Web Crypto is unavailable');
  return hex(await cryptoSource.subtle.digest('SHA-256', encoder.encode(canonicalJson(payload))));
}

function projectPayload(
  payloadValue: unknown,
  attestation: PublishedInspectionManifest['attestation']
): PublishedInspectionManifest {
  const payload = record(payloadValue, 'payload');
  exactKeys(payload, ['format', 'artifact', 'locks', 'deployment', 'policy', 'targets'], 'payload');
  if (payload.format !== publishedInspectionManifestFormat) {
    throw new Error('Published inspection manifest format is invalid');
  }

  const artifactValue = record(payload.artifact, 'artifact');
  exactKeys(
    artifactValue,
    ['projectId', 'artifactId', 'revisionId', 'baselineId', 'sourceDigest'],
    'artifact'
  );
  const artifact = Object.freeze({
    projectId: text(artifactValue.projectId, 'project'),
    artifactId: text(artifactValue.artifactId, 'artifact'),
    revisionId: text(artifactValue.revisionId, 'revision'),
    baselineId: text(artifactValue.baselineId, 'baseline'),
    sourceDigest: digestText(artifactValue.sourceDigest, 'source')
  });

  const locksValue = record(payload.locks, 'locks');
  exactKeys(locksValue, ['source', 'graph', 'binding', 'designSystem', 'catalog'], 'locks');
  const source = revisionLock(locksValue.source, 'source');
  const graph = revisionLock(locksValue.graph, 'graph');
  const binding = revisionLock(locksValue.binding, 'binding');
  if (source.revisionId !== artifact.revisionId || source.digest !== artifact.sourceDigest) {
    throw new Error('Published inspection source lock is stale');
  }

  const designSystemValue = record(locksValue.designSystem, 'design-system lock');
  exactKeys(designSystemValue, ['package', 'version', 'digest'], 'design-system lock');
  const designSystem = Object.freeze({
    package: text(designSystemValue.package, 'design-system package'),
    version: versionText(designSystemValue.version),
    digest: digestText(designSystemValue.digest, 'design-system')
  });
  const catalogValue = record(locksValue.catalog, 'catalog lock');
  exactKeys(catalogValue, ['revisionId', 'buildId', 'digest'], 'catalog lock');
  const catalog = Object.freeze({
    revisionId: text(catalogValue.revisionId, 'catalog revision'),
    buildId: text(catalogValue.buildId, 'catalog build'),
    digest: digestText(catalogValue.digest, 'catalog')
  });

  const deploymentValue = record(payload.deployment, 'deployment');
  exactKeys(deploymentValue, ['deploymentId', 'state', 'digest'], 'deployment');
  if (deploymentValue.state !== 'verified') {
    throw new Error('Published inspection deployment is not verified');
  }
  const deployment = Object.freeze({
    deploymentId: text(deploymentValue.deploymentId, 'deployment'),
    state: 'verified' as const,
    digest: digestText(deploymentValue.digest, 'deployment')
  });

  const policyValue = record(payload.policy, 'policy');
  exactKeys(policyValue, roles, 'policy');
  const policyEntries = roles.map((role) => {
    const rolePolicy = record(policyValue[role], `${role} policy`);
    exactKeys(rolePolicy, ['inspect'], `${role} policy`);
    if (typeof rolePolicy.inspect !== 'boolean') {
      throw new Error(`Published inspection ${role} policy is invalid`);
    }
    return [role, Object.freeze({ inspect: rolePolicy.inspect })] as const;
  });
  const policy = Object.freeze(
    Object.fromEntries(policyEntries)
  ) as PublishedInspectionManifest['policy'];

  if (
    !Array.isArray(payload.targets) ||
    payload.targets.length === 0 ||
    payload.targets.length > 64
  ) {
    throw new Error('Published inspection targets are invalid');
  }
  const seen = new Set<string>();
  const targets = Object.freeze(
    payload.targets.map((value) => {
      const entry = record(value, 'target entry');
      exactKeys(
        entry,
        ['id', 'target', 'screen', 'scenarios', 'changeSinceBaseline', 'directions', 'story'],
        'target entry'
      );
      const id = text(entry.id, 'target ID');
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
        throw new Error('Published inspection target ID is reserved');
      }
      if (seen.has(id)) throw new Error('Published inspection target IDs are duplicated');
      seen.add(id);
      const target = ownedTarget(entry.target);
      if (target.field !== id) throw new Error('Published inspection target identity is stale');
      if (entry.changeSinceBaseline !== 'changed' && entry.changeSinceBaseline !== 'unchanged') {
        throw new Error('Published inspection baseline state is invalid');
      }
      return Object.freeze({
        id,
        target,
        screen: text(entry.screen, 'screen'),
        scenarios: boundedList(entry.scenarios, 'scenarios', 32),
        changeSinceBaseline: entry.changeSinceBaseline,
        directions: boundedTextList(entry.directions, 'directions', 32),
        story: storyReference(entry.story, artifact, catalog)
      });
    })
  );
  const targetById = Object.freeze(
    Object.fromEntries(targets.map((target) => [target.id, target]))
  );

  return Object.freeze({
    format: publishedInspectionManifestFormat,
    artifact,
    locks: Object.freeze({ source, graph, binding, designSystem, catalog }),
    deployment,
    policy,
    targets,
    targetById,
    attestation
  });
}

export async function verifyPublishedInspectionManifest(
  envelopeValue: unknown,
  expected: ExpectedPublishedArtifact,
  role: HostedReviewRole,
  cryptoSource: Crypto = globalThis.crypto
): Promise<PublishedInspectionVerification> {
  try {
    const envelope = record(envelopeValue, 'envelope');
    exactKeys(envelope, ['payload', 'attestation'], 'envelope');
    const attestationValue = record(envelope.attestation, 'attestation');
    exactKeys(attestationValue, ['format', 'algorithm', 'payloadDigest'], 'attestation');
    if (
      attestationValue.format !== publishedInspectionAttestationFormat ||
      attestationValue.algorithm !== 'sha256'
    ) {
      return {
        ok: false,
        code: 'unverified',
        message: 'Element inspection is unavailable because its deployment proof is unsupported.'
      };
    }
    const expectedDigest = digestText(attestationValue.payloadDigest, 'attestation');
    const actualDigest = await payloadDigest(envelope.payload, cryptoSource);
    if (actualDigest !== expectedDigest) {
      return {
        ok: false,
        code: 'unverified',
        message: 'Element inspection is unavailable because its published manifest changed.'
      };
    }
    const attestation = Object.freeze({
      format: publishedInspectionAttestationFormat,
      algorithm: 'sha256' as const,
      payloadDigest: expectedDigest
    });
    const manifest = projectPayload(envelope.payload, attestation);
    if (
      manifest.artifact.projectId !== expected.projectId ||
      manifest.artifact.artifactId !== expected.artifactId ||
      manifest.artifact.revisionId !== expected.revisionId ||
      manifest.artifact.baselineId !== expected.baselineId ||
      manifest.artifact.sourceDigest !== expected.sourceDigest
    ) {
      return {
        ok: false,
        code: 'stale',
        message:
          'Element inspection is unavailable for this revision. Refresh the published review.'
      };
    }
    if (!manifest.policy[role].inspect) {
      return {
        ok: false,
        code: 'unauthorized',
        message: 'Element inspection is not enabled for this review role.'
      };
    }
    return { ok: true, manifest };
  } catch {
    return {
      ok: false,
      code: 'invalid',
      message: 'Element inspection is unavailable because its published metadata is invalid.'
    };
  }
}
