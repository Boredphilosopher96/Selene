import * as ts from '@selene/tsx-compiler-api';
import type { ReactSourceWorkspace } from '@selene/core';

/** Source dependency declarations are inspected without loading package code. */
export function sourceDesignInputUsage(
  workspace: ReactSourceWorkspace,
  removedPackages: readonly string[]
): readonly { readonly path: string; readonly packageName: string }[] {
  const usages: { path: string; packageName: string }[] = [];
  for (const file of workspace.files) {
    if (file.language !== 'tsx' && file.language !== 'ts') continue;
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      file.language === 'tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const record = (specifier: ts.Node | undefined) => {
      if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return;
      for (const packageName of removedPackages)
        if (specifier.text === packageName || specifier.text.startsWith(`${packageName}/`))
          usages.push({ path: file.path, packageName });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        record(node.moduleSpecifier);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
        record(node.moduleReference.expression);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        record(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [
    ...new Map(usages.map((usage) => [`${usage.path}\0${usage.packageName}`, usage])).values()
  ];
}
