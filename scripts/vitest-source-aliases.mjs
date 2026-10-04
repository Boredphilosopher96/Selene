// Reuse the pinned parser API already required by the preview adapter. A raw
// scanner cannot distinguish template/regex text from code without a parser's
// contextual rescans; TS 7's bare scanner can even return zero-width tokens.
import * as ts from '@selene/preview-adapter-typescript6-api';

export function sourceSpecifiers(source, file = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  if (sourceFile.parseDiagnostics.length > 0) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(
      `Cannot check Vitest source aliases in ${file}:${line + 1}:${character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`
    );
  }
  const specifiers = [];
  function record(literal) {
    if (
      literal &&
      (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) &&
      literal.text.startsWith('@selene/')
    )
      specifiers.push(literal.text);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      record(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node.argument.literal);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

export function missingAliasEntries(specifiers, availableAliases, workspaceNames) {
  const missingEntries = [];
  for (const [specifier, file] of specifiers) {
    const packageName = specifier.split('/').slice(0, 2).join('/');
    if (!workspaceNames.has(packageName)) continue;
    const isExactPackageImport = specifier === packageName;
    const covered =
      availableAliases.has(specifier) ||
      (isExactPackageImport && availableAliases.has(packageName));
    if (!covered) missingEntries.push(`${specifier} (${file})`);
  }
  return missingEntries;
}
