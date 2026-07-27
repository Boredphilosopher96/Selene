import { createHash } from 'node:crypto';

import * as ts from '@selene/tsx-compiler-api';
import {
  parseReactBindingCompilerEvidence,
  serializeCanonicalData,
  validateReactSourceWorkspace,
  type ReactBindingCompilerEvidence,
  type ReactSourceWorkspace
} from '@selene/core';

const sourceDigest = (workspace: ReactSourceWorkspace): string =>
  createHash('sha256').update(serializeCanonicalData(workspace)).digest('hex');

function literalAttribute(opening: ts.JsxOpeningLikeElement, name: string): string | undefined {
  const attribute = opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name
  );
  if (attribute?.initializer === undefined || !ts.isStringLiteral(attribute.initializer))
    return undefined;
  return attribute.initializer.text;
}

function exportedNames(source: ts.SourceFile): readonly string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (modifiers?.some((item) => item.kind === ts.SyntaxKind.DefaultKeyword))
      names.push('default');
    else if (
      modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) &&
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      statement.name !== undefined
    )
      names.push(statement.name.text);
  }
  return names;
}

/**
 * Host-only AST evidence. It never executes or exposes source to the renderer.
 * Every marker must correspond to declared workspace node metadata in the same
 * module/export, making stale or invented renderer identities fail closed.
 */
export function issueReactBindingCompilerEvidence(
  workspace: ReactSourceWorkspace
): ReactBindingCompilerEvidence {
  validateReactSourceWorkspace(workspace);
  const sourceNodes = new Map(workspace.nodes.map((node) => [node.nodeId, node]));
  const nodeMarkers: Array<ReactBindingCompilerEvidence['nodeMarkers'][number]> = [];
  const actionMarkers: Array<ReactBindingCompilerEvidence['actionMarkers'][number]> = [];
  const seenNodes = new Set<string>();
  const seenActions = new Set<string>();
  for (const file of workspace.files) {
    if (file.language !== 'tsx') continue;
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const exports = exportedNames(source);
    const exportName = exports.length === 1 ? exports[0] : undefined;
    if (exportName === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const sourceNodeId = literalAttribute(node, 'data-selene-node-id');
        if (sourceNodeId !== undefined) {
          const metadata = sourceNodes.get(sourceNodeId);
          if (
            metadata !== undefined &&
            metadata.path === file.path &&
            metadata.exportName === exportName
          ) {
            if (!seenNodes.has(sourceNodeId)) {
              seenNodes.add(sourceNodeId);
              nodeMarkers.push({ sourceNodeId, path: file.path, exportName, guards: [] });
            }
            const graphNodeId = literalAttribute(node, 'data-selene-flow-node');
            const portId = literalAttribute(node, 'data-selene-action-port');
            if (graphNodeId !== undefined && portId !== undefined) {
              const key = `${graphNodeId}\u0000${portId}`;
              if (!seenActions.has(key)) {
                seenActions.add(key);
                actionMarkers.push({
                  graphNodeId,
                  portId,
                  sourceNodeId,
                  path: file.path,
                  exportName,
                  guards: []
                });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return parseReactBindingCompilerEvidence({
    format: 'selene-react-binding-evidence/v1',
    parserIdentity: '@typescript/typescript6@6.0.2',
    compilerIdentity: 'selene-vite-react-compiler/v1',
    projectId: workspace.projectId,
    sourceRevisionId: workspace.revision.id,
    sourceSha256: sourceDigest(workspace),
    entrypoint: workspace.entrypoint,
    reachableFiles: workspace.files
      .filter((file) => file.language === 'tsx')
      .map((file) => file.path)
      .sort(),
    nodeMarkers,
    actionMarkers
  });
}

/** Reissues evidence from current bytes; persisted evidence is not an authority. */
export function validateCurrentReactBindingEvidence(
  value: unknown,
  workspace: ReactSourceWorkspace
): ReactBindingCompilerEvidence {
  const issued = issueReactBindingCompilerEvidence(workspace);
  const candidate = parseReactBindingCompilerEvidence(value);
  if (serializeCanonicalData(candidate) !== serializeCanonicalData(issued))
    throw new Error('React binding compiler evidence is stale.');
  return issued;
}
