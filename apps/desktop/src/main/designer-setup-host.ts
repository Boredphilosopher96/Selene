import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { createDesktopDesignInputLoader } from './design-input-runtime';
import { LocalProjectLifecycleService } from './project-lifecycle';
import { isSafeDesignLanguageDisplayLabel } from '../shared/designer-api';

import type {
  DesignInputCallContext,
  DesignInputPort,
  DesignInputRuntime,
  InputProvenance
} from '@selene/design-inputs';

export interface DesignSystemReceipt {
  /** Staging is deliberately not activation: no package code is installed or imported. */
  readonly status: 'staged';
  readonly packageName: string;
  readonly version: string;
  readonly exports: readonly string[];
  readonly peerCompatibility: 'compatible';
  readonly provenance: InputProvenance;
  readonly artifactDigest: string;
  readonly catalog?: {
    readonly format: 'selene-design-system-catalog-projection/v1';
    readonly components: readonly {
      readonly name: string;
      readonly exportName: string;
      readonly entrypoint: string;
      readonly properties?: readonly {
        readonly name: string;
        readonly label: string;
        readonly control: 'boolean' | 'number' | 'text' | 'select';
        readonly required?: boolean;
        readonly defaultValue?: string | number | boolean;
        readonly values?: readonly (string | number)[];
      }[];
    }[];
    readonly patterns?: readonly {
      readonly id: string;
      readonly label: string;
      readonly description?: string;
      readonly component: {
        readonly entrypoint: string;
        readonly exportName: string;
      };
    }[];
  };
  readonly fixture?: string;
}

export interface MarkdownDesignLanguageReceipt {
  readonly status: 'staged';
  readonly provenance: InputProvenance;
  readonly artifactDigest: string;
  readonly sectionCount: number;
  /** Sanitized filename only; never an absolute path or imported document content. */
  readonly displayLabel?: string;
}
export interface ProjectSetupReceipt {
  readonly projectId: string;
  readonly name: string;
  readonly origin: 'created' | 'template' | 'imported' | 'sample' | 'duplicated';
  readonly revisionId: string;
}

export interface RecentProject {
  readonly id: string;
  readonly name: string;
}

export interface DesignSystemCatalogPolicy {
  readonly requiredPeerDependencies: Readonly<Record<string, string>>;
  readonly provider: {
    readonly label: string;
    readonly fixture?: 'demo-only-local-catalog';
    supports(input: { readonly name: string; readonly version: string }): boolean;
  };
}

export interface DesignSystemCompilerStagingPort {
  stage(
    modules: readonly {
      readonly packageName: string;
      readonly version: string;
      readonly entrypoint: string;
      readonly exportName: string;
      readonly artifactDigest: string;
      readonly moduleSpecifier: string;
      readonly sourcePath: string;
      readonly source: string;
    }[]
  ): void;
}

const packagePattern = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_PROJECT_IMPORT_BYTES = 1024 * 1024;
const MAX_DESIGN_LANGUAGE_BYTES = 256 * 1024;

function isMarkdownImportPath(value: string): boolean {
  return ['.md', '.mdx'].includes(extname(value).toLowerCase());
}

function markdownDisplayLabel(path: string): string {
  const label = basename(path).normalize('NFC').trim();
  return isSafeDesignLanguageDisplayLabel(label) ? label : 'Imported Markdown';
}

function sameFile(
  left: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  },
  right: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  }
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Read only a user-selected Markdown file from the main process. The renderer
 * never receives a path or its content; it can only receive the staged receipt.
 */
