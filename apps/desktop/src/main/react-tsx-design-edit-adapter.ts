import * as ts from '@selene/tsx-compiler-api';

import {
  parseDesignEditProposal,
  type DesignEditProposal,
  type ReactSourceWorkspace
} from '@selene/core';

/**
 * A prepared mutation is intentionally not a persisted edit. The desktop service
 * must still re-authorize, compile, persist source plus bindings, and create the
 * DesignEditReceipt in one transaction before it can report an applied result.
 */
export interface PreparedReactTsxDesignEdit {
  readonly kind: 'prepared';
  readonly proposal: DesignEditProposal;
  readonly patch: {
    readonly path: string;
    readonly previousContent: string;
    readonly nextContent: string;
  };
}

export type ReactTsxDesignEditPreparation =
  | PreparedReactTsxDesignEdit
  | {
      readonly kind: 'conflict' | 'rejected';
      readonly code:
        | 'STALE_SOURCE'
        | 'STALE_BINDING'
        | 'STALE_DESIGN_SYSTEM_LOCK'
        | 'PROJECT_MISMATCH'
        | 'UNSUPPORTED_COMMAND'
        | 'UNSUPPORTED_EXPORT'
        | 'INVALID_PROPOSAL'
        | 'MISSING_TARGET'
        | 'MISSING_HOST_BINDING'
        | 'AMBIGUOUS_HOST_BINDING'
        | 'AMBIGUOUS_NODE_BINDING'
        | 'SOURCE_BINDING_MISMATCH'
        | 'AMBIGUOUS_TARGET'
        | 'UNSAFE_CHILD'
        | 'INVALID_TSX_SYNTAX';
    };

/** The host supplies these current values; neither renderer data nor source text is authoritative. */
export interface ReactTsxDesignEditContext {
  readonly workspace: ReactSourceWorkspace;
  readonly sourceDigest: string;
  readonly bindingDigest: string;
  readonly designSystemLockDigest: string;
  readonly sourceBindings: readonly ProvisionalHostSourceBinding[];
}

/**
 * Temporary Electron-host binding between compiler identities and the local
 * workspace. It is deliberately not part of @selene/core or renderer data.
 */
interface ProvisionalHostSourceBinding {
  readonly sourceAnchorId: string;
  readonly moduleId: string;
  readonly path: string;
  readonly exportName: string;
  readonly sourceDigest: string;
  readonly bindingDigest: string;
}

interface ParsedTsxSourceFile extends ts.SourceFile {
  /** Present on the compiler-created source file at runtime but omitted from TS6's public SourceFile type. */
  readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

function hasDiagnostic(source: ts.SourceFile): boolean {
  return ((source as ParsedTsxSourceFile).parseDiagnostics?.length ?? 0) !== 0;
}

function markerValue(attribute: ts.JsxAttribute): string | undefined {
  if (
    !ts.isIdentifier(attribute.name) ||
    attribute.name.text !== 'data-selene-node-id' ||
    attribute.initializer === undefined
  )
    return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression !== undefined &&
    ts.isStringLiteral(attribute.initializer.expression)
  )
    return attribute.initializer.expression.text;
  return undefined;
}

function defaultExportScope(source: ts.SourceFile): ts.FunctionDeclaration | undefined {
  const declarations = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.body !== undefined &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ===
        true &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
        true
  );
  return declarations.length === 1 ? declarations[0] : undefined;
}

function matchingElements(root: ts.Node, anchor: string): readonly ts.JsxElement[] {
  const elements: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      if (
        node.openingElement.attributes.properties.some(
          (attribute) => ts.isJsxAttribute(attribute) && markerValue(attribute) === anchor
        )
      )
        elements.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return elements;
}

function escapedJsxText(content: string): string {
  return content
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;');
}

function stale(proposal: DesignEditProposal, context: ReactTsxDesignEditContext) {
  if (proposal.base.tuple.sourceDigest !== context.sourceDigest)
    return { kind: 'conflict', code: 'STALE_SOURCE' } as const;
  if (proposal.base.tuple.bindingDigest !== context.bindingDigest)
    return { kind: 'conflict', code: 'STALE_BINDING' } as const;
  if (proposal.base.tuple.designSystemLockDigest !== context.designSystemLockDigest)
    return { kind: 'conflict', code: 'STALE_DESIGN_SYSTEM_LOCK' } as const;
  return undefined;
}

