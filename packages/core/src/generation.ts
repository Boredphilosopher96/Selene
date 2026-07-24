/**
 * Headless source-generation model.  This module deliberately contains no
 * filesystem, process, browser, or compiler calls.  Hosts validate an agent
 * patch here, then choose whether to persist it and hand it to a compiler.
 */
export const generationPackageFormat = 'selene-react-workspace/v1' as const;

export type SourceLanguage = 'css' | 'json' | 'ts' | 'tsx';
export interface SourceFile {
  readonly path: string;
  readonly content: string;
  readonly language: SourceLanguage;
}

export interface NodeMetadata {
  readonly nodeId: string;
  readonly path: string;
  readonly exportName: string;
}

export interface WorkspaceRevision {
  readonly id: string;
  readonly parentId?: string;
  readonly createdAt: string;
  readonly summary: string;
}

export interface ReactSourceWorkspace {
  readonly format: typeof generationPackageFormat;
  readonly projectId: string;
  readonly entrypoint: string;
  readonly files: readonly SourceFile[];
  readonly dependencies: readonly string[];
  readonly nodes: readonly NodeMetadata[];
  readonly revision: WorkspaceRevision;
}

export type AgentFileOperation =
  | { readonly type: 'write'; readonly path: string; readonly content: string }
  | { readonly type: 'delete'; readonly path: string };

export interface AgentSourcePatch {
  readonly operations: readonly AgentFileOperation[];
  readonly dependencies?: readonly string[];
  /** Explicit mapping is required whenever a pre-existing stable ID disappears. */
  readonly nodeIdMapping?: Readonly<Record<string, string>>;
  readonly summary: string;
}

export interface SourceDiagnostic {
  readonly code:
    | 'DEPENDENCY_NOT_ALLOWED'
    | 'DUPLICATE_NODE_ID'
    | 'INVALID_ENTRYPOINT'
    | 'INVALID_IMPORT'
    | 'INVALID_PATH'
    | 'MISSING_IMPORT'
    | 'MISSING_NODE_MAPPING'
    | 'MISSING_SOURCE'
    | 'UNSUPPORTED_FILE';
  readonly message: string;
  readonly path?: string;
}

export class SourceValidationError extends Error {
  public constructor(public readonly diagnostics: readonly SourceDiagnostic[]) {
    super(diagnostics.map((entry) => entry.message).join('\n'));
    this.name = 'SourceValidationError';
  }
}

const sourceExtensions: Readonly<Record<string, SourceLanguage>> = {
  '.css': 'css',
  '.json': 'json',
  '.ts': 'ts',
  '.tsx': 'tsx'
};
const allowedBareDependencies = new Set(['react', 'react-dom', 'react-dom/client']);
const nodeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function diagnostic(
  code: SourceDiagnostic['code'],
  message: string,
  path?: string
): SourceDiagnostic {
  return path === undefined ? { code, message } : { code, message, path };
}

/** Paths are workspace-relative POSIX paths; absolute, parent, and NUL paths never cross the port. */
export function normalizeSourcePath(path: string): string {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.includes('\0') ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new SourceValidationError([diagnostic('INVALID_PATH', `Invalid source path: ${path}`)]);
  }
  if (!Object.hasOwn(sourceExtensions, path.slice(path.lastIndexOf('.')))) {
    throw new SourceValidationError([
      diagnostic('UNSUPPORTED_FILE', `Unsupported source file: ${path}`, path)
    ]);
  }
  return path;
}

function languageFor(path: string): SourceLanguage {
  const language = sourceExtensions[path.slice(path.lastIndexOf('.'))];
  if (language === undefined) {
    throw new SourceValidationError([
      diagnostic('UNSUPPORTED_FILE', `Unsupported source file: ${path}`, path)
    ]);
  }
  return language;
}

