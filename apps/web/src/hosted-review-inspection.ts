export const hostedElementInspectionFormat = 'selene-hosted-element-inspection/v1' as const;

export interface HostedInspectionTarget {
  readonly field: string;
  readonly component: string;
  readonly sourcePath: string;
  readonly exportName: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly owner: string;
  readonly authoredProps: readonly string[];
  readonly token?: {
    readonly name: string;
    readonly value: string;
  };
}

export interface HostedElementObservation {
  readonly semanticTag: string;
  readonly role?: string;
  readonly accessibleName?: string;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
  };
  readonly styles: {
    readonly display?: string;
    readonly color?: string;
    readonly backgroundColor?: string;
    readonly fontFamily?: string;
    readonly fontSize?: string;
    readonly fontWeight?: string;
    readonly lineHeight?: string;
    readonly padding?: string;
    readonly border?: string;
    readonly borderRadius?: string;
    readonly textAlign?: string;
  };
}

export interface HostedElementInspection {
  readonly format: typeof hostedElementInspectionFormat;
  readonly artifact: {
    readonly projectId: string;
    readonly artifactId: string;
    readonly revisionId: string;
    readonly baselineId: string;
  };
  readonly target: HostedInspectionTarget;
  readonly scenario: {
    readonly screen: string;
    readonly state: string;
    readonly viewport: string;
  };
  readonly accessibility: {
    readonly semanticTag: string;
    readonly role: string;
    readonly accessibleName: string;
  };
  readonly geometry: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly styles: Readonly<Record<keyof HostedElementObservation['styles'], string>>;
}

const textLimit = 256;
const identifier = /^[A-Za-z@][A-Za-z0-9._:/@# -]{0,255}$/;
const lockedVersion =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function hasUnsafeText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code <= 31 || code === 127)) return true;
  }
  return false;
}

function boundedText(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const normalized = value.replaceAll(/\s+/g, ' ').trim();
  return normalized.length > 0 &&
    normalized.length <= textLimit &&
    !hasUnsafeText(normalized) &&
    !normalized.includes('<') &&
    !normalized.includes('>')
    ? normalized
    : fallback;
}

function boundedIdentity(value: string, label: string): string {
  if (!identifier.test(value)) throw new Error(`Hosted inspection ${label} is invalid`);
  return value;
}

function boundedVersion(value: string): string {
  if (value.length > 128 || !lockedVersion.test(value))
    throw new Error('Hosted inspection package version is invalid');
  return value;
}

function finiteDimension(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 100_000) return 0;
  return Math.round(value * 100) / 100;
}

function ownedTarget(target: HostedInspectionTarget): HostedInspectionTarget {
  return Object.freeze({
    field: boundedIdentity(target.field, 'field'),
    component: boundedIdentity(target.component, 'component'),
    sourcePath: boundedIdentity(target.sourcePath, 'source path'),
    exportName: boundedIdentity(target.exportName, 'export'),
    packageName: boundedIdentity(target.packageName, 'package'),
    packageVersion: boundedVersion(target.packageVersion),
    owner: boundedText(target.owner, 'Unavailable'),
    authoredProps: Object.freeze(
      target.authoredProps.slice(0, 24).map((value) => boundedText(value, 'Unavailable'))
    ),
    ...(target.token === undefined
      ? {}
      : {
          token: Object.freeze({
            name: boundedIdentity(target.token.name, 'token'),
            value: boundedText(target.token.value, 'Unavailable')
          })
        })
  });
}

/**
 * Produces the privacy-reduced read model used by deployed review. Callers may
 * observe only this fixed projection; DOM snapshots, arbitrary attributes,
 * source text, URLs, cookies, and executable package data are never retained.
 */
export function createHostedElementInspection(input: {
  readonly artifact: HostedElementInspection['artifact'];
  readonly target: HostedInspectionTarget;
  readonly observation: HostedElementObservation;
  readonly screen: string;
  readonly state: string;
}): HostedElementInspection {
  const artifact = Object.freeze({
    projectId: boundedIdentity(input.artifact.projectId, 'project'),
    artifactId: boundedIdentity(input.artifact.artifactId, 'artifact'),
    revisionId: boundedIdentity(input.artifact.revisionId, 'revision'),
    baselineId: boundedIdentity(input.artifact.baselineId, 'baseline')
  });
  const observation = input.observation;
  const styles = Object.freeze({
    display: boundedText(observation.styles.display, 'Unavailable'),
    color: boundedText(observation.styles.color, 'Unavailable'),
    backgroundColor: boundedText(observation.styles.backgroundColor, 'Unavailable'),
    fontFamily: boundedText(observation.styles.fontFamily, 'Unavailable'),
    fontSize: boundedText(observation.styles.fontSize, 'Unavailable'),
    fontWeight: boundedText(observation.styles.fontWeight, 'Unavailable'),
    lineHeight: boundedText(observation.styles.lineHeight, 'Unavailable'),
    padding: boundedText(observation.styles.padding, 'Unavailable'),
    border: boundedText(observation.styles.border, 'Unavailable'),
    borderRadius: boundedText(observation.styles.borderRadius, 'Unavailable'),
    textAlign: boundedText(observation.styles.textAlign, 'Unavailable')
  });
  return Object.freeze({
    format: hostedElementInspectionFormat,
    artifact,
    target: ownedTarget(input.target),
    scenario: Object.freeze({
      screen: boundedIdentity(input.screen, 'screen'),
      state: boundedIdentity(input.state, 'state'),
      viewport: `${finiteDimension(observation.viewport.width)} × ${finiteDimension(
        observation.viewport.height
      )} px`
    }),
    accessibility: Object.freeze({
      semanticTag: boundedText(observation.semanticTag, 'Unavailable'),
      role: boundedText(observation.role, 'Implicit semantic role'),
      accessibleName: boundedText(observation.accessibleName, 'No exposed accessible name')
    }),
    geometry: Object.freeze({
      x: finiteDimension(observation.bounds.x),
      y: finiteDimension(observation.bounds.y),
      width: finiteDimension(observation.bounds.width),
      height: finiteDimension(observation.bounds.height)
    }),
    styles
  });
}
