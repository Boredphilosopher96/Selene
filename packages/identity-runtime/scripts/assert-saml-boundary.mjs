import { readFile } from 'node:fs/promises';

const root = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
const saml = await readFile(new URL('../dist/saml.js', import.meta.url), 'utf8');
const rootSource = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

function moduleSpecifiers(source) {
  const tokens = moduleTokens(source);
  const specifiers = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (token.kind === 'word' && token.value === 'import' && next?.kind === 'string') {
      specifiers.push(next.value);
      continue;
    }
    if (
      token.kind === 'word' &&
      token.value === 'import' &&
      next?.value === '(' &&
      tokens[index + 2]?.kind === 'string' &&
      tokens[index + 3]?.value === ')'
    ) {
      specifiers.push(tokens[index + 2].value);
      continue;
    }
    if (token.kind !== 'word' || (token.value !== 'import' && token.value !== 'export')) continue;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value === ';') break;
      if (
        tokens[cursor].kind === 'word' &&
        tokens[cursor].value === 'from' &&
        tokens[cursor + 1]?.kind === 'string'
      ) {
        specifiers.push(tokens[cursor + 1].value);
        break;
      }
    }
  }
  return specifiers;
}

function moduleTokens(source) {
  const tokens = [];
  for (let index = 0; index < source.length;) {
    const character = source[index];
    if (/\s/.test(character)) {
      index += 1;
    } else if (character === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index + 2);
      if (index < 0) break;
    } else if (character === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (character === '"' || character === "'") {
      const quote = character;
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        value += source[index];
        index += 1;
      }
      if (source[index] === quote) index += 1;
      tokens.push({ kind: 'string', value });
    } else if (character === '`') {
      index += 1;
      while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\' && index + 1 < source.length) index += 1;
        index += 1;
      }
      index += 1;
    } else if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
      tokens.push({ kind: 'word', value: source.slice(start, index) });
    } else {
      tokens.push({ kind: 'punct', value: character });
      index += 1;
    }
  }
  return tokens;
}

if (
  root.includes('@node-saml/node-saml') ||
  moduleSpecifiers(rootSource).some(
    (specifier) =>
      specifier === '@node-saml/node-saml' ||
      /^\.\/saml(?:\.js)?(?:\/|$)/.test(specifier) ||
      /^@selene\/identity-runtime\/saml(?:\/|$)/.test(specifier)
  )
) {
  throw new Error('identity-runtime root entry must not import Node-SAML');
}
if (!saml.includes('@node-saml/node-saml')) {
  throw new Error('identity-runtime SAML entry must retain the Node-SAML runtime import');
}
