#!/usr/bin/env node
// Dependency-free checks for the protocol fixtures. Full validation belongs to
// a draft 2020-12 JSON Schema validator in the consuming host/toolchain.
import { readFileSync } from 'node:fs';

const directory = new URL('.', import.meta.url);
const loadJsonl = (name) =>
  readFileSync(new URL(name, directory), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const capabilityPattern = /^[a-z][a-z0-9.-]{0,127}$/;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

function hasDateTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function conforms(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.protocolVersion !== '1.0') return false;
  if (!['hello', 'request', 'event', 'cancel', 'error'].includes(message.kind)) return false;
  if (!idPattern.test(message.messageId ?? '') || !hasDateTime(message.sentAt)) return false;
  if (message.requestId !== undefined && !idPattern.test(message.requestId)) return false;
  if (
    message.capabilities !== undefined &&
    (!Array.isArray(message.capabilities) ||
      new Set(message.capabilities).size !== message.capabilities.length ||
      !message.capabilities.every((value) => capabilityPattern.test(value)))
  )
    return false;

  switch (message.kind) {
    case 'hello':
      return Array.isArray(message.capabilities);
    case 'request':
      return (
        idPattern.test(message.requestId ?? '') &&
        capabilityPattern.test(message.operation ?? '') &&
        message.input !== null &&
        typeof message.input === 'object' &&
        !Array.isArray(message.input)
      );
    case 'event':
      return idPattern.test(message.requestId ?? '') && capabilityPattern.test(message.event ?? '');
    case 'cancel':
      return idPattern.test(message.requestId ?? '');
    case 'error':
      return (
        codePattern.test(message.code ?? '') &&
        typeof message.message === 'string' &&
        message.message.length <= 4096
      );
    default:
      return false;
  }
}

const valid = loadJsonl('fixtures/valid.jsonl');
const invalid = loadJsonl('fixtures/invalid.jsonl');
const failures = [
  ...valid
    .filter((message) => !conforms(message))
    .map((message) => `valid fixture rejected: ${message.messageId}`),
  ...invalid.filter(conforms).map((message) => `invalid fixture accepted: ${message.messageId}`)
];

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`validated ${valid.length} valid and ${invalid.length} invalid v1 fixtures`);
}