function resolveRelativeImport(from: string, specifier: string): string[] {
  const parts = from.split('/');
  parts.pop();
  for (const part of specifier.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const raw = parts.join('/');
  const hasExtension = /\.[A-Za-z0-9]+$/.test(raw);
  return hasExtension
    ? [raw]
    : [`${raw}.tsx`, `${raw}.ts`, `${raw}.css`, `${raw}/index.tsx`, `${raw}/index.ts`];
}

function isIdentifierStart(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || value === '_' || value === '$'
  );
}

function isIdentifierPart(value: string | undefined): boolean {
  if (value === undefined) return false;
  const code = value.charCodeAt(0);
  return isIdentifierStart(value) || (code >= 48 && code <= 57);
}

function skipWhitespace(source: string, index: number): number {
  while (index < source.length && source.charCodeAt(index) <= 32) index += 1;
  return index;
}

function skipQuotedText(source: string, index: number): number {
  const quote = source[index];
  index += 1;
  while (index < source.length) {
    const value = source[index];
    if (value === '\\') {
      index += 2;
      continue;
    }
    index += 1;
    if (value === quote) break;
  }
  return index;
}

function readQuotedSpecifier(
  source: string,
  index: number
): { readonly next: number; readonly specifier?: string } {
  const quote = source[index];
  const start = index + 1;
  index = start;
  while (index < source.length) {
    const value = source[index];
    if (value === '\\') {
      index += 2;
      continue;
    }
    if (value === quote) return { next: index + 1, specifier: source.slice(start, index) };
    index += 1;
  }
  return { next: index };
}

function skipComment(source: string, index: number): number {
  if (source[index + 1] === '/') {
    index += 2;
    while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
    return index;
  }
  if (source[index + 1] === '*') {
    index += 2;
    while (index < source.length && !(source[index] === '*' && source[index + 1] === '/'))
      index += 1;
    return index < source.length ? index + 2 : index;
  }
  return index;
}

function scanModuleSpecifier(
  source: string,
  index: number,
  allowsDirectSpecifier: boolean
): { readonly next: number; readonly specifier?: string } {
  index = skipWhitespace(source, index);
  if (allowsDirectSpecifier && (source[index] === "'" || source[index] === '"'))
    return readQuotedSpecifier(source, index);
  if (allowsDirectSpecifier && source[index] === '(') return { next: index + 1 };

  while (index < source.length && source[index] !== ';') {
    const value = source[index];
    if (value === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipComment(source, index);
      continue;
    }
    if (value === "'" || value === '"' || value === '`') {
      index = skipQuotedText(source, index);
      continue;
    }
    if (!isIdentifierStart(value)) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (isIdentifierPart(source[index])) index += 1;
    if (source.slice(start, index) !== 'from') continue;
    const specifierStart = skipWhitespace(source, index);
    if (source[specifierStart] === "'" || source[specifierStart] === '"')
      return readQuotedSpecifier(source, specifierStart);
    index = specifierStart;
  }
  return { next: index };
}

/** Scans static import/export declarations once, without backtracking over generated source. */
function importedSpecifiers(source: SourceFile): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < source.content.length) {
    const value = source.content[index];
    if (value === '/' && (source.content[index + 1] === '/' || source.content[index + 1] === '*')) {
      index = skipComment(source.content, index);
      continue;
    }
    if (value === "'" || value === '"' || value === '`') {
      index = skipQuotedText(source.content, index);
      continue;
    }
    if (!isIdentifierStart(value)) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (isIdentifierPart(source.content[index])) index += 1;
    const keyword = source.content.slice(start, index);
    if (keyword !== 'import' && keyword !== 'export') continue;
    const moduleSpecifier = scanModuleSpecifier(source.content, index, keyword === 'import');
    if (moduleSpecifier.specifier !== undefined) values.push(moduleSpecifier.specifier);
    index = moduleSpecifier.next;
  }
  return values;
}