async function readMarkdownImport(
  path: string
): Promise<Readonly<{ markdown: string; sourceLocator: string }>> {
  if (!isMarkdownImportPath(path)) throw new Error('Select a Markdown or MDX file.');
  try {
    const initial = await lstat(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_DESIGN_LANGUAGE_BYTES)
      throw new Error('Selected Markdown file is unavailable.');
    const resolved = await realpath(path);
    const resolvedStat = await lstat(resolved);
    if (!resolvedStat.isFile() || resolvedStat.isSymbolicLink() || !sameFile(initial, resolvedStat))
      throw new Error('Selected Markdown file changed before it could be read.');
    const noFollow = constants.O_NOFOLLOW;
    if (!Number.isSafeInteger(noFollow) || noFollow <= 0)
      throw new Error('Secure Markdown import is unavailable on this host.');
    const handle = await open(resolved, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.size > MAX_DESIGN_LANGUAGE_BYTES ||
        !sameFile(resolvedStat, opened)
      )
        throw new Error('Selected Markdown file changed before it could be read.');
      const chunks: Buffer[] = [];
      let length = 0;
      while (length <= MAX_DESIGN_LANGUAGE_BYTES) {
        const chunk = Buffer.allocUnsafe(
          Math.min(64 * 1024, MAX_DESIGN_LANGUAGE_BYTES + 1 - length)
        );
        // eslint-disable-next-line no-await-in-loop -- Descriptor reads must advance sequentially.
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        length += bytesRead;
      }
      if (length > MAX_DESIGN_LANGUAGE_BYTES)
        throw new Error('Selected Markdown file exceeds the import limit.');
      const bytes = Buffer.concat(chunks, length);
      const finished = await handle.stat();
      if (bytes.byteLength > MAX_DESIGN_LANGUAGE_BYTES || !sameFile(opened, finished))
        throw new Error('Selected Markdown file changed while it was being read.');
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (markdown.length === 0) throw new Error('Selected Markdown file is empty.');
      return Object.freeze({ markdown, sourceLocator: resolved });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^(?:Select|Selected Markdown|Secure Markdown)/.test(error.message)
    )
      throw error;
    throw new Error('Selected Markdown file could not be read safely.', { cause: error });
  }
}

function data(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const own = Reflect.ownKeys(descriptors);
    if (
      own.length !== keys.length ||
      own.some((key) => typeof key !== 'string' || !keys.includes(key))
    )
      throw new Error();
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      )
        throw new Error();
      output[key] = descriptor.value;
    }
    return Object.freeze(output);
  } catch {
    throw new Error('Setup request must be an exact data object.');
  }
}

function request(value: unknown): { readonly name: string; readonly version: string } {
  const input = data(value, ['name', 'version']);
  if (
    typeof input.name !== 'string' ||
    !packagePattern.test(input.name) ||
    typeof input.version !== 'string' ||
    !versionPattern.test(input.version)
  )
    throw new Error('Package name and exact semantic version are required.');
  return { name: input.name, version: input.version };
}

interface SafeArray extends ReadonlyArray<SafeValue> {
  readonly length: number;
}
interface SafeObject {
  [key: string]: SafeValue;
}
type SafeValue = null | boolean | number | string | SafeArray | SafeObject;

// The declared catalog path reaches arrays of select values at depth eight:
// artifact -> packageJson -> selene -> designSystem -> components -> component
// -> properties -> property -> values. Primitive values do not consume another
// structural level, and arbitrary objects beyond this schema remain rejected.
const MAX_CATALOG_ARTIFACT_STRUCTURE_DEPTH = 9;

/**
 * Provider responses are treated as hostile data. This never reads a property directly,
 * invokes toJSON, or preserves a provider-owned object in a receipt/digest.
 */
function snapshot(value: unknown, depth = 0, remaining = { value: 2 * 1024 * 1024 }): SafeValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    remaining.value -= typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 8;
    if (remaining.value < 0)
      throw new Error('Catalog artifact metadata exceeds the staging limit.');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Catalog artifact metadata contains an invalid number.');
    remaining.value -= 16;
    if (remaining.value < 0)
      throw new Error('Catalog artifact metadata exceeds the staging limit.');
    return value;
  }
  if (typeof value !== 'object' || depth >= MAX_CATALOG_ARTIFACT_STRUCTURE_DEPTH)
    throw new Error('Catalog artifact metadata is not bounded data.');
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string'))
      throw new Error('Catalog artifact metadata has symbol keys.');
    if (Array.isArray(value)) {
      const length = descriptors.length;
      if (
        !length ||
        !Object.prototype.hasOwnProperty.call(length, 'value') ||
        !Number.isSafeInteger(length.value) ||
        length.value > 512
      )
        throw new Error('Catalog artifact metadata has an invalid array.');
      const result: SafeValue[] = [];
      for (let index = 0; index < length.value; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        )
          throw new Error('Catalog artifact metadata has a sparse or accessor array.');
        result.push(snapshot(descriptor.value, depth + 1, remaining));
      }
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error('Catalog artifact metadata has symbol keys.');
        if (key !== 'length' && (!/^0$|^[1-9]\d*$/.test(key) || Number(key) >= length.value))
          throw new Error('Catalog artifact metadata has unexpected array keys.');
      }
      return Object.freeze(result);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('Catalog artifact metadata has an unsupported prototype.');
    const result: SafeObject = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('Catalog artifact metadata has symbol keys.');
      if (!/^[A-Za-z0-9._@/-]{1,160}$/.test(key))
        throw new Error('Catalog artifact metadata has an invalid key.');
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      )
        throw new Error('Catalog artifact metadata has an accessor.');
      remaining.value -= Buffer.byteLength(key, 'utf8');
      if (remaining.value < 0)
        throw new Error('Catalog artifact metadata exceeds the staging limit.');
      result[key] = snapshot(descriptor.value, depth + 1, remaining);
    }
    return Object.freeze(result);
  } catch (error) {
    throw error instanceof Error ? error : new Error('Catalog artifact metadata is unreadable.');
  }
}

