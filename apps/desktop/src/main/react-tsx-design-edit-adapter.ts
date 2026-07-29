import * as ts from '@selene/tsx-compiler-api';

import {
  parseDesignEditProposal,
  type DesignEditProposal,
  type ReactSourceWorkspace
} from '@selene/core';
import {
  MANUAL_APPEARANCE_PROPERTIES,
  type ManualAppearanceProperty
} from '../shared/designer-api';

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
        | 'AMBIGUOUS_SOURCE_FILE'
        | 'SOURCE_BINDING_MISMATCH'
        | 'AMBIGUOUS_TARGET'
        | 'UNSAFE_CHILD'
        | 'UNSAFE_STYLE'
        | 'UNSUPPORTED_STYLE_VALUE'
        | 'INVALID_TSX_SYNTAX';
    };

/** The host supplies these current values; neither renderer data nor source text is authoritative. */
export interface ReactTsxDesignEditContext {
  readonly workspace: ReactSourceWorkspace;
  readonly sourceDigest: string;
  readonly bindingDigest: string;
  readonly designSystemLockDigest: string;
  readonly sourceBindings: readonly HostSourceBinding[];
}

/**
 * Temporary Electron-host binding between compiler identities and the local
 * workspace. It is deliberately not part of @selene/core or renderer data.
 */