/** Extracts the stable metadata contract from generated JSX without executing it. */
export function extractNodeMetadata(files: readonly SourceFile[]): readonly NodeMetadata[] {
  const nodes: NodeMetadata[] = [];
  const pattern = /data-selene-node-id\s*=\s*(?:{\s*)?['"]([^'"]+)['"]\s*}?/g;
  for (const file of files) {
    if (file.language !== 'tsx') continue;
    pattern.lastIndex = 0;
    for (
      let match = pattern.exec(file.content);
      match !== null;
      match = pattern.exec(file.content)
    ) {
      const nodeId = match[1];
      if (nodeId !== undefined && nodeIdPattern.test(nodeId)) {
        nodes.push({ nodeId, path: file.path, exportName: 'default' });
      }
    }
  }
  return nodes.sort((left, right) => left.nodeId.localeCompare(right.nodeId));
}

export function validateReactSourceWorkspace(workspace: ReactSourceWorkspace): void {
  const diagnostics: SourceDiagnostic[] = [];
  const paths = new Set<string>();
  for (const file of workspace.files) {
    try {
      if (normalizeSourcePath(file.path) !== file.path)
        diagnostics.push(diagnostic('INVALID_PATH', 'Path must be normalized', file.path));
      if (languageFor(file.path) !== file.language)
        diagnostics.push(
          diagnostic('UNSUPPORTED_FILE', 'File language does not match its extension', file.path)
        );
    } catch (error) {
      if (error instanceof SourceValidationError) diagnostics.push(...error.diagnostics);
    }
    if (paths.has(file.path))
      diagnostics.push(
        diagnostic('INVALID_PATH', `Duplicate source path: ${file.path}`, file.path)
      );
    paths.add(file.path);
    if (file.content.length > 1_000_000)
      diagnostics.push(
        diagnostic('INVALID_PATH', `Source file exceeds 1 MB: ${file.path}`, file.path)
      );
  }
  if (!paths.has(workspace.entrypoint))
    diagnostics.push(
      diagnostic(
        'INVALID_ENTRYPOINT',
        `Entrypoint does not exist: ${workspace.entrypoint}`,
        workspace.entrypoint
      )
    );
  for (const dependency of workspace.dependencies) {
    if (!allowedBareDependencies.has(dependency))
      diagnostics.push(
        diagnostic('DEPENDENCY_NOT_ALLOWED', `Dependency is not allowlisted: ${dependency}`)
      );
  }
  for (const file of workspace.files) {
    for (const specifier of importedSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        if (
          !resolveRelativeImport(file.path, specifier).some((candidate) => paths.has(candidate))
        ) {
          diagnostics.push(
            diagnostic('MISSING_IMPORT', `Cannot resolve ${specifier} from ${file.path}`, file.path)
          );
        }
      } else if (!workspace.dependencies.includes(specifier)) {
        diagnostics.push(
          diagnostic(
            'INVALID_IMPORT',
            `Import is not a declared dependency: ${specifier}`,
            file.path
          )
        );
      }
    }
  }
  const seenNodes = new Set<string>();
  for (const node of workspace.nodes) {
    if (!nodeIdPattern.test(node.nodeId) || !paths.has(node.path))
      diagnostics.push(
        diagnostic('INVALID_PATH', `Invalid node metadata: ${node.nodeId}`, node.path)
      );
    if (seenNodes.has(node.nodeId))
      diagnostics.push(
        diagnostic('DUPLICATE_NODE_ID', `Duplicate stable node ID: ${node.nodeId}`, node.path)
      );
    seenNodes.add(node.nodeId);
  }
  if (diagnostics.length > 0) throw new SourceValidationError(diagnostics);
}