/**
 * Prepares exactly one direct JSX text replacement. It never writes, formats,
 * compiles, or changes the input workspace, so a failed preparation is
 * byte-identical by construction.
 */
export function prepareReactTsxDesignEdit(
  value: unknown,
  context: ReactTsxDesignEditContext
): ReactTsxDesignEditPreparation {
  let proposal: DesignEditProposal;
  try {
    proposal = parseDesignEditProposal(value);
  } catch {
    return { kind: 'rejected', code: 'INVALID_PROPOSAL' };
  }
  const staleResult = stale(proposal, context);
  if (staleResult !== undefined) return staleResult;
  if (proposal.base.projectId !== context.workspace.projectId)
    return { kind: 'conflict', code: 'PROJECT_MISMATCH' };
  if (proposal.commands.length !== 1 || proposal.commands[0]?.kind !== 'set-content')
    return { kind: 'rejected', code: 'UNSUPPORTED_COMMAND' };
  const command = proposal.commands[0];
  const sourceNodes = context.workspace.nodes.filter(
    (node) => node.nodeId === command.target.sourceAnchorId
  );
  if (sourceNodes.length === 0) return { kind: 'rejected', code: 'MISSING_TARGET' };
  if (sourceNodes.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_NODE_BINDING' };
  const sourceNode = sourceNodes[0]!;
  const hostBindings = context.sourceBindings.filter(
    (binding) =>
      binding.sourceAnchorId === command.target.sourceAnchorId &&
      binding.moduleId === command.target.operation.node.source.moduleId
  );
  if (hostBindings.length === 0) return { kind: 'rejected', code: 'MISSING_HOST_BINDING' };
  if (hostBindings.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_HOST_BINDING' };
  const hostBinding = hostBindings[0]!;
  if (
    sourceNode.path !== hostBinding.path ||
    sourceNode.exportName !== hostBinding.exportName ||
    hostBinding.exportName !== command.target.operation.node.source.exportName ||
    hostBinding.sourceDigest !== context.sourceDigest ||
    hostBinding.bindingDigest !== context.bindingDigest ||
    command.target.operation.node.source.sourceDigest !== context.sourceDigest ||
    command.target.operation.node.source.bindingDigest !== context.bindingDigest
  )
    return { kind: 'rejected', code: 'SOURCE_BINDING_MISMATCH' };
  const file = context.workspace.files.find((candidate) => candidate.path === sourceNode.path);
  if (file === undefined || file.language !== 'tsx')
    return { kind: 'rejected', code: 'MISSING_TARGET' };
  const source = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  if (hasDiagnostic(source)) return { kind: 'rejected', code: 'INVALID_TSX_SYNTAX' };
  if (sourceNode.exportName !== 'default') return { kind: 'rejected', code: 'UNSUPPORTED_EXPORT' };
  const scope = defaultExportScope(source);
  if (scope === undefined) return { kind: 'rejected', code: 'UNSUPPORTED_EXPORT' };
  const elements = matchingElements(scope, command.target.sourceAnchorId);
  if (elements.length === 0) return { kind: 'rejected', code: 'MISSING_TARGET' };
  if (elements.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_TARGET' };
  const element = elements[0]!;
  const child = element.children[0];
  if (element.children.length !== 1 || child === undefined || !ts.isJsxText(child))
    return { kind: 'rejected', code: 'UNSAFE_CHILD' };
  const start = child.getStart(source);
  const nextContent = `${file.content.slice(0, start)}${escapedJsxText(command.content)}${file.content.slice(child.end)}`;
  const reparsed = ts.createSourceFile(
    file.path,
    nextContent,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  if (hasDiagnostic(reparsed)) return { kind: 'rejected', code: 'INVALID_TSX_SYNTAX' };
  return {
    kind: 'prepared',
    proposal,
    patch: { path: file.path, previousContent: file.content, nextContent }
  };
}