function canonical(value: SafeValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return `{${Object.keys(descriptors)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(descriptors[key]!.value as SafeValue)}`)
    .join(',')}}`;
}

function isSafeObject(value: SafeValue): value is SafeObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: SafeValue): Readonly<Record<string, SafeValue>> | undefined {
  return isSafeObject(value) ? value : undefined;
}

function manifestExports(value: SafeValue): readonly string[] {
  const manifest = recordValue(value);
  const exports = manifest ? recordValue(manifest.exports ?? null) : undefined;
  return exports ? Object.keys(exports).sort() : [];
}

function manifestCatalog(value: SafeValue):
  | {
      readonly format: 'selene-design-system-catalog-projection/v1';
      readonly components: readonly {
        readonly name: string;
        readonly exportName: string;
        readonly entrypoint: string;
        readonly properties?: readonly {
          readonly name: string;
          readonly label: string;
          readonly control: 'boolean' | 'number' | 'text' | 'select';
          readonly required?: boolean;
          readonly defaultValue?: string | number | boolean;
          readonly values?: readonly (string | number)[];
        }[];
      }[];
      readonly patterns?: readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly component: {
          readonly entrypoint: string;
          readonly exportName: string;
        };
      }[];
    }
  | undefined {
  const manifest = recordValue(value);
  const selene = manifest ? recordValue(manifest.selene ?? null) : undefined;
  const designSystem = selene ? recordValue(selene.designSystem ?? null) : undefined;
  if (!designSystem) return undefined;
  if (designSystem.schemaVersion !== '1' || !Array.isArray(designSystem.components))
    throw new Error('Catalog component metadata is invalid.');
  if (designSystem.components.length === 0 || designSystem.components.length > 256)
    throw new Error('Catalog component metadata is invalid.');
  const componentName = /^[A-Za-z][A-Za-z0-9 _.-]{0,79}$/;
  const exportName = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
  const entrypoint = /^(?:\.|\.\/[A-Za-z0-9._/-]{1,255})$/;
  const propertyName = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
  const propertyReservedNames = new Set([
    'children',
    'key',
    'ref',
    'dangerouslysetinnerhtml',
    'data-selene-node-id'
  ]);
  const propertyText = (candidate: string, maximumBytes: number) =>
    Buffer.byteLength(candidate, 'utf8') <= maximumBytes &&
    ![...candidate].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0x7f || codePoint < 0x20;
    });
  const components = designSystem.components.map((entry) => {
    const component = recordValue(entry);
    if (
      !component ||
      typeof component.name !== 'string' ||
      !componentName.test(component.name) ||
      typeof component.exportName !== 'string' ||
      !exportName.test(component.exportName) ||
      typeof component.entrypoint !== 'string' ||
      !entrypoint.test(component.entrypoint)
    )
      throw new Error('Catalog component metadata is invalid.');
    const literal = (candidate: SafeValue): string | number | boolean | undefined =>
      typeof candidate === 'string' && propertyText(candidate, 256)
        ? candidate
        : typeof candidate === 'boolean'
          ? candidate
          : typeof candidate === 'number' &&
              Number.isFinite(candidate) &&
              Math.abs(candidate) <= 1e6
            ? candidate
            : undefined;
    const propertiesValue = component.properties;
    let properties:
      | readonly {
          readonly name: string;
          readonly label: string;
          readonly control: 'boolean' | 'number' | 'text' | 'select';
          readonly required?: boolean;
          readonly defaultValue?: string | number | boolean;
          readonly values?: readonly (string | number)[];
        }[]
      | undefined;
    if (propertiesValue !== undefined) {
      if (!Array.isArray(propertiesValue) || propertiesValue.length > 32)
        throw new Error('Catalog component properties are invalid.');
      const names = new Set<string>();
      properties = Object.freeze(
        propertiesValue.map((propertyValue) => {
          const property = recordValue(propertyValue);
          const allowed = new Set([
            'name',
            'label',
            'control',
            'required',
            'defaultValue',
            'values'
          ]);
          if (
            !property ||
            Object.keys(property).some((key) => !allowed.has(key)) ||
            typeof property.name !== 'string' ||
            !propertyName.test(property.name) ||
            propertyReservedNames.has(property.name.toLowerCase()) ||
            names.has(property.name) ||
            typeof property.label !== 'string' ||
            !propertyText(property.label, 80) ||
            property.label.trim().length === 0 ||
            property.label !== property.label.trim() ||
            (property.control !== 'boolean' &&
              property.control !== 'number' &&
              property.control !== 'text' &&
              property.control !== 'select') ||
            (property.required !== undefined && typeof property.required !== 'boolean')
          )
            throw new Error('Catalog component properties are invalid.');
          names.add(property.name);
          const defaultValue =
            property.defaultValue === undefined ? undefined : literal(property.defaultValue);
          if (property.defaultValue !== undefined && defaultValue === undefined)
            throw new Error('Catalog component property default is invalid.');
          const values =
            property.values === undefined
              ? undefined
              : Array.isArray(property.values)
                ? property.values.map((candidate) => literal(candidate))
                : undefined;
          if (
            (property.control === 'select' &&
              (!values || values.length === 0 || values.length > 32)) ||
            (property.control !== 'select' && values !== undefined) ||
            values?.some(
              (candidate) => candidate === undefined || typeof candidate === 'boolean'
            ) ||
            (values !== undefined &&
              (new Set(values).size !== values.length ||
                new Set(values.map((candidate) => typeof candidate)).size !== 1)) ||
            (defaultValue !== undefined &&
              values !== undefined &&
              !values.some((candidate) => Object.is(candidate, defaultValue)))
          )
            throw new Error('Catalog component property values are invalid.');
          if (
            (property.control === 'boolean' &&
              defaultValue !== undefined &&
              typeof defaultValue !== 'boolean') ||
            (property.control === 'number' &&
              defaultValue !== undefined &&
              typeof defaultValue !== 'number') ||
            (property.control === 'text' &&
              defaultValue !== undefined &&
              typeof defaultValue !== 'string')
          )
            throw new Error('Catalog component property default is invalid.');
          return Object.freeze({
            name: property.name,
            label: property.label,
            control: property.control,
            ...(property.required === true ? { required: true } : {}),
            ...(defaultValue === undefined ? {} : { defaultValue }),
            ...(values === undefined
              ? {}
              : { values: Object.freeze(values as (string | number)[]) })
          });
        })
      );
    }
    return Object.freeze({
      name: component.name,
      exportName: component.exportName,
      entrypoint: component.entrypoint,
      ...(properties === undefined ? {} : { properties })
    });
  });
  const identities = components.map(
    (component) => `${component.entrypoint}\u0000${component.exportName}`
  );
  if (new Set(identities).size !== identities.length)
    throw new Error('Catalog component metadata contains duplicate exports.');
  const exportedEntrypoints = new Set(manifestExports(value));
  if (components.some((component) => !exportedEntrypoints.has(component.entrypoint)))
    throw new Error('Catalog component metadata references an unpublished entrypoint.');
  const patternsValue = designSystem.patterns;
  let patterns:
    | readonly {
        readonly id: string;
        readonly label: string;
        readonly description?: string;
        readonly component: {
          readonly entrypoint: string;
          readonly exportName: string;
        };
      }[]
    | undefined;
  if (patternsValue !== undefined) {
    if (!Array.isArray(patternsValue) || patternsValue.length > 64)
      throw new Error('Catalog pattern metadata is invalid.');
    const patternIds = new Set<string>();
    const componentReferences = new Set(
      components.map((component) => `${component.entrypoint}\u0000${component.exportName}`)
    );
    patterns = Object.freeze(
      patternsValue
        .map((patternValue) => {
          const pattern = recordValue(patternValue);
          const component =
            pattern?.component === undefined ? undefined : recordValue(pattern.component);
          const allowed = new Set(['id', 'label', 'description', 'component']);
          if (
            !pattern ||
            Object.keys(pattern).some((key) => !allowed.has(key)) ||
            typeof pattern.id !== 'string' ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(pattern.id) ||
            patternIds.has(pattern.id) ||
            typeof pattern.label !== 'string' ||
            !propertyText(pattern.label, 80) ||
            pattern.label.trim().length === 0 ||
            pattern.label !== pattern.label.trim() ||
            (pattern.description !== undefined &&
              (typeof pattern.description !== 'string' ||
                !propertyText(pattern.description, 512) ||
                pattern.description.trim().length === 0 ||
                pattern.description !== pattern.description.trim())) ||
            !component ||
            Object.keys(component).some((key) => key !== 'entrypoint' && key !== 'exportName') ||
            typeof component.entrypoint !== 'string' ||
            typeof component.exportName !== 'string' ||
            !componentReferences.has(`${component.entrypoint}\u0000${component.exportName}`)
          )
            throw new Error('Catalog pattern metadata is invalid.');
          patternIds.add(pattern.id);
          return Object.freeze({
            id: pattern.id,
            label: pattern.label,
            ...(pattern.description === undefined ? {} : { description: pattern.description }),
            component: Object.freeze({
              entrypoint: component.entrypoint,
              exportName: component.exportName
            })
          });
        })
        .sort((left, right) => left.id.localeCompare(right.id))
    );
  }
  return Object.freeze({
    format: 'selene-design-system-catalog-projection/v1' as const,
    components: Object.freeze(
      [...components].sort((left, right) =>
        `${left.name}\u0000${left.entrypoint}\u0000${left.exportName}`.localeCompare(
          `${right.name}\u0000${right.entrypoint}\u0000${right.exportName}`
        )
      )
    ),
    ...(patterns === undefined ? {} : { patterns })
  });
}

function runtimeExportTarget(value: SafeValue): string | undefined {
  if (typeof value === 'string') return value;
  const targets = recordValue(value);
  if (targets === undefined) return undefined;
  const preferred = targets.import ?? targets.default;
  return preferred === undefined ? undefined : runtimeExportTarget(preferred);
}

function compilerModules(
  manifestValue: SafeValue,
  filesValue: SafeArray,
  catalog: NonNullable<DesignSystemReceipt['catalog']>,
  packageName: string,
  version: string,
  artifactDigest: string
): readonly {
  readonly packageName: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly exportName: string;
  readonly artifactDigest: string;
  readonly moduleSpecifier: string;
  readonly sourcePath: string;
  readonly source: string;
}[] {
  const manifest = recordValue(manifestValue);
  const exports = manifest ? recordValue(manifest.exports ?? null) : undefined;
  if (exports === undefined) throw new Error('Catalog compiler exports are unavailable.');
  const files = new Map(
    filesValue.map((file) => {
      const entry = recordValue(file);
      if (
        entry === undefined ||
        typeof entry.path !== 'string' ||
        typeof entry.content !== 'string'
      )
        throw new Error('Catalog compiler source is invalid.');
      return [entry.path, entry.content] as const;
    })
  );
  return Object.freeze(
    catalog.components.map((component) => {
      const targetValue = exports[component.entrypoint];
      const sourcePath = targetValue === undefined ? undefined : runtimeExportTarget(targetValue);
      const source = sourcePath === undefined ? undefined : files.get(sourcePath);
      if (sourcePath === undefined || source === undefined)
        throw new Error('Catalog compiler entrypoint is unavailable.');
      return Object.freeze({
        packageName,
        version,
        entrypoint: component.entrypoint,
        exportName: component.exportName,
        artifactDigest,
        moduleSpecifier:
          component.entrypoint === '.'
            ? packageName
            : `${packageName}/${component.entrypoint.slice(2)}`,
        sourcePath,
        source
      });
    })
  );
}

function receiptProvenance(value: unknown): InputProvenance {
  const provenance = recordValue(snapshot(value));
  const provider = provenance?.provider;
  const location = provenance?.location;
  const retrievedAt = provenance?.retrievedAt;
  if (
    typeof provider !== 'string' ||
    provider.length === 0 ||
    provider.length > 64 ||
    typeof location !== 'string' ||
    location.length === 0 ||
    location.length > 512 ||
    (retrievedAt !== undefined && (typeof retrievedAt !== 'string' || retrievedAt.length > 128))
  )
    throw new Error('Catalog provenance is invalid.');
  return Object.freeze({
    provider,
    location,
    ...(typeof retrievedAt === 'string' ? { retrievedAt } : {})
  });
}

function packageReceipt(
  value: unknown,
  peers: Readonly<Record<string, string>>,
  packageName: string,
  version: string
): {
  readonly exports: readonly string[];
  readonly provenance: InputProvenance;
  readonly artifactDigest: string;
  readonly catalog?: NonNullable<DesignSystemReceipt['catalog']>;
  readonly compilerModules?: ReturnType<typeof compilerModules>;
} {
  // This is the first and only inspection of a provider-returned artifact. `snapshot`
  // traverses descriptors into inert data; nothing below can invoke a provider getter/toJSON.
  const artifact = recordValue(snapshot(value));
  const manifest = artifact?.packageJson;
  const files = artifact?.files;
  const provenance = artifact?.provenance;
  if (!artifact || manifest === undefined || !Array.isArray(files) || provenance === undefined)
    throw new Error('Catalog package artifact is invalid.');
  const canonicalValue: SafeValue = Object.freeze({
    manifest,
    files: Object.freeze(
      [...files].sort((left, right) => canonical(left).localeCompare(canonical(right)))
    ),
    peerRequirements: Object.freeze(
      Object.entries(peers)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, peerVersion]) => Object.freeze({ name, version: peerVersion }))
    ),
    provenance
  });
  const catalog = manifestCatalog(manifest);
  const artifactDigest = createHash('sha256').update(canonical(canonicalValue)).digest('hex');
  return Object.freeze({
    exports: manifestExports(manifest),
    provenance: receiptProvenance(provenance),
    artifactDigest,
    ...(catalog === undefined
      ? {}
      : {
          catalog,
          compilerModules: compilerModules(
            manifest,
            files,
            catalog,
            packageName,
            version,
            artifactDigest
          )
        })
  });
}

function localMarkdownStagingPort(markdown: string, location: string): DesignInputPort {
  return Object.freeze({
    async resolvePackage() {
      return {
        packageJson: {
          name: '@selene/local-markdown-stage',
          version: '1.0.0',
          peerDependencies: { react: '^19.0.0' },
          exports: { '.': './index.js' },
          selene: {
            designSystem: {
              schemaVersion: '1',
              tokenFiles: ['./tokens.json'],
              designLanguagePath: './DESIGN.md',
              components: [{ name: 'MarkdownStage', exportName: 'MarkdownStage', entrypoint: '.' }]
            }
          }
        },
        files: [
          { path: './index.js', content: 'export const MarkdownStage = Object.freeze({});' },
          { path: './tokens.json', content: '{"color":"#2563eb"}' },
          { path: './DESIGN.md', content: markdown }
        ],
        provenance: {
          provider: 'desktop-local-markdown-stage',
          location: 'local://guided-setup/schema'
        }
      };
    },
    async readDesignLanguage() {
      return { markdown, provenance: { provider: 'desktop-local-content', location } };
    },
    async sha256(_context: DesignInputCallContext, content: string) {
      return createHash('sha256').update(content).digest('hex');
    }
  });
}

/** Provider-agnostic host port. It validates data only and never installs or imports a package. */
export class DesktopDesignSystemIntake {
  public constructor(
    private readonly port: DesignInputPort,
    private readonly runtime: DesignInputRuntime,
    private readonly policy: DesignSystemCatalogPolicy,
    private readonly compilerStaging?: DesignSystemCompilerStagingPort
  ) {}

  public async inspectPackage(value: unknown): Promise<DesignSystemReceipt> {
    const packageRequest = request(value);
    if (!this.policy.provider.supports(packageRequest))
      throw new Error(
        `${this.policy.provider.label} is unavailable for ${packageRequest.name}@${packageRequest.version}; no package was staged.`
      );
    // Package inspection validates the package-owned DESIGN.md internally, but does not ask a
    // second host effect to supply a matching document. Markdown staging is a separate action.
    const loader = createDesktopDesignInputLoader(this.port, this.runtime);
    const packageArtifact = await loader.inspectPackage({
      package: packageRequest,
      requiredPeerDependencies: this.policy.requiredPeerDependencies
    });
    const receipt = packageReceipt(
      packageArtifact,
      this.policy.requiredPeerDependencies,
      packageRequest.name,
      packageRequest.version
    );
    const staged = {
      status: 'staged',
      packageName: packageRequest.name,
      version: packageRequest.version,
      exports: receipt.exports,
      peerCompatibility: 'compatible',
      provenance: receipt.provenance,
      artifactDigest: receipt.artifactDigest,
      ...(receipt.catalog === undefined ? {} : { catalog: receipt.catalog }),
      ...(this.policy.provider.fixture ? { fixture: this.policy.provider.label } : {})
    } satisfies DesignSystemReceipt;
    if (receipt.compilerModules !== undefined) this.compilerStaging?.stage(receipt.compilerModules);
    return staged;
  }

  /** Main-process-only file import. Callers must retain the Markdown in host memory. */
  public async readMarkdownFile(
    path: string
  ): Promise<Readonly<{ markdown: string; displayLabel: string; sourceLocator: string }>> {
    if (typeof path !== 'string') throw new Error('Select a Markdown or MDX file.');
    const imported = await readMarkdownImport(path);
    return Object.freeze({
      markdown: imported.markdown,
      displayLabel: markdownDisplayLabel(path),
      sourceLocator: imported.sourceLocator
    });
  }
  public async readMarkdownFiles(
    paths: readonly string[]
  ): Promise<
    readonly Readonly<{ markdown: string; displayLabel: string; sourceLocator: string }>[]
  > {
    if (paths.length === 0 || paths.length > 32) throw new Error('Select up to 32 Markdown files.');
    const imports = [];
    for (const path of paths) {
      // eslint-disable-next-line no-await-in-loop -- Bound memory and preserve deterministic chooser order.
      imports.push(await this.readMarkdownFile(path));
    }
    return Object.freeze(imports);
  }

  public async ingestMarkdown(value: unknown): Promise<MarkdownDesignLanguageReceipt> {
    const markdown = data(value, ['markdown']).markdown;
    if (
      typeof markdown !== 'string' ||
      Buffer.byteLength(markdown, 'utf8') === 0 ||
      Buffer.byteLength(markdown, 'utf8') > MAX_DESIGN_LANGUAGE_BYTES
    )
      throw new Error('Markdown must contain between 1 and 262144 UTF-8 bytes.');
    const location = 'local://guided-setup/markdown';
    // Markdown staging deliberately owns a tiny local validation package. It is independent
    // of whichever optional npm catalog adapter is configured for package inspection.
    const loader = createDesktopDesignInputLoader(
      localMarkdownStagingPort(markdown, location),
      this.runtime
    );
    const context = await loader.load({
      package: { name: '@selene/local-markdown-stage', version: '1.0.0' },
      designLanguage: { location },
      requiredPeerDependencies: this.policy.requiredPeerDependencies
    });
    return {
      status: 'staged',
      provenance: { provider: 'desktop-local-content', location },
      artifactDigest: createHash('sha256').update(markdown).digest('hex'),
      sectionCount: context.language.sections.length
    };
  }
}

/** Narrow adapter over the sole local-project lifecycle; no renderer path reaches it. */
export class DesktopProjectSetup {
  public constructor(
    private readonly lifecycle: LocalProjectLifecycleService,
    private readonly workspace: (
      projectId: string,
      template: 'blank' | 'dashboard' | 'review'
    ) => import('@selene/core').ReactSourceWorkspace
  ) {}
  public async create(value: unknown): Promise<ProjectSetupReceipt> {
    const input = data(value, ['id', 'name', 'template']);
    if (
      typeof input.id !== 'string' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(input.id) ||
      typeof input.name !== 'string' ||
      input.name.trim().length === 0 ||
      input.name.length > 120 ||
      (input.template !== 'blank' && input.template !== 'dashboard' && input.template !== 'review')
    )
      throw new Error('Project create request is invalid.');
    const record = await this.lifecycle.create({
      id: input.id,
      name: input.name.trim(),
      origin: input.template === 'blank' ? 'created' : 'template',
      workspace: this.workspace(input.id, input.template)
    });
    return {
      projectId: record.project.id,
      name: record.project.name,
      origin: record.project.origin as 'created' | 'template',
      revisionId: record.current.revision.id
    };
  }

  /** Bounded metadata inventory; workspaces and lifecycle timestamps stay in the host. */
  public async listRecent(): Promise<readonly RecentProject[]> {
    return (await this.lifecycle.listRecent())
      .slice(0, 12)
      .map(({ id, name }) => Object.freeze({ id, name }));
  }

  /** Exact renderer input is validated before the lifecycle performs a durable open. */
  public async openProject(value: unknown) {
    const input = data(value, ['projectId']);
    if (typeof input.projectId !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(input.projectId))
      throw new Error('Project open request is invalid.');
    return this.lifecycle.open(input.projectId);
  }

  public async open(projectId: string) {
    return this.lifecycle.open(projectId);
  }
  public async importText(value: unknown): Promise<ProjectSetupReceipt> {
    const input = data(value, ['contents']);
    if (
      typeof input.contents !== 'string' ||
      Buffer.byteLength(input.contents, 'utf8') > MAX_PROJECT_IMPORT_BYTES
    )
      throw new Error('Project import is invalid or exceeds 1 MiB.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.contents) as unknown;
    } catch {
      throw new Error('Project import JSON is invalid.');
    }
    const record = await this.lifecycle.importRecord(parsed);
    return {
      projectId: record.project.id,
      name: record.project.name,
      origin: 'imported',
      revisionId: record.current.revision.id
    };
  }
  public async importFile(path: string): Promise<ProjectSetupReceipt> {
    const handle = await open(path, 'r');
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size > MAX_PROJECT_IMPORT_BYTES)
        throw new Error('Project import is invalid or exceeds 1 MiB.');
      const buffer = Buffer.allocUnsafe(Math.min(MAX_PROJECT_IMPORT_BYTES + 1, details.size + 1));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        // oxlint-disable-next-line no-await-in-loop -- A bounded positional loop rejects partial or concurrently changed files without an unbounded read.
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead !== details.size || bytesRead > MAX_PROJECT_IMPORT_BYTES)
        throw new Error('Project import is invalid or exceeds 1 MiB.');
      return this.importText({ contents: buffer.subarray(0, bytesRead).toString('utf8') });
    } finally {
      await handle.close();
    }
  }
}

/** Explicit demo-only adapter: it labels its local fixture and supports one exact catalog entry. */
export function createLocalCatalogFixturePort(): DesignInputPort {
  const name = '@selene/design-tokens';
  const version = '1.0.0';
  const markdown = '# Design\n\n## Principles\n\nUse semantic tokens.';
  return {
    async resolvePackage(_context, input) {
      if (input.name !== name || input.version !== version)
        throw new Error('Fixture catalog has no matching package.');
      return {
        packageJson: {
          name,
          version,
          peerDependencies: { react: '^19.0.0' },
          exports: { '.': './dist/index.js', './tokens': './dist/tokens.json' },
          selene: {
            designSystem: {
              schemaVersion: '1',
              tokenFiles: ['./dist/tokens.json'],
              components: [
                {
                  name: 'Button',
                  exportName: 'Button',
                  entrypoint: '.',
                  properties: [
                    {
                      name: 'tone',
                      label: 'Tone',
                      control: 'select',
                      values: ['primary', 'secondary'],
                      defaultValue: 'primary'
                    },
                    {
                      name: 'disabled',
                      label: 'Disabled',
                      control: 'boolean',
                      defaultValue: false
                    },
                    {
                      name: 'label',
                      label: 'Label',
                      control: 'text',
                      required: true,
                      defaultValue: 'Button'
                    }
                  ]
                }
              ],
              designLanguagePath: './DESIGN.md'
            }
          }
        },
        files: [
          {
            path: './dist/index.js',
            content:
              "import React from 'react'; export function Button({ label = 'Button', tone = 'primary', ...props }) { return React.createElement('button', { ...props, 'data-tone': tone }, label); }"
          },
          { path: './dist/tokens.json', content: '{"color":"blue"}' },
          { path: './DESIGN.md', content: markdown }
        ],
        provenance: {
          provider: 'desktop-local-catalog-fixture',
          location: `npm:${name}@${version}`
        }
      };
    },
    async readDesignLanguage() {
      return {
        markdown,
        provenance: {
          provider: 'desktop-local-catalog-fixture',
          location: `npm:${name}@${version}/DESIGN.md`
        }
      };
    },
    async sha256(_context, value) {
      return createHash('sha256').update(value).digest('hex');
    }
  };
}