/** Applies an agent proposal atomically and returns a monotonically linked workspace revision. */
export function applyAgentSourcePatch(
  workspace: ReactSourceWorkspace,
  patch: AgentSourcePatch,
  revision: Omit<WorkspaceRevision, 'parentId' | 'summary'>
): ReactSourceWorkspace {
  validateReactSourceWorkspace(workspace);
  const files = new Map(workspace.files.map((file) => [file.path, file]));
  for (const operation of patch.operations) {
    const path = normalizeSourcePath(operation.path);
    if (operation.type === 'write')
      files.set(path, { path, content: operation.content, language: languageFor(path) });
    else files.delete(path);
  }
  const nextFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
  const nextNodes = extractNodeMetadata(nextFiles);
  const nextNodeIds = new Set(nextNodes.map((node) => node.nodeId));
  const mapping = patch.nodeIdMapping ?? {};
  const missing = workspace.nodes.filter(
    (node) => !nextNodeIds.has(node.nodeId) && mapping[node.nodeId] === undefined
  );
  if (missing.length > 0) {
    throw new SourceValidationError(
      missing.map((node) =>
        diagnostic(
          'MISSING_NODE_MAPPING',
          `Stable node ID was removed without a mapping: ${node.nodeId}`,
          node.path
        )
      )
    );
  }
  const next: ReactSourceWorkspace = {
    ...workspace,
    files: nextFiles,
    dependencies: [...(patch.dependencies ?? workspace.dependencies)].sort(),
    nodes: nextNodes,
    revision: { ...revision, parentId: workspace.revision.id, summary: patch.summary }
  };
  validateReactSourceWorkspace(next);
  return next;
}

export interface ReactBuildArtifact {
  readonly revisionId: string;
  readonly code: string;
  readonly css?: string;
  readonly sourceMap?: string;
  readonly diagnostics: readonly SourceDiagnostic[];
}

export interface ReactCompilerPort {
  compile(workspace: ReactSourceWorkspace, signal?: AbortSignal): Promise<ReactBuildArtifact>;
}

/** Keeps the last known-good artifact; failed or superseded builds never replace a renderable preview. */
export class RevisionedReactBuilder {
  private lastGood: ReactBuildArtifact | undefined;
  private sequence = 0;

  public async build(
    port: ReactCompilerPort,
    workspace: ReactSourceWorkspace,
    signal?: AbortSignal
  ): Promise<ReactBuildArtifact> {
    const sequence = ++this.sequence;
    try {
      const artifact = await port.compile(workspace, signal);
      if (signal?.aborted || sequence !== this.sequence)
        throw new DOMException('Build superseded', 'AbortError');
      if (artifact.diagnostics.length === 0) this.lastGood = artifact;
      return artifact;
    } catch (error) {
      if (this.lastGood !== undefined)
        return {
          ...this.lastGood,
          diagnostics: [
            diagnostic('MISSING_SOURCE', error instanceof Error ? error.message : 'Build failed')
          ]
        };
      throw error;
    }
  }

  public getLastGood(): ReactBuildArtifact | undefined {
    return this.lastGood;
  }
}

function escapeJsxText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;');
}

/** A deterministic fixture adapter for end-to-end host tests; it never invokes a model or filesystem. */
export function fakeAgentPatch(prompt: string): AgentSourcePatch {
  // Prompt text is data, never JSX. Escaping here keeps even this deterministic
  // fixture from normalizing an adversarial prompt into executable generated code.
  const title = escapeJsxText(prompt.trim().slice(0, 4_000) || 'Generated screen');
  return {
    summary: `Fake agent generated ${title}`,
    operations: [
      {
        type: 'write',
        path: 'src/App.tsx',
        content: `import './screen.css';\nexport default function App() { return <main data-selene-node-id="screen.root"><h1 data-selene-node-id="screen.title">${title}</h1></main>; }\n`
      },
      { type: 'write', path: 'src/state.ts', content: "export const initialState = 'default';\n" },
      { type: 'write', path: 'src/screen.css', content: 'main { padding: 1rem; }\n' }
    ]
  };
}

/** Stable, reproducible source export suitable for a host-controlled download. */
export function exportReactSourceWorkspace(workspace: ReactSourceWorkspace): string {
  validateReactSourceWorkspace(workspace);
  return `${JSON.stringify({ ...workspace, files: [...workspace.files].sort((a, b) => a.path.localeCompare(b.path)) }, null, 2)}\n`;
}