export interface HostSourceBinding {
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

function inlineLayoutStyleValue(
  property: Extract<
    DesignEditProposal['commands'][number],
    { readonly kind: 'set-layout' }
  >['property'],
  value: unknown
): string | undefined {
  if (property === 'order') {
    const order =
      typeof value === 'string' && /^(?:0|[1-9]\d{0,3})$/u.test(value) ? Number(value) : value;
    return typeof order === 'number' && Number.isInteger(order) && order >= 0 && order <= 1_000
      ? String(order)
      : undefined;
  }
  if (
    property === 'width' ||
    property === 'height' ||
    property === 'minWidth' ||
    property === 'minHeight' ||
    property === 'maxWidth' ||
    property === 'maxHeight' ||
    property === 'gap'
  ) {
    if (typeof value === 'number')
      return Number.isFinite(value) && value >= 0 && value <= 100_000 ? String(value) : undefined;
    if (
      typeof value !== 'string' ||
      value.length > 128 ||
      !/^(?:auto|fit-content|min-content|max-content|0|(?:\d+(?:\.\d+)?)(?:px|rem|em|%|vw|vh))$/u.test(
        value
      )
    )
      return undefined;
    return JSON.stringify(value);
  }
  if (typeof value !== 'string' || value.length > 32) return undefined;
  const supported =
    property === 'display'
      ? ['block', 'flex', 'grid', 'inline-flex', 'inline-grid', 'none']
      : property === 'flexDirection'
        ? ['row', 'column', 'row-reverse', 'column-reverse']
        : property === 'justifyContent'
          ? ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']
          : property === 'alignItems'
            ? ['stretch', 'flex-start', 'center', 'flex-end', 'baseline']
            : [];
  return supported.includes(value) ? JSON.stringify(value) : undefined;
}

const appearanceToken = /^var\(--[a-z][a-z0-9_-]{0,63}\)$/iu;
const appearanceLength = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/u;
const appearanceSignedLength = /^(?:0|-?\d+(?:\.\d+)?(?:px|rem|em))$/u;

function appearanceSpacing(value: string, allowAuto: boolean): boolean {
  const parts = value.split(' ');
  return (
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every(
      (part) =>
        appearanceLength.test(part) || appearanceToken.test(part) || (allowAuto && part === 'auto')
    )
  );
}

function inlineAppearanceStyleValue(
  property: ManualAppearanceProperty,
  value: unknown
): string | undefined {
  if (property === 'opacity') {
    const opacity = typeof value === 'string' && value.length <= 8 ? Number(value) : value;
    return typeof opacity === 'number' && Number.isFinite(opacity) && opacity >= 0 && opacity <= 1
      ? String(opacity)
      : undefined;
  }
  if (property === 'fontWeight') {
    const weight =
      typeof value === 'string' && /^(?:100|200|300|400|500|600|700|800|900)$/u.test(value)
        ? Number(value)
        : value;
    if (
      typeof weight === 'number' &&
      Number.isInteger(weight) &&
      weight >= 100 &&
      weight <= 900 &&
      weight % 100 === 0
    )
      return String(weight);
    return value === 'normal' || value === 'bold' ? JSON.stringify(value) : undefined;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined;
  let supported = false;
  if (property === 'color' || property === 'backgroundColor')
    supported =
      /^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/iu.test(value) ||
      value === 'transparent' ||
      value === 'currentColor' ||
      appearanceToken.test(value);
  else if (property === 'fontFamily')
    supported =
      /^[a-z0-9 '"_,.-]+$/iu.test(value) &&
      !value.toLowerCase().includes('url(') &&
      !value.toLowerCase().includes('var(');
  else if (property === 'fontSize' || property === 'borderRadius')
    supported = appearanceLength.test(value) || appearanceToken.test(value);
  else if (property === 'letterSpacing')
    supported = appearanceSignedLength.test(value) || appearanceToken.test(value);
  else if (property === 'lineHeight')
    supported =
      /^(?:0\.[5-9]|[1-3](?:\.\d+)?|4(?:\.0+)?)$/u.test(value) ||
      appearanceLength.test(value) ||
      appearanceToken.test(value);
  else if (property === 'textAlign')
    supported = ['start', 'center', 'end', 'left', 'right', 'justify'].includes(value);
  else if (property === 'padding') supported = appearanceSpacing(value, false);
  else if (property === 'margin') supported = appearanceSpacing(value, true);
  return supported ? JSON.stringify(value) : undefined;
}

function prepareInlineStylePatch(
  fileContent: string,
  source: ts.SourceFile,
  element: ts.JsxElement,
  property: string,
  serialized: string | undefined
): string | 'UNSAFE_STYLE' | 'UNSUPPORTED_STYLE_VALUE' {
  if (serialized === undefined) return 'UNSUPPORTED_STYLE_VALUE';
  const styleAttributes = element.openingElement.attributes.properties.filter(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === 'style'
  );
  if (styleAttributes.length > 1) return 'UNSAFE_STYLE';
  const styleAttribute = styleAttributes[0];
  if (styleAttribute === undefined) {
    const insertion = element.openingElement.attributes.end;
    return `${fileContent.slice(0, insertion)} style={{ ${property}: ${serialized} }}${fileContent.slice(insertion)}`;
  }
  if (
    styleAttribute.initializer === undefined ||
    !ts.isJsxExpression(styleAttribute.initializer) ||
    styleAttribute.initializer.expression === undefined ||
    !ts.isObjectLiteralExpression(styleAttribute.initializer.expression)
  )
    return 'UNSAFE_STYLE';
  const styleObject = styleAttribute.initializer.expression;
  if (
    styleObject.properties.some(
      (candidate) =>
        !ts.isPropertyAssignment(candidate) ||
        !ts.isIdentifier(candidate.name) ||
        (!ts.isStringLiteral(candidate.initializer) && !ts.isNumericLiteral(candidate.initializer))
    )
  )
    return 'UNSAFE_STYLE';
  const matching = styleObject.properties.filter(
    (candidate) =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === property
  );
  if (matching.length > 1) return 'UNSAFE_STYLE';
  const existing = matching[0];
  if (existing !== undefined && ts.isPropertyAssignment(existing)) {
    const start = existing.initializer.getStart(source);
    return `${fileContent.slice(0, start)}${serialized}${fileContent.slice(existing.initializer.end)}`;
  }
  const insertion = styleObject.end - 1;
  const prefix = styleObject.properties.length === 0 ? ` ${property}: ` : `, ${property}: `;
  const suffix = styleObject.properties.length === 0 ? ' ' : '';
  return `${fileContent.slice(0, insertion)}${prefix}${serialized}${suffix}${fileContent.slice(insertion)}`;
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
 * Prepares exactly one bounded JSX text, layout, or approved appearance replacement. It never
 * writes, formats, compiles, or changes the input workspace, so a failed
 * preparation is byte-identical by construction.
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
  const command = proposal.commands[0];
  if (
    proposal.commands.length !== 1 ||
    command === undefined ||
    (command.kind !== 'set-content' &&
      command.kind !== 'set-layout' &&
      command.kind !== 'set-style')
  )
    return { kind: 'rejected', code: 'UNSUPPORTED_COMMAND' };
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
  const files = context.workspace.files.filter((candidate) => candidate.path === sourceNode.path);
  if (files.length === 0) return { kind: 'rejected', code: 'MISSING_TARGET' };
  if (files.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_SOURCE_FILE' };
  const file = files[0]!;
  if (file.language !== 'tsx') return { kind: 'rejected', code: 'MISSING_TARGET' };
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
  let nextContent: string;
  if (command.kind === 'set-content') {
    const child = element.children[0];
    if (element.children.length !== 1 || child === undefined || !ts.isJsxText(child))
      return { kind: 'rejected', code: 'UNSAFE_CHILD' };
    const start = child.getStart(source);
    nextContent = `${file.content.slice(0, start)}${escapedJsxText(command.content)}${file.content.slice(child.end)}`;
  } else {
    const appearanceProperty =
      command.kind === 'set-style' &&
      MANUAL_APPEARANCE_PROPERTIES.includes(command.property as ManualAppearanceProperty)
        ? (command.property as ManualAppearanceProperty)
        : undefined;
    const serialized =
      command.kind === 'set-layout'
        ? inlineLayoutStyleValue(command.property, command.value)
        : appearanceProperty === undefined
          ? undefined
          : inlineAppearanceStyleValue(appearanceProperty, command.value);
    const prepared = prepareInlineStylePatch(
      file.content,
      source,
      element,
      command.property,
      serialized
    );
    if (prepared === 'UNSAFE_STYLE' || prepared === 'UNSUPPORTED_STYLE_VALUE')
      return { kind: 'rejected', code: prepared };
    nextContent = prepared;
  }
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
