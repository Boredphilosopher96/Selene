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
    readonly dependency?: string;
    readonly addedNodes?: ReactSourceWorkspace['nodes'];
    /** Stable compiler identities removed with a structural source subtree. */
    readonly removedNodeIds?: readonly string[];
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
        | 'UNAPPROVED_COMPONENT'
        | 'COMPONENT_IMPORT_CONFLICT'
        | 'UNSAFE_CHILD'
        | 'UNSAFE_REPARENT'
        | 'UNSAFE_DUPLICATE'
        | 'DUPLICATE_IDENTITY_CONFLICT'
        | 'UNSAFE_PROP'
        | 'UNSUPPORTED_CONTAINER'
        | 'UNSAFE_STYLE'
        | 'UNSUPPORTED_PROP_VALUE'
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
  /** Exact host-validated package catalog entries; renderer data never populates this list. */
  readonly approvedComponents: readonly ApprovedDesignSystemComponent[];
}

export interface ApprovedDesignSystemComponent {
  readonly packageName: string;
  readonly entrypoint: string;
  readonly exportName: string;
  readonly version: string;
  readonly artifactDigest: string;
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

function matchingReplaceableElements(
  root: ts.Node,
  anchor: string
): readonly (ts.JsxElement | ts.JsxSelfClosingElement)[] {
  const elements: (ts.JsxElement | ts.JsxSelfClosingElement)[] = [];
  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (
      opening?.attributes.properties.some(
        (attribute) => ts.isJsxAttribute(attribute) && markerValue(attribute) === anchor
      ) === true
    )
      elements.push(node as ts.JsxElement | ts.JsxSelfClosingElement);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return elements;
}

function markerCount(root: ts.Node, anchor: string): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    const attributes =
      ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
        ? node.attributes.properties
        : undefined;
    if (
      attributes?.some(
        (attribute) => ts.isJsxAttribute(attribute) && markerValue(attribute) === anchor
      )
    )
      count += 1;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

function markedNodeIds(root: ts.Node): readonly string[] {
  const ids: string[] = [];
  const visit = (node: ts.Node): void => {
    const attributes =
      ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)
        ? node.attributes.properties
        : undefined;
    for (const attribute of attributes ?? []) {
      if (!ts.isJsxAttribute(attribute)) continue;
      const value = markerValue(attribute);
      if (value !== undefined) ids.push(value);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return Object.freeze([...new Set(ids)].sort());
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

function inlinePositionStyleValue(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000
    ? String(Math.round(value * 100) / 100)
    : undefined;
}

/** Authored negative coordinates are prefix expressions, unlike positive numeric literals. */
function boundedSignedNumericLiteralValue(
  expression: ts.Expression | undefined
): number | undefined {
  if (expression === undefined) return undefined;
  const value = ts.isNumericLiteral(expression)
    ? Number(expression.text)
    : ts.isPrefixUnaryExpression(expression) &&
        expression.operator === ts.SyntaxKind.MinusToken &&
        ts.isNumericLiteral(expression.operand)
      ? -Number(expression.operand.text)
      : undefined;
  return value !== undefined && Number.isFinite(value) && Math.abs(value) <= 100_000
    ? value
    : undefined;
}

/**
 * Position moves deliberately require all three authored inline declarations.
 * This avoids manufacturing absolute positioning or altering flex/grid layout.
 */
function prepareAuthoredPositionPatch(
  fileContent: string,
  element: ts.JsxElement,
  left: unknown,
  top: unknown
): string | 'UNSAFE_STYLE' | 'UNSUPPORTED_STYLE_VALUE' {
  const serializedLeft = inlinePositionStyleValue(left);
  const serializedTop = inlinePositionStyleValue(top);
  if (serializedLeft === undefined || serializedTop === undefined) return 'UNSUPPORTED_STYLE_VALUE';
  const styleAttributes = element.openingElement.attributes.properties.filter(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === 'style'
  );
  if (styleAttributes.length !== 1) return 'UNSAFE_STYLE';
  const styleAttribute = styleAttributes[0];
  if (
    styleAttribute?.initializer === undefined ||
    !ts.isJsxExpression(styleAttribute.initializer) ||
    styleAttribute.initializer.expression === undefined ||
    !ts.isObjectLiteralExpression(styleAttribute.initializer.expression)
  )
    return 'UNSAFE_STYLE';
  const assignments = styleAttribute.initializer.expression.properties;
  if (
    assignments.some(
      (candidate) => !ts.isPropertyAssignment(candidate) || !ts.isIdentifier(candidate.name)
    )
  )
    return 'UNSAFE_STYLE';
  const assignment = (name: string) => {
    const matches = assignments.filter(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        ts.isIdentifier(candidate.name) &&
        candidate.name.text === name
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const position = assignment('position');
  const authoredLeft = assignment('left');
  const authoredTop = assignment('top');
  if (
    position === undefined ||
    authoredLeft === undefined ||
    authoredTop === undefined ||
    !ts.isStringLiteral(position.initializer) ||
    !['absolute', 'fixed'].includes(position.initializer.text) ||
    boundedSignedNumericLiteralValue(authoredLeft.initializer) === undefined ||
    boundedSignedNumericLiteralValue(authoredTop.initializer) === undefined
  )
    return 'UNSAFE_STYLE';
  const replacements = [
    {
      start: authoredLeft.initializer.getStart(),
      end: authoredLeft.initializer.end,
      value: serializedLeft
    },
    {
      start: authoredTop.initializer.getStart(),
      end: authoredTop.initializer.end,
      value: serializedTop
    }
  ].sort((a, b) => b.start - a.start);
  return replacements.reduce(
    (content, replacement) =>
      `${content.slice(0, replacement.start)}${replacement.value}${content.slice(replacement.end)}`,
    fileContent
  );
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

function serializedComponentProperty(value: unknown): string | undefined {
  if (typeof value === 'string') return `{${JSON.stringify(value)}}`;
  if (typeof value === 'boolean') return `{${String(value)}}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `{${String(value)}}`;
  return undefined;
}

/**
 * Changes exactly one package-declared literal property. Other attributes,
 * spreads, children, markers, formatting, and component identity are retained.
 */
function prepareComponentPropertyPatch(
  fileContent: string,
  source: ts.SourceFile,
  element: ts.JsxElement | ts.JsxSelfClosingElement,
  property: string,
  value: unknown
): string | 'UNSAFE_PROP' | 'UNSUPPORTED_PROP_VALUE' {
  const serialized = serializedComponentProperty(value);
  if (serialized === undefined) return 'UNSUPPORTED_PROP_VALUE';
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const matching = opening.attributes.properties.filter(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === property
  );
  if (matching.length > 1) return 'UNSAFE_PROP';
  const existing = matching[0];
  if (existing !== undefined) {
    const start = existing.getStart(source);
    return `${fileContent.slice(0, start)}${property}=${serialized}${fileContent.slice(existing.end)}`;
  }
  const insertion = opening.attributes.end;
  return `${fileContent.slice(0, insertion)} ${property}=${serialized}${fileContent.slice(insertion)}`;
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

/** The paired coordinate patch must address one exact compiler-issued target. */
function samePositionTarget(
  left: Extract<DesignEditProposal['commands'][number], { readonly kind: 'set-style' }>['target'],
  right: Extract<DesignEditProposal['commands'][number], { readonly kind: 'set-style' }>['target']
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function directParent(
  element: ts.JsxElement | ts.JsxSelfClosingElement
): ts.JsxElement | undefined {
  return ts.isJsxElement(element.parent) && element.parent.children.includes(element)
    ? element.parent
    : undefined;
}

function elementForAnchor(scope: ts.Node, anchor: string): ts.JsxElement | undefined | 'ambiguous' {
  const matches = matchingElements(scope, anchor);
  return matches.length === 1 ? matches[0] : matches.length > 1 ? 'ambiguous' : undefined;
}

/** Only literal inline flex/grid containers are structurally editable. */
function isSupportedContainer(element: ts.JsxElement): boolean {
  const attributes = element.openingElement.attributes.properties.filter(
    (attribute): attribute is ts.JsxAttribute =>
      ts.isJsxAttribute(attribute) &&
      ts.isIdentifier(attribute.name) &&
      attribute.name.text === 'style'
  );
  if (attributes.length !== 1) return false;
  const expression = attributes[0]?.initializer;
  if (
    expression === undefined ||
    !ts.isJsxExpression(expression) ||
    expression.expression === undefined ||
    !ts.isObjectLiteralExpression(expression.expression)
  )
    return false;
  const display = expression.expression.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'display'
  );
  return (
    display.length === 1 &&
    display[0] !== undefined &&
    ts.isStringLiteral(display[0].initializer) &&
    (display[0].initializer.text === 'flex' || display[0].initializer.text === 'grid')
  );
}

export type ReactTsxDuplicateTargetInspection =
  | {
      readonly kind: 'supported';
      readonly parentSourceAnchorId: string;
      readonly sourceAnchorIds: readonly string[];
    }
  | {
      readonly kind: 'unavailable';
      readonly code:
        | 'MISSING_TARGET'
        | 'AMBIGUOUS_TARGET'
        | 'UNSUPPORTED_EXPORT'
        | 'UNSUPPORTED_CONTAINER'
        | 'UNSAFE_DUPLICATE'
        | 'SOURCE_BINDING_MISMATCH'
        | 'INVALID_TSX_SYNTAX';
    };

const duplicateIdentityAttributes = new Set([
  'id',
  'htmlFor',
  'for',
  'name',
  'key',
  'ref',
  'form',
  'list',
  'headers',
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'aria-activedescendant',
  'aria-details',
  'aria-errormessage',
  'dangerouslySetInnerHTML',
  'srcDoc',
  'children'
]);

function staticDuplicateLiteral(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(node.operand))
  );
}

/** Intrinsic static markup only. Identity references and executable props require a separate rewrite policy. */
function staticDuplicateSubtree(root: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const opening = ts.isJsxElement(root) ? root.openingElement : root;
  if (!ts.isIdentifier(opening.tagName) || !/^[a-z][a-z0-9]*$/.test(opening.tagName.text))
    return false;
  const seen = new Set<string>();
  for (const attribute of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) return false;
    const name = attribute.name.text;
    if (
      seen.has(name) ||
      duplicateIdentityAttributes.has(name) ||
      /^on/i.test(name) ||
      (name.startsWith('data-selene-') && name !== 'data-selene-node-id')
    )
      return false;
    seen.add(name);
    if (name === 'data-selene-node-id' && markerValue(attribute) === undefined) return false;
    const initializer = attribute.initializer;
    if (initializer === undefined) continue;
    if (ts.isStringLiteral(initializer)) {
      if ((name === 'href' || name === 'xlinkHref') && initializer.text.includes('#')) return false;
      continue;
    }
    if (!ts.isJsxExpression(initializer) || initializer.expression === undefined) return false;
    const expression = initializer.expression;
    if (name === 'style') {
      if (
        !ts.isObjectLiteralExpression(expression) ||
        !expression.properties.every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
            staticDuplicateLiteral(property.initializer)
        )
      )
        return false;
    } else if (
      !staticDuplicateLiteral(expression) ||
      ((name === 'href' || name === 'xlinkHref') &&
        ts.isStringLiteral(expression) &&
        expression.text.includes('#'))
    )
      return false;
  }
  return (
    ts.isJsxSelfClosingElement(root) ||
    root.children.every(
      (child) =>
        ts.isJsxText(child) ||
        (ts.isJsxExpression(child) &&
          (child.expression === undefined || staticDuplicateLiteral(child.expression))) ||
        ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) &&
          staticDuplicateSubtree(child))
    )
  );
}

function inspectDuplicateElement(
  workspace: ReactSourceWorkspace,
  source: ts.SourceFile,
  scope: ts.FunctionDeclaration,
  element: ts.JsxElement | ts.JsxSelfClosingElement
): ReactTsxDuplicateTargetInspection {
  const parent = directParent(element);
  if (parent === undefined || !isSupportedContainer(parent))
    return { kind: 'unavailable', code: 'UNSUPPORTED_CONTAINER' };
  const parentMarkers = parent.openingElement.attributes.properties.flatMap((attribute) => {
    const value = ts.isJsxAttribute(attribute) ? markerValue(attribute) : undefined;
    return value === undefined ? [] : [value];
  });
  const parentSourceAnchorId = parentMarkers[0];
  if (
    parentMarkers.length !== 1 ||
    parentSourceAnchorId === undefined ||
    markerCount(source, parentSourceAnchorId) !== 1
  )
    return { kind: 'unavailable', code: 'AMBIGUOUS_TARGET' };
  if (
    parent.children.some(
      (child) =>
        ts.isJsxFragment(child) ||
        (ts.isJsxExpression(child) &&
          child.expression !== undefined &&
          !staticDuplicateLiteral(child.expression))
    )
  )
    return { kind: 'unavailable', code: 'UNSAFE_DUPLICATE' };
  for (
    let ancestor: ts.Node | undefined = parent.parent;
    ancestor !== undefined && ancestor !== scope;
    ancestor = ancestor.parent
  ) {
    if (!(
      ts.isJsxElement(ancestor) ||
      ts.isJsxFragment(ancestor) ||
      ts.isParenthesizedExpression(ancestor) ||
      ts.isReturnStatement(ancestor) ||
      ts.isBlock(ancestor)
    ))
      return { kind: 'unavailable', code: 'UNSAFE_DUPLICATE' };
  }
  if (!staticDuplicateSubtree(element)) return { kind: 'unavailable', code: 'UNSAFE_DUPLICATE' };
  const sourceAnchorIds = markedNodeIds(element);
  if (sourceAnchorIds.length === 0 || sourceAnchorIds.length > 64)
    return { kind: 'unavailable', code: 'UNSAFE_DUPLICATE' };
  for (const anchor of [parentSourceAnchorId, ...sourceAnchorIds]) {
    const nodes = workspace.nodes.filter((node) => node.nodeId === anchor);
    if (
      nodes.length !== 1 ||
      nodes[0]?.path !== source.fileName ||
      nodes[0]?.exportName !== 'default'
    )
      return { kind: 'unavailable', code: 'SOURCE_BINDING_MISMATCH' };
    const counts = workspace.files
      .filter((file) => file.language === 'tsx')
      .map((file) =>
        markerCount(
          file.path === source.fileName
            ? source
            : ts.createSourceFile(
                file.path,
                file.content,
                ts.ScriptTarget.Latest,
                true,
                ts.ScriptKind.TSX
              ),
          anchor
        )
      );
    if (counts.reduce((total, count) => total + count, 0) !== 1)
      return { kind: 'unavailable', code: 'AMBIGUOUS_TARGET' };
  }
  return { kind: 'supported', parentSourceAnchorId, sourceAnchorIds };
}

/** Eligibility inventory only. Applying still requires immutable compiler/revision authority and fresh host identities. */
export function inspectReactTsxDuplicateTarget(
  workspace: ReactSourceWorkspace,
  sourceAnchorId: string
): ReactTsxDuplicateTargetInspection {
  const nodes = workspace.nodes.filter((node) => node.nodeId === sourceAnchorId);
  if (nodes.length === 0) return { kind: 'unavailable', code: 'MISSING_TARGET' };
  if (nodes.length !== 1) return { kind: 'unavailable', code: 'AMBIGUOUS_TARGET' };
  const files = workspace.files.filter(
    (file) => file.path === nodes[0]?.path && file.language === 'tsx'
  );
  if (files.length !== 1) return { kind: 'unavailable', code: 'MISSING_TARGET' };
  const file = files[0];
  if (file === undefined) return { kind: 'unavailable', code: 'MISSING_TARGET' };
  const source = ts.createSourceFile(
    file.path,
    file.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  if (hasDiagnostic(source)) return { kind: 'unavailable', code: 'INVALID_TSX_SYNTAX' };
  const scope = defaultExportScope(source);
  if (nodes[0]?.exportName !== 'default' || scope === undefined)
    return { kind: 'unavailable', code: 'UNSUPPORTED_EXPORT' };
  const elements = matchingReplaceableElements(scope, sourceAnchorId);
  if (elements.length !== 1)
    return {
      kind: 'unavailable',
      code: elements.length === 0 ? 'MISSING_TARGET' : 'AMBIGUOUS_TARGET'
    };
  const element = elements[0];
  if (element === undefined) return { kind: 'unavailable', code: 'MISSING_TARGET' };
  return inspectDuplicateElement(workspace, source, scope, element);
}

function componentModuleSpecifier(component: ApprovedDesignSystemComponent): string {
  return component.entrypoint === '.'
    ? component.packageName
    : `${component.packageName}/${component.entrypoint.slice(2)}`;
}

function approvedComponent(
  command: Extract<
    DesignEditProposal['commands'][number],
    { readonly kind: 'insert-child' | 'replace-component' }
  >,
  context: ReactTsxDesignEditContext
): ApprovedDesignSystemComponent | undefined {
  return context.approvedComponents.find(
    (component) =>
      component.packageName === command.component.packageName &&
      component.entrypoint === command.component.entrypoint &&
      component.exportName === command.component.exportName &&
      component.version === command.component.version &&
      component.artifactDigest === command.component.artifactDigest
  );
}

function componentAttributeValue(value: string | number | boolean): string {
  if (typeof value === 'string') {
    // JSX quoted attribute text is not a JavaScript string literal. Encode
    // markup delimiters so catalog data cannot terminate or introduce JSX.
    const escaped = value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('\r', '&#13;')
      .replaceAll('\n', '&#10;');
    return `"${escaped}"`;
  }
  return `{${String(value)}}`;
}

function componentAttributes(
  props: Readonly<Record<string, string | number | boolean>> | undefined,
  sourceAnchorId: string
): string {
  return [
    ...Object.entries(props ?? {})
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => `${name}=${componentAttributeValue(value)}`),
    `data-selene-node-id=${JSON.stringify(sourceAnchorId)}`
  ].join(' ');
}

function topLevelBindingNames(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) names.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) names.add(element.name.text);
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

function hasExactNamedImport(
  source: ts.SourceFile,
  moduleSpecifier: string,
  exportName: string
): boolean {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier
    )
      return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          (element.propertyName?.text ?? element.name.text) === exportName &&
          element.name.text === exportName
      )
    );
  });
}

function addNamedImport(
  content: string,
  source: ts.SourceFile,
  moduleSpecifier: string,
  exportName: string
): string | 'COMPONENT_IMPORT_CONFLICT' {
  if (hasExactNamedImport(source, moduleSpecifier, exportName)) return content;
  if (topLevelBindingNames(source).has(exportName)) return 'COMPONENT_IMPORT_CONFLICT';
  const imports = source.statements.filter(ts.isImportDeclaration);
  const insertion = imports.at(-1)?.end ?? 0;
  const prefix = insertion === 0 ? '' : '\n';
  const statement = `import { ${exportName} } from ${JSON.stringify(moduleSpecifier)};\n`;
  return `${content.slice(0, insertion)}${prefix}${statement}${content.slice(insertion)}`;
}

function componentInsertionPatch(
  content: string,
  source: ts.SourceFile,
  scope: ts.Node,
  parent: ts.JsxElement,
  command: Extract<DesignEditProposal['commands'][number], { readonly kind: 'insert-child' }>,
  component: ApprovedDesignSystemComponent
):
  | string
  | 'MISSING_TARGET'
  | 'AMBIGUOUS_TARGET'
  | 'UNSUPPORTED_CONTAINER'
  | 'COMPONENT_IMPORT_CONFLICT' {
  if (!isSupportedContainer(parent)) return 'UNSUPPORTED_CONTAINER';
  const existingMarkers = markerCount(scope, command.newSourceAnchorId);
  if (existingMarkers > 1) return 'AMBIGUOUS_TARGET';
  if (existingMarkers === 1) return 'COMPONENT_IMPORT_CONFLICT';
  let insertion: number;
  if (command.position === 'first') {
    const first = parent.children.find(ts.isJsxElement);
    insertion = first?.getStart(source) ?? parent.openingElement.end;
  } else if (command.position === 'last') {
    insertion = parent.closingElement.getStart(source);
  } else {
    const before = elementForAnchor(scope, command.position.beforeSourceAnchorId);
    if (before === undefined) return 'MISSING_TARGET';
    if (before === 'ambiguous') return 'AMBIGUOUS_TARGET';
    if (directParent(before) !== parent) return 'UNSUPPORTED_CONTAINER';
    insertion = before.getStart(source);
  }
  const attributes = componentAttributes(command.props, command.newSourceAnchorId);
  const instance = `<${component.exportName} ${attributes} />`;
  const withInstance = `${content.slice(0, insertion)}${instance}${content.slice(insertion)}`;
  return addNamedImport(
    withInstance,
    source,
    componentModuleSpecifier(component),
    component.exportName
  );
}

function componentReplacementPatch(
  content: string,
  source: ts.SourceFile,
  element: ts.JsxElement | ts.JsxSelfClosingElement,
  command: Extract<DesignEditProposal['commands'][number], { readonly kind: 'replace-component' }>,
  component: ApprovedDesignSystemComponent
): string | 'COMPONENT_IMPORT_CONFLICT' {
  const attributes = componentAttributes(command.props, command.target.sourceAnchorId);
  const replaced = ts.isJsxSelfClosingElement(element)
    ? `${content.slice(0, element.getStart(source))}<${component.exportName} ${attributes} />${content.slice(element.end)}`
    : `${content.slice(0, element.openingElement.getStart(source))}<${component.exportName} ${attributes}>${content.slice(
        element.openingElement.end,
        element.closingElement.getStart(source)
      )}</${component.exportName}>${content.slice(element.closingElement.end)}`;
  return addNamedImport(
    replaced,
    ts.createSourceFile(source.fileName, replaced, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    componentModuleSpecifier(component),
    component.exportName
  );
}

function structuralPatch(
  content: string,
  source: ts.SourceFile,
  scope: ts.Node,
  command: Extract<
    DesignEditProposal['commands'][number],
    { readonly kind: 'reorder-child' | 'reparent-child' }
  >
): string | 'MISSING_TARGET' | 'AMBIGUOUS_TARGET' | 'UNSAFE_REPARENT' | 'UNSUPPORTED_CONTAINER' {
  const child = elementForAnchor(scope, command.target.sourceAnchorId);
  const expectedParentId = command.target.parentSourceAnchorId;
  if (child === undefined || expectedParentId === undefined) return 'MISSING_TARGET';
  if (child === 'ambiguous') return 'AMBIGUOUS_TARGET';
  const currentParent = elementForAnchor(scope, expectedParentId);
  if (currentParent === undefined) return 'MISSING_TARGET';
  if (currentParent === 'ambiguous') return 'AMBIGUOUS_TARGET';
  if (directParent(child) !== currentParent || !isSupportedContainer(currentParent))
    return 'UNSUPPORTED_CONTAINER';
  const nextParent =
    command.kind === 'reparent-child'
      ? elementForAnchor(scope, command.newParentSourceAnchorId)
      : currentParent;
  if (nextParent === undefined) return 'MISSING_TARGET';
  if (nextParent === 'ambiguous') return 'AMBIGUOUS_TARGET';
  if (!isSupportedContainer(nextParent)) return 'UNSUPPORTED_CONTAINER';
  for (
    let ancestor: ts.Node | undefined = nextParent;
    ancestor !== undefined;
    ancestor = ancestor.parent
  ) {
    if (ancestor === child) return 'UNSAFE_REPARENT';
  }
  let insertion: number;
  if (typeof command.position === 'string') {
    if (command.position === 'first') {
      const first = nextParent.children.find(ts.isJsxElement);
      insertion = first === undefined ? nextParent.openingElement.end : first.getStart(source);
    } else {
      insertion = nextParent.closingElement.getStart(source);
    }
  } else {
    const before = elementForAnchor(scope, command.position.beforeSourceAnchorId);
    if (before === undefined) return 'MISSING_TARGET';
    if (before === 'ambiguous') return 'AMBIGUOUS_TARGET';
    if (directParent(before) !== nextParent) return 'UNSAFE_REPARENT';
    insertion = before.getStart(source);
  }
  const start = child.getStart(source);
  const end = child.end;
  if (insertion >= start && insertion <= end) return 'UNSAFE_REPARENT';
  const moved = content.slice(start, end);
  const removed = `${content.slice(0, start)}${content.slice(end)}`;
  const adjustedInsertion = insertion > end ? insertion - (end - start) : insertion;
  return `${removed.slice(0, adjustedInsertion)}${moved}${removed.slice(adjustedInsertion)}`;
}

/**
 * Prepares exactly one bounded JSX or structural replacement. It never
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
  if (
    proposal.commands.length > 1 &&
    proposal.commands.every((command) => command.kind === 'duplicate-node')
  ) {
    const parentSourceAnchorId = proposal.commands[0]?.target.parentSourceAnchorId;
    const originals = proposal.commands.flatMap((command) =>
      command.sourceAnchorRemaps.map((entry) => entry.fromSourceAnchorId)
    );
    if (
      parentSourceAnchorId === undefined ||
      proposal.commands.some(
        (command) => command.target.parentSourceAnchorId !== parentSourceAnchorId
      ) ||
      originals.length > 64 ||
      new Set(originals).size !== originals.length
    )
      return { kind: 'rejected', code: 'UNSAFE_DUPLICATE' };
    const patches: PreparedReactTsxDesignEdit['patch'][] = [];
    for (const command of proposal.commands) {
      // Every target is checked against the original workspace and compiler tuple.
      // No intermediate candidate can supply authority for a later target.
      const prepared = prepareReactTsxDesignEdit({ ...proposal, commands: [command] }, context);
      if (prepared.kind !== 'prepared') return prepared;
      patches.push(prepared.patch);
    }
    const first = patches[0];
    if (
      first === undefined ||
      patches.some(
        (patch) => patch.path !== first.path || patch.previousContent !== first.previousContent
      )
    )
      return { kind: 'rejected', code: 'UNSUPPORTED_CONTAINER' };
    const source = ts.createSourceFile(
      first.path,
      first.previousContent,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const scope = defaultExportScope(source);
    if (scope === undefined) return { kind: 'rejected', code: 'UNSUPPORTED_EXPORT' };
    const insertions: Array<{ readonly offset: number; readonly content: string }> = [];
    for (let index = 0; index < proposal.commands.length; index += 1) {
      const command = proposal.commands[index];
      const patch = patches[index];
      if (command === undefined || patch === undefined)
        return { kind: 'rejected', code: 'UNSUPPORTED_COMMAND' };
      const element = matchingReplaceableElements(scope, command.target.sourceAnchorId)[0];
      if (element === undefined) return { kind: 'rejected', code: 'MISSING_TARGET' };
      const length = patch.nextContent.length - patch.previousContent.length;
      insertions.push({
        offset: element.end,
        content: patch.nextContent.slice(element.end, element.end + length)
      });
    }
    let nextContent = first.previousContent;
    for (const insertion of insertions.sort((left, right) => right.offset - left.offset))
      nextContent = `${nextContent.slice(0, insertion.offset)}${insertion.content}${nextContent.slice(insertion.offset)}`;
    const reparsed = ts.createSourceFile(
      first.path,
      nextContent,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    if (hasDiagnostic(reparsed)) return { kind: 'rejected', code: 'INVALID_TSX_SYNTAX' };
    return {
      kind: 'prepared',
      proposal,
      patch: {
        path: first.path,
        previousContent: first.previousContent,
        nextContent,
        addedNodes: patches.flatMap((patch) => patch.addedNodes ?? [])
      }
    };
  }
  const command = proposal.commands[0];
  const positionCommands = proposal.commands.filter(
    (
      candidate
    ): candidate is Extract<
      DesignEditProposal['commands'][number],
      { readonly kind: 'set-style' }
    > => candidate.kind === 'set-style'
  );
  const positionMove =
    proposal.commands.length === 2 &&
    positionCommands.length === 2 &&
    positionCommands.every(
      (candidate) =>
        (candidate.property === 'left' || candidate.property === 'top') &&
        candidate.risk === 'raw-style'
    ) &&
    new Set(positionCommands.map((candidate) => candidate.property)).size === 2 &&
    positionCommands[0] !== undefined &&
    positionCommands[1] !== undefined &&
    samePositionTarget(positionCommands[0].target, positionCommands[1].target);
  if (
    (!positionMove && proposal.commands.length !== 1) ||
    command === undefined ||
    (command.kind !== 'set-content' &&
      command.kind !== 'set-prop' &&
      command.kind !== 'set-layout' &&
      command.kind !== 'set-style' &&
      command.kind !== 'replace-component' &&
      command.kind !== 'insert-child' &&
      command.kind !== 'remove-node' &&
      command.kind !== 'duplicate-node' &&
      command.kind !== 'reorder-child' &&
      command.kind !== 'reparent-child')
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
  if (command.kind === 'replace-component') {
    const elements = matchingReplaceableElements(scope, command.target.sourceAnchorId);
    if (elements.length === 0) return { kind: 'rejected', code: 'MISSING_TARGET' };
    if (elements.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_TARGET' };
    const component = approvedComponent(command, context);
    if (component === undefined) return { kind: 'rejected', code: 'UNAPPROVED_COMPONENT' };
    const prepared = componentReplacementPatch(
      file.content,
      source,
      elements[0]!,
      command,
      component
    );
    if (prepared === 'COMPONENT_IMPORT_CONFLICT') return { kind: 'rejected', code: prepared };
    const reparsed = ts.createSourceFile(
      file.path,
      prepared,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    if (hasDiagnostic(reparsed)) return { kind: 'rejected', code: 'INVALID_TSX_SYNTAX' };
    return {
      kind: 'prepared',
      proposal,
      patch: {
        path: file.path,
        previousContent: file.content,
        nextContent: prepared,
        dependency: componentModuleSpecifier(command.component)
      }
    };
  }
  if (command.kind === 'set-prop') {
    const elements = matchingReplaceableElements(scope, command.target.sourceAnchorId);
    if (elements.length === 0) return { kind: 'rejected', code: 'MISSING_TARGET' };
    if (elements.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_TARGET' };
    const prepared = prepareComponentPropertyPatch(
      file.content,
      source,
      elements[0]!,
      command.prop,
      command.value
    );
    if (prepared === 'UNSAFE_PROP' || prepared === 'UNSUPPORTED_PROP_VALUE')
      return { kind: 'rejected', code: prepared };
    const reparsed = ts.createSourceFile(
      file.path,
      prepared,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    if (hasDiagnostic(reparsed)) return { kind: 'rejected', code: 'INVALID_TSX_SYNTAX' };
    return {
      kind: 'prepared',
      proposal,
      patch: {
        path: file.path,
        previousContent: file.content,
        nextContent: prepared
      }
    };
  }
  if (command.kind === 'duplicate-node') {
    const elements = matchingReplaceableElements(scope, command.target.sourceAnchorId);
    const element = elements[0];
    if (element === undefined) return { kind: 'rejected', code: 'MISSING_TARGET' };
    if (elements.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_TARGET' };
    const inspection = inspectDuplicateElement(context.workspace, source, scope, element);
    if (inspection.kind !== 'supported') return { kind: 'rejected', code: inspection.code };
    if (
      inspection.parentSourceAnchorId !== command.target.parentSourceAnchorId ||
      command.target.operation.node.instance.repeat.kind !== 'singleton'
    )
      return { kind: 'rejected', code: 'UNSAFE_DUPLICATE' };
    const remaps = new Map(
      command.sourceAnchorRemaps.map((entry) => [entry.fromSourceAnchorId, entry.toSourceAnchorId])
    );
    if (
      remaps.size !== inspection.sourceAnchorIds.length ||
      inspection.sourceAnchorIds.some((anchor) => !remaps.has(anchor))
    )
      return { kind: 'rejected', code: 'SOURCE_BINDING_MISMATCH' };
    for (const anchor of [inspection.parentSourceAnchorId, ...inspection.sourceAnchorIds]) {
      const bindings = context.sourceBindings.filter(
        (binding) => binding.sourceAnchorId === anchor
      );
      if (
        bindings.length !== 1 ||
        bindings[0]?.path !== file.path ||
        bindings[0]?.exportName !== 'default' ||
        bindings[0]?.moduleId !== hostBinding.moduleId ||
        bindings[0]?.sourceDigest !== context.sourceDigest ||
        bindings[0]?.bindingDigest !== context.bindingDigest
      )
        return { kind: 'rejected', code: 'SOURCE_BINDING_MISMATCH' };
    }
    const parsedFiles = context.workspace.files
      .filter((candidate) => candidate.language === 'tsx')
      .map((candidate) =>
        candidate.path === file.path
          ? source
          : ts.createSourceFile(
              candidate.path,
              candidate.content,
              ts.ScriptTarget.Latest,
              true,
              ts.ScriptKind.TSX
            )
      );
    for (const anchor of remaps.values()) {
      if (
        context.workspace.nodes.some((node) => node.nodeId === anchor) ||
        parsedFiles.some((parsed) => markerCount(parsed, anchor) !== 0)
      )
        return { kind: 'rejected', code: 'DUPLICATE_IDENTITY_CONFLICT' };
    }
    const replacements: Array<{
      readonly start: number;
      readonly end: number;
      readonly value: string;
    }> = [];
    const visit = (node: ts.Node): void => {
      if (ts.isJsxAttribute(node)) {
        const oldAnchor = markerValue(node);
        const newAnchor = oldAnchor === undefined ? undefined : remaps.get(oldAnchor);
        const initializer = node.initializer;
        if (newAnchor !== undefined && initializer !== undefined) {
          const literal = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
          if (literal !== undefined)
            replacements.push({
              start: literal.getStart(source),
              end: literal.end,
              value: JSON.stringify(newAnchor)
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(element);
    const start = element.getStart(source);
    let duplicate = file.content.slice(start, element.end);
    for (const replacement of replacements.sort((left, right) => right.start - left.start))
      duplicate = `${duplicate.slice(0, replacement.start - start)}${replacement.value}${duplicate.slice(replacement.end - start)}`;
    const nextContent = `${file.content.slice(0, element.end)}${duplicate}${file.content.slice(element.end)}`;
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
      patch: {
        path: file.path,
        previousContent: file.content,
        nextContent,
        addedNodes: command.sourceAnchorRemaps.map((remap) => ({
          nodeId: remap.toSourceAnchorId,
          path: file.path,
          exportName: sourceNode.exportName
        }))
      }
    };
  }
  if (command.kind === 'remove-node') {
    const elements = matchingReplaceableElements(scope, command.target.sourceAnchorId);
    if (elements.length === 0) return { kind: 'rejected', code: 'MISSING_TARGET' };
    if (elements.length !== 1) return { kind: 'conflict', code: 'AMBIGUOUS_TARGET' };
    const element = elements[0]!;
    const parentId = command.target.parentSourceAnchorId;
    const parent = parentId === undefined ? undefined : elementForAnchor(scope, parentId);
    if (parent === 'ambiguous') return { kind: 'conflict', code: 'AMBIGUOUS_TARGET' };
    if (parent === undefined || directParent(element) !== parent)
      return { kind: 'rejected', code: 'UNSUPPORTED_CONTAINER' };
    const nextContent = `${file.content.slice(0, element.getStart(source))}${file.content.slice(element.end)}`;
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
      patch: {
        path: file.path,
        previousContent: file.content,
        nextContent,
        removedNodeIds: markedNodeIds(element)
      }
    };
  }
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
  } else if (positionMove) {
    const left = positionCommands.find((candidate) => candidate.property === 'left');
    const top = positionCommands.find((candidate) => candidate.property === 'top');
    if (left === undefined || top === undefined) return { kind: 'rejected', code: 'UNSAFE_STYLE' };
    const prepared = prepareAuthoredPositionPatch(file.content, element, left.value, top.value);
    if (prepared === 'UNSAFE_STYLE' || prepared === 'UNSUPPORTED_STYLE_VALUE')
      return { kind: 'rejected', code: prepared };
    nextContent = prepared;
  } else if (command.kind === 'insert-child') {
    const component = approvedComponent(command, context);
    if (component === undefined) return { kind: 'rejected', code: 'UNAPPROVED_COMPONENT' };
    const prepared = componentInsertionPatch(
      file.content,
      source,
      scope,
      element,
      command,
      component
    );
    if (
      prepared === 'MISSING_TARGET' ||
      prepared === 'AMBIGUOUS_TARGET' ||
      prepared === 'UNSUPPORTED_CONTAINER' ||
      prepared === 'COMPONENT_IMPORT_CONFLICT'
    )
      return { kind: 'rejected', code: prepared };
    nextContent = prepared;
  } else if (command.kind === 'reorder-child' || command.kind === 'reparent-child') {
    const prepared = structuralPatch(file.content, source, scope, command);
    if (
      prepared === 'MISSING_TARGET' ||
      prepared === 'AMBIGUOUS_TARGET' ||
      prepared === 'UNSAFE_REPARENT' ||
      prepared === 'UNSUPPORTED_CONTAINER'
    )
      return { kind: 'rejected', code: prepared };
    nextContent = prepared;
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
    patch: {
      path: file.path,
      previousContent: file.content,
      nextContent,
      ...(command.kind === 'insert-child'
        ? {
            dependency: componentModuleSpecifier(command.component),
            addedNodes: [
              {
                nodeId: command.newSourceAnchorId,
                path: file.path,
                exportName: sourceNode.exportName
              }
            ]
          }
        : {})
    }
  };
}
