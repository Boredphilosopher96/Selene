/** Provider-neutral enterprise governance contracts. Hosts own identities, keys, storage, and transport. */
export const enterpriseSecurityFormat = 'selene-enterprise-security/v2' as const;

export class EnterpriseSecurityError extends Error {
  public constructor(message: unknown) {
    super(publicErrorMessage(message));
    this.name = 'EnterpriseSecurityError';
  }
}

function publicErrorMessage(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    ? value
    : 'enterprise security error';
}

const issuedEnterpriseErrors = new WeakSet<object>();
const issuedManagedKeyErrors = new WeakSet<object>();

function enterpriseError(message: string): EnterpriseSecurityError {
  const error = new EnterpriseSecurityError(message);
  issuedEnterpriseErrors.add(error);
  return error;
}

function isIssuedEnterpriseSecurityError(error: unknown): error is EnterpriseSecurityError {
  return typeof error === 'object' && error !== null && issuedEnterpriseErrors.has(error);
}

function managedKeyError(code: ManagedKeyError['code'], message: string): ManagedKeyError {
  const error = new ManagedKeyError(code, message);
  issuedEnterpriseErrors.add(error);
  issuedManagedKeyErrors.add(error);
  return error;
}

function isIssuedManagedKeyError(error: unknown): error is ManagedKeyError {
  return typeof error === 'object' && error !== null && issuedManagedKeyErrors.has(error);
}

/**
 * Provider-neutral cancellation evidence supplied by a trusted host adapter.
 * The core only forwards it to a provider port; lifetime supervision belongs
 * to the host runtime rather than this portable package.
 */
export interface AdapterCallContext {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

type ExactPortMethod = (...arguments_: readonly unknown[]) => unknown;

interface CapturedPort {
  readonly target: object;
  readonly methods: Readonly<Record<string, ExactPortMethod>>;
}

/** Capture host-owned port methods once; never re-read a mutable public port. */
function capturePort(value: unknown, names: readonly string[], field: string): CapturedPort {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw enterpriseError(`${field} is invalid`);
  if (names.length === 0 || names.length > 16 || new Set(names).size !== names.length)
    throw enterpriseError(`${field} is invalid`);
  const methods: Record<string, ExactPortMethod> = Object.create(null);
  for (const name of names) {
    let target: object | null = value;
    let captured: PropertyDescriptor | undefined;
    const visited = new Set<object>();
    for (let depth = 0; target !== null && depth < 8; depth += 1) {
      if (visited.has(target)) throw enterpriseError(`${field} is invalid`);
      visited.add(target);
      try {
        const descriptor = Object.getOwnPropertyDescriptor(target, name);
        if (descriptor !== undefined) {
          captured = descriptor;
          break;
        }
        target = Object.getPrototypeOf(target);
      } catch {
        throw enterpriseError(`${field} is invalid`);
      }
    }
    if (
      captured === undefined ||
      !Object.prototype.hasOwnProperty.call(captured, 'value') ||
      typeof captured.value !== 'function'
    ) {
      throw enterpriseError(`${field}.${name} must be a data method`);
    }
    Object.defineProperty(methods, name, {
      value: captured.value as ExactPortMethod,
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze({ target: value, methods: Object.freeze(methods) });
}

function invokePort<T>(
  port: CapturedPort,
  name: string,
  arguments_: readonly unknown[]
): Promise<T> {
  const method = port.methods[name];
  if (method === undefined)
    return Promise.reject(enterpriseError('captured port method is missing'));
  try {
    return Promise.resolve(Reflect.apply(method, port.target, arguments_)).catch(() => {
      throw enterpriseError('host port invocation failed');
    }) as Promise<T>;
  } catch {
    return Promise.reject(enterpriseError('host port invocation failed'));
  }
}

function captureCallback(value: unknown, field: string): ExactPortMethod {
  if (typeof value !== 'function') throw enterpriseError(`${field} is invalid`);
  return value as ExactPortMethod;
}

function invokeCallback<T>(callback: ExactPortMethod, arguments_: readonly unknown[]): Promise<T> {
  try {
    return Promise.resolve(Reflect.apply(callback, undefined, arguments_)).catch(() => {
      throw enterpriseError('host callback failed');
    }) as Promise<T>;
  } catch {
    return Promise.reject(enterpriseError('host callback failed'));
  }
}

const encoder = new TextEncoder();
const MAX_TEXT_BYTES = 4_096;
const MAX_ARRAY_ITEMS = 64;
const MAX_SIGNATURE_BYTES = 16_384;
const MAX_ENTITLEMENT_TTL_SECONDS = 86_400;
const MAX_ENTITLEMENT_GRACE_SECONDS = 3_600;
const MAX_SIEM_LEASE_SECONDS = 300;
const MAX_WATERMARK_BYTES = 512;
const MAX_RECORD_FIELDS = 64;
const MAX_AGGREGATE_DATA_ITEMS = 512;
const MAX_AGGREGATE_DATA_BYTES = 1_048_576;
const MAX_DATA_STRING_CODE_UNITS = 1_048_576;
const policyFields = Object.freeze([
  'format',
  'policyId',
  'policyVersion',
  'tenantId',
  'audience',
  'capabilities',
  'residency',
  'allowedIpCidrs',
  'sessionMaxAgeSeconds',
  'entitlementTtlSeconds',
  'entitlementGraceSeconds',
  'minimumAccessVersion',
  'minimumSessionVersion'
]);
const signedPolicyFields = Object.freeze([
  'format',
  'organizationId',
  'revision',
  'issuedAt',
  'expiresAt',
  'policy',
  'digest',
  'signature',
  'keyId'
]);
const entitlementFields = Object.freeze([
  'format',
  'entitlementVersion',
  'tenantId',
  'providerId',
  'audience',
  'resource',
  'policyId',
  'policyVersion',
  'subjectId',
  'revision',
  'issuedAt',
  'expiresAt',
  'capabilities',
  'digest',
  'signature',
  'keyId'
]);
const compiledPolicyBrand = Symbol('compiled-enterprise-policy');
const trustedSessionBrand = Symbol('trusted-session-evidence');
const compiledPolicies = new WeakSet<object>();
const activatedSignedPolicies = new WeakSet<object>();
const activatedPolicyStores = new WeakMap<object, CapturedPolicyRevisionStore>();
const trustedSessions = new WeakSet<object>();

function bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function text(value: unknown, field: string, maximum = MAX_TEXT_BYTES): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw enterpriseError(
      `${field} must be a non-blank UTF-8 string no larger than ${maximum} bytes`
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || bytes(value) > maximum || value.length > maximum) {
    throw enterpriseError(
      `${field} must be a non-blank UTF-8 string no larger than ${maximum} bytes`
    );
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field, 256);
  if (!/^[a-z][a-z0-9._-]{0,255}$/.test(result))
    throw enterpriseError(`${field} is not a valid identifier`);
  return result;
}

function canonicalInstant(value: unknown, field: string): string {
  const result = text(value, field, 30);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) ||
    new Date(result).toISOString() !== result
  ) {
    throw enterpriseError(`${field} must be a canonical UTC ISO-8601 instant`);
  }
  return result;
}

function instantMs(value: string): number {
  return Date.parse(value);
}

function frozen<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

/**
 * Public objects are sampled once through their own data descriptors. This
 * rejects getters and avoids reading a proxy twice while validating it.
 */
interface DataBudget {
  remaining: number;
  remainingBytes: number;
}

function consumeDataBudget(budget: DataBudget): void {
  budget.remaining -= 1;
  if (budget.remaining < 0) throw enterpriseError('public data exceeds aggregate item bound');
}

function consumeDataBytes(budget: DataBudget, length: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > budget.remainingBytes)
    throw enterpriseError('public data exceeds aggregate byte bound');
  budget.remainingBytes -= length;
}

function ownDescriptor(
  value: object,
  key: PropertyKey,
  field: string
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw enterpriseError(`${field} descriptor capture failed`);
  }
}

function dataRecord(
  value: unknown,
  field: string,
  allowedKeys?: readonly string[],
  budget: DataBudget = {
    remaining: MAX_AGGREGATE_DATA_ITEMS,
    remainingBytes: MAX_AGGREGATE_DATA_BYTES
  }
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw enterpriseError(`${field} must be an object`);
  consumeDataBudget(budget);
  let keys: readonly PropertyKey[];
  const named = new Map<string, PropertyDescriptor | undefined>();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw enterpriseError(`${field} must be an exact Object/null data record`);
    if (allowedKeys !== undefined) {
      for (const key of allowedKeys) named.set(key, ownDescriptor(value, key, field));
    }
    keys = Reflect.ownKeys(value);
  } catch {
    throw enterpriseError(`${field} must be an object`);
  }
  if (
    keys.length > MAX_RECORD_FIELDS ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        key.length > 256 ||
        (allowedKeys !== undefined && !allowedKeys.includes(key))
    )
  )
    throw enterpriseError(`${field} has too many fields`);
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor =
      typeof key === 'string' && named.has(key) ? named.get(key) : ownDescriptor(value, key, field);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    )
      throw enterpriseError(`${field} must not use accessor fields`);
    Object.defineProperty(copy, key, {
      value: dataValue(descriptor.value, `${field}.${String(key)}`, budget),
      enumerable: true,
      configurable: false,
      writable: false
    });
  }
  return Object.freeze(copy);
}

/** Own a bounded public array without invoking its iterator or element getters. */
function dataArray(
  value: unknown,
  field: string,
  budget: DataBudget = {
    remaining: MAX_AGGREGATE_DATA_ITEMS,
    remainingBytes: MAX_AGGREGATE_DATA_BYTES
  }
): readonly unknown[] {
  if (!Array.isArray(value)) throw enterpriseError(`${field} must be an array`);
  consumeDataBudget(budget);
  let keys: readonly PropertyKey[];
  let length: PropertyDescriptor | undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype)
      throw enterpriseError(`${field} must be an exact Array`);
    length = ownDescriptor(value, 'length', field);
  } catch {
    throw enterpriseError(`${field} must be an array`);
  }
  if (
    length === undefined ||
    !Object.prototype.hasOwnProperty.call(length, 'value') ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > MAX_ARRAY_ITEMS
  ) {
    throw enterpriseError(`${field} must contain at most ${MAX_ARRAY_ITEMS} items`);
  }
  const descriptors = new Map<string, PropertyDescriptor>();
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = ownDescriptor(value, String(index), field);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    )
      throw enterpriseError(`${field} must be a dense data array`);
    descriptors.set(String(index), descriptor);
  }
  keys = (() => {
    try {
      return Reflect.ownKeys(value);
    } catch {
      throw enterpriseError(`${field} key capture failed`);
    }
  })();
  if (
    keys.length !== length.value + 1 ||
    keys.some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' || key.length > 16 || !/^(0|[1-9]\d*)$/.test(key))
    )
  ) {
    throw enterpriseError(`${field} must be a dense data array`);
  }
  const copy: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = descriptors.get(String(index));
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    )
      throw enterpriseError(`${field} must be a dense data array`);
    copy.push(dataValue(descriptor.value, `${field}[${index}]`, budget));
  }
  return Object.freeze(copy);
}

function dataValue(value: unknown, field: string, budget: DataBudget): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > MAX_DATA_STRING_CODE_UNITS)
      throw enterpriseError(`${field} exceeds code-unit bound`);
    consumeDataBytes(budget, bytes(value));
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw enterpriseError(`${field} must be finite`);
    return value;
  }
  if (typeof value !== 'object') throw enterpriseError(`${field} must be data`);
  // Host-issued session evidence is already immutable and privately branded;
  // copying it would erase the provenance required for external authorization.
  if (trustedSessions.has(value)) return value;
  if (Array.isArray(value)) return dataArray(value, field, budget);
  try {
    if (Object.getPrototypeOf(value) === Uint8Array.prototype) {
      const checked = checkedBytes(value, field);
      consumeDataBudget(budget);
      consumeDataBytes(budget, checked.length);
      const copy = new Uint8Array(checked.length);
      copy.set(checked.source);
      return copy;
    }
  } catch (error) {
    if (isIssuedEnterpriseSecurityError(error)) throw error;
    throw enterpriseError(`${field} must be usable data`);
  }
  return dataRecord(value, field, undefined, budget);
}

function uniqueStrings(
  value: unknown,
  field: string,
  validator: (value: unknown, field: string) => string
): readonly string[] {
  const copied = dataArray(value, field).map((item) => validator(item, field));
  if (new Set(copied).size !== copied.length)
    throw enterpriseError(`${field} must not contain duplicates`);
  return Object.freeze(copied);
}

/** Extensible capability names must have a provider-neutral namespace, e.g. `selene:workspace.read`. */
export type SecurityCapability = string;

function capability(value: unknown, field: string): SecurityCapability {
  const result = text(value, field, 192);
  if (!/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9./-]{0,127}$/.test(result)) {
    throw enterpriseError(`${field} must be a namespaced capability`);
  }
  return result;
}

function parseIpv4(value: string): bigint | undefined {
  const parts = value.split('.');
  if (
    parts.length !== 4 ||
    !parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
  )
    return undefined;
  return parts.reduce((total, part) => total * 256n + BigInt(Number(part)), 0n);
}

function parseIpv6(value: string): bigint | undefined {
  if (value.includes('.')) return undefined;
  const halves = value.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] === '' ? [] : halves[0]?.split(':');
  const right = halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':');
  if (left === undefined || right === undefined || left.length + right.length > 8) return undefined;
  const groups =
    halves.length === 2
      ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
      : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group)))
    return undefined;
  return groups.reduce((total, group) => total * 65536n + BigInt(`0x${group}`), 0n);
}

interface ParsedIp {
  readonly bits: number;
  readonly value: bigint;
}

function parseIp(value: unknown, field: string): ParsedIp {
  const candidate = text(value, field, 64);
  const v4 = parseIpv4(candidate);
  if (v4 !== undefined) return frozen({ bits: 32, value: v4 });
  const v6 = parseIpv6(candidate);
  if (v6 === undefined) throw enterpriseError(`${field} is not an IP address`);
  return frozen({ bits: 128, value: v6 });
}

export interface CompiledCidr {
  readonly source: string;
  readonly bits: number;
  readonly prefix: number;
  readonly network: bigint;
}

function compileCidr(value: unknown): CompiledCidr {
  const source = text(value, 'allowed IP CIDR', 80);
  const [address, prefixValue] = source.split('/');
  if (
    address === undefined ||
    prefixValue === undefined ||
    source.split('/').length !== 2 ||
    !/^\d{1,3}$/.test(prefixValue)
  ) {
    throw enterpriseError('allowed IP CIDR is invalid');
  }
  const parsed = parseIp(address, 'CIDR address');
  const prefix = Number(prefixValue);
  if (prefix > parsed.bits) throw enterpriseError('CIDR prefix is outside its address family');
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(parsed.bits - prefix);
  if ((parsed.value & mask) !== parsed.value)
    throw enterpriseError('CIDR network bits must be canonical');
  return frozen({ source, bits: parsed.bits, prefix, network: parsed.value });
}

function cidrMatches(ip: ParsedIp, cidr: CompiledCidr): boolean {
  if (ip.bits !== cidr.bits) return false;
  const mask =
    cidr.prefix === 0 ? 0n : ((1n << BigInt(cidr.prefix)) - 1n) << BigInt(ip.bits - cidr.prefix);
  return (ip.value & mask) === cidr.network;
}

export interface EnterprisePolicyInput {
  readonly format: typeof enterpriseSecurityFormat;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly tenantId: string;
  readonly audience: string;
  readonly capabilities: readonly SecurityCapability[];
  readonly residency: readonly string[];
  readonly allowedIpCidrs: readonly string[];
  readonly sessionMaxAgeSeconds: number;
  /** Maximum age of a signed external entitlement before it must be refreshed. */
  readonly entitlementTtlSeconds?: number;
  /** Bounded fail-closed provider-outage grace for a previously verified entitlement. */
  readonly entitlementGraceSeconds?: number;
}

/** Immutable validated policy; CIDRs are parsed once here, never from each hostile request. */
export type CompiledEnterprisePolicy = Readonly<{
  readonly format: typeof enterpriseSecurityFormat;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly tenantId: string;
  readonly audience: string;
  readonly capabilities: readonly SecurityCapability[];
  readonly residency: readonly string[];
  readonly allowedIpCidrs: readonly CompiledCidr[];
  readonly sessionMaxAgeSeconds: number;
  readonly entitlementTtlSeconds: number;
  readonly entitlementGraceSeconds: number;
  readonly minimumAccessVersion: number;
  readonly minimumSessionVersion: number;
  readonly [compiledPolicyBrand]: true;
}>;

export function compileEnterprisePolicy(value: unknown): CompiledEnterprisePolicy {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('policy must be an object');
  const input = dataRecord(value, 'policy', policyFields);
  if (input.format !== enterpriseSecurityFormat)
    throw enterpriseError('unsupported enterprise policy format');
  const sessionMaxAgeSeconds = input.sessionMaxAgeSeconds;
  if (
    typeof sessionMaxAgeSeconds !== 'number' ||
    !Number.isFinite(sessionMaxAgeSeconds) ||
    !Number.isInteger(sessionMaxAgeSeconds) ||
    sessionMaxAgeSeconds < 60 ||
    sessionMaxAgeSeconds > 86_400
  ) {
    throw enterpriseError('sessionMaxAgeSeconds must be an integer from 60 to 86400');
  }
  const entitlementTtlSeconds = boundedSeconds(
    input.entitlementTtlSeconds ?? sessionMaxAgeSeconds,
    'entitlementTtlSeconds',
    MAX_ENTITLEMENT_TTL_SECONDS,
    60
  );
  const entitlementGraceSeconds = boundedSeconds(
    input.entitlementGraceSeconds ?? 0,
    'entitlementGraceSeconds',
    MAX_ENTITLEMENT_GRACE_SECONDS,
    0
  );
  const cidrs = uniqueStrings(input.allowedIpCidrs, 'allowedIpCidrs', text).map(compileCidr);
  if (cidrs.length === 0)
    throw enterpriseError('external policy requires at least one allowed IP CIDR');
  if (new Set(cidrs.map((cidr) => cidr.source)).size !== cidrs.length)
    throw enterpriseError('allowedIpCidrs must not contain duplicates');
  const compiled = {
    format: enterpriseSecurityFormat,
    policyId: identifier(input.policyId, 'policyId'),
    policyVersion: boundedPositiveInteger(input.policyVersion, 'policyVersion', 1_000_000),
    tenantId: identifier(input.tenantId, 'tenantId'),
    audience: identifier(input.audience, 'audience'),
    capabilities: uniqueStrings(input.capabilities, 'capabilities', capability),
    residency: uniqueStrings(input.residency, 'residency', identifier),
    allowedIpCidrs: Object.freeze(cidrs),
    sessionMaxAgeSeconds,
    entitlementTtlSeconds,
    entitlementGraceSeconds,
    minimumAccessVersion: boundedPositiveInteger(
      input.minimumAccessVersion ?? 1,
      'minimumAccessVersion',
      1_000_000
    ),
    minimumSessionVersion: boundedPositiveInteger(
      input.minimumSessionVersion ?? 1,
      'minimumSessionVersion',
      1_000_000
    )
  };
  Object.defineProperty(compiled, compiledPolicyBrand, { value: true });
  compiledPolicies.add(compiled);
  return frozen(compiled) as CompiledEnterprisePolicy;
}

function isCompiledPolicy(value: unknown): value is CompiledEnterprisePolicy {
  if (
    typeof value !== 'object' ||
    value === null ||
    !compiledPolicies.has(value) ||
    (value as Record<PropertyKey, unknown>)[compiledPolicyBrand] !== true ||
    !Object.isFrozen(value)
  )
    return false;
  const policy = value as CompiledEnterprisePolicy;
  return (
    Number.isSafeInteger(policy.sessionMaxAgeSeconds) &&
    policy.sessionMaxAgeSeconds >= 60 &&
    policy.sessionMaxAgeSeconds <= 86_400 &&
    Number.isSafeInteger(policy.entitlementTtlSeconds) &&
    policy.entitlementTtlSeconds >= 60 &&
    policy.entitlementTtlSeconds <= MAX_ENTITLEMENT_TTL_SECONDS &&
    Number.isSafeInteger(policy.entitlementGraceSeconds) &&
    policy.entitlementGraceSeconds >= 0 &&
    policy.entitlementGraceSeconds <= MAX_ENTITLEMENT_GRACE_SECONDS &&
    Object.isFrozen(policy.capabilities) &&
    Object.isFrozen(policy.residency) &&
    Object.isFrozen(policy.allowedIpCidrs) &&
    policy.allowedIpCidrs.every((cidr) => Object.isFrozen(cidr))
  );
}

/** Organization-scoped signed-policy guard; production stores retain high-water/revocation durably. */
export interface SignedPolicyEnvelope {
  readonly format: 'selene-signed-policy/v1';
  readonly organizationId: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly policy: unknown;
  /** SHA-256 of the exact signed policy payload, encoded as lowercase hex. */
  readonly digest: string;
  readonly signature: string;
  readonly keyId: string;
}
export interface PolicyVerificationResult {
  readonly verified: boolean;
  /** The verifier's digest of the bytes it actually verified. */
  readonly digest: string;
}
export interface PolicyVerifier {
  verify(envelope: Readonly<SignedPolicyEnvelope>): Promise<Readonly<PolicyVerificationResult>>;
}
export interface PolicyRevisionState {
  readonly revision: number;
  readonly revoked: boolean;
  readonly digest: string;
  readonly expiresAt: string;
}
export interface PolicyRevisionStore {
  read(
    organizationId: string,
    policyId: string
  ): Promise<Readonly<PolicyRevisionState> | undefined>;
  compareAndSet(
    organizationId: string,
    policyId: string,
    expected: Readonly<PolicyRevisionState> | undefined,
    next: Readonly<PolicyRevisionState>
  ): Promise<boolean>;
}

interface CapturedPolicyRevisionStore {
  readonly read: (
    organizationId: string,
    policyId: string
  ) => Promise<Readonly<PolicyRevisionState> | undefined>;
  readonly compareAndSet: (
    organizationId: string,
    policyId: string,
    expected: Readonly<PolicyRevisionState> | undefined,
    next: Readonly<PolicyRevisionState>
  ) => Promise<boolean>;
}

function ownPolicyRevisionStore(store: PolicyRevisionStore): CapturedPolicyRevisionStore {
  const captured = capturePort(store, ['read', 'compareAndSet'], 'policy revision store');
  return frozen({
    read: (organizationId, policyId) => invokePort(captured, 'read', [organizationId, policyId]),
    compareAndSet: (organizationId, policyId, expected, next) =>
      invokePort(captured, 'compareAndSet', [organizationId, policyId, expected, next])
  });
}

function sha256Digest(value: unknown, field: string): string {
  const digest = text(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(digest))
    throw enterpriseError(`${field} must be a lowercase SHA-256 digest`);
  return digest;
}

/**
 * The signed envelope is received from an untrusted boundary.  Keep a plain,
 * immutable snapshot while an asynchronous verifier is running: otherwise a
 * caller could replace its nested policy after verification but before it is
 * compiled.
 */
function snapshotSignedPolicy(value: unknown): unknown {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('signed policy payload must be an object');
  const input = dataRecord(value, 'signed policy payload', policyFields);
  const snapshot: Record<string, unknown> = {};
  for (const field of [
    'format',
    'policyId',
    'policyVersion',
    'tenantId',
    'audience',
    'sessionMaxAgeSeconds',
    'entitlementTtlSeconds',
    'entitlementGraceSeconds',
    'minimumAccessVersion',
    'minimumSessionVersion'
  ]) {
    if (Object.hasOwn(input, field)) snapshot[field] = input[field];
  }
  for (const field of ['capabilities', 'residency', 'allowedIpCidrs']) {
    const candidate = input[field];
    snapshot[field] = Array.isArray(candidate)
      ? dataArray(candidate, `signed policy ${field}`)
      : candidate;
  }
  return frozen(snapshot);
}

export type ActivatedSignedEnterprisePolicy = CompiledEnterprisePolicy &
  Readonly<{
    /** Non-secret evidence retained for audit and policy-store provenance. */
    readonly signedPolicy: Readonly<{
      readonly format: 'selene-signed-policy/v1';
      readonly organizationId: string;
      readonly revision: number;
      readonly issuedAt: string;
      readonly expiresAt: string;
      readonly digest: string;
      readonly keyId: string;
    }>;
  }>;

function isActivatedSignedPolicy(value: unknown): value is ActivatedSignedEnterprisePolicy {
  return isCompiledPolicy(value) && activatedSignedPolicies.has(value as object);
}

function normalizePolicyRevisionState(value: unknown): Readonly<PolicyRevisionState> {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('policy revision store result must be an object');
  const input = dataRecord(value, 'policy revision store result', [
    'revision',
    'revoked',
    'digest',
    'expiresAt'
  ]);
  if (input.revoked !== true && input.revoked !== false)
    throw enterpriseError('policy revision store revoked must be a boolean');
  return frozen({
    revision: boundedPositiveInteger(
      input.revision,
      'policy revision store revision',
      Number.MAX_SAFE_INTEGER
    ),
    revoked: input.revoked,
    digest: sha256Digest(input.digest, 'policy revision store digest'),
    expiresAt: canonicalInstant(input.expiresAt, 'policy revision store expiresAt')
  });
}

export async function activateSignedPolicy(
  value: unknown,
  now: unknown,
  verifier: PolicyVerifier,
  store: PolicyRevisionStore
): Promise<ActivatedSignedEnterprisePolicy> {
  const capturedStore = ownPolicyRevisionStore(store);
  const capturedVerifier = capturePort(verifier, ['verify'], 'policy verifier');
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('signed policy must be an object');
  const input = dataRecord(value, 'signed policy', signedPolicyFields);
  if (input.format !== 'selene-signed-policy/v1')
    throw enterpriseError('unsupported signed policy format');
  const policySnapshot = snapshotSignedPolicy(input.policy);
  const envelope = frozen({
    format: 'selene-signed-policy/v1' as const,
    organizationId: identifier(input.organizationId, 'organizationId'),
    revision: boundedPositiveInteger(input.revision, 'policy revision', Number.MAX_SAFE_INTEGER),
    issuedAt: canonicalInstant(input.issuedAt, 'policy issuedAt'),
    expiresAt: canonicalInstant(input.expiresAt, 'policy expiresAt'),
    policy: policySnapshot,
    digest: sha256Digest(input.digest, 'policy digest'),
    signature: text(input.signature, 'policy signature', MAX_SIGNATURE_BYTES),
    keyId: text(input.keyId, 'policy keyId', 512)
  });
  const current = canonicalInstant(now, 'now');
  if (
    instantMs(envelope.issuedAt) > instantMs(current) ||
    instantMs(envelope.expiresAt) <= instantMs(current) ||
    instantMs(envelope.expiresAt) <= instantMs(envelope.issuedAt)
  )
    throw enterpriseError('signed policy timing is invalid');
  let verification: Readonly<Record<string, unknown>>;
  try {
    verification = dataRecord(
      await invokePort(capturedVerifier, 'verify', [envelope]),
      'policy verification result',
      ['verified', 'digest']
    );
  } catch {
    throw enterpriseError('policy verifier unavailable');
  }
  if (
    typeof verification !== 'object' ||
    verification === null ||
    verification.verified !== true ||
    sha256Digest(verification.digest, 'verified policy digest') !== envelope.digest
  )
    throw enterpriseError('policy signature or digest was rejected');
  const policy = compileEnterprisePolicy(envelope.policy);
  let stored: Readonly<PolicyRevisionState> | undefined;
  try {
    stored = await capturedStore.read(envelope.organizationId, policy.policyId);
  } catch {
    throw enterpriseError('policy revision store unavailable');
  }
  const previous = stored === undefined ? undefined : normalizePolicyRevisionState(stored);
  if (
    previous !== undefined &&
    (previous.revoked !== false ||
      previous.revision > envelope.revision ||
      (previous.revision === envelope.revision &&
        (previous.digest !== envelope.digest || previous.expiresAt !== envelope.expiresAt)))
  )
    throw enterpriseError('policy is revoked or downgraded');
  if (previous === undefined || previous.revision < envelope.revision) {
    let updated: boolean;
    try {
      updated = await capturedStore.compareAndSet(
        envelope.organizationId,
        policy.policyId,
        previous,
        frozen({
          revision: envelope.revision,
          revoked: false,
          digest: envelope.digest,
          expiresAt: envelope.expiresAt
        })
      );
    } catch {
      throw enterpriseError('policy revision store unavailable');
    }
    if (updated !== true && updated !== false)
      throw enterpriseError('policy revision store must return a boolean');
    if (!updated) throw enterpriseError('policy high-water store conflict');
  }
  const activated = {
    ...policy,
    signedPolicy: frozen({
      format: envelope.format,
      organizationId: envelope.organizationId,
      revision: envelope.revision,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      digest: envelope.digest,
      keyId: envelope.keyId
    })
  };
  Object.defineProperty(activated, compiledPolicyBrand, { value: true });
  compiledPolicies.add(activated);
  activatedSignedPolicies.add(activated);
  activatedPolicyStores.set(activated, capturedStore);
  return frozen(activated) as ActivatedSignedEnterprisePolicy;
}

function boundedPositiveInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw enterpriseError(`${field} must be an integer from 1 to ${maximum}`);
  }
  return value as number;
}

function boundedSeconds(value: unknown, field: string, maximum: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw enterpriseError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

export interface ExternalEntitlement {
  readonly format: 'selene-external-entitlement/v2';
  readonly entitlementVersion: number;
  readonly tenantId: string;
  readonly providerId: string;
  readonly audience: string;
  readonly resource: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly subjectId: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly capabilities: readonly SecurityCapability[];
  /** SHA-256 of the exact signed entitlement payload. */
  readonly digest: string;
  readonly signature: string;
  readonly keyId: string;
}

export type VerifiedEntitlement = ExternalEntitlement;

function normalizeEntitlement(value: unknown): VerifiedEntitlement {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('entitlement must be an object');
  const input = dataRecord(value, 'external entitlement', entitlementFields);
  if (input.format !== 'selene-external-entitlement/v2')
    throw enterpriseError('unsupported entitlement format');
  const issuedAt = canonicalInstant(input.issuedAt, 'entitlement issuedAt');
  const expiresAt = canonicalInstant(input.expiresAt, 'entitlement expiresAt');
  if (instantMs(expiresAt) <= instantMs(issuedAt))
    throw enterpriseError('entitlement expiresAt must follow issuedAt');
  return frozen({
    format: 'selene-external-entitlement/v2' as const,
    entitlementVersion: boundedPositiveInteger(
      input.entitlementVersion,
      'entitlementVersion',
      1_000_000
    ),
    tenantId: identifier(input.tenantId, 'entitlement tenantId'),
    providerId: identifier(input.providerId, 'providerId'),
    audience: identifier(input.audience, 'entitlement audience'),
    resource: identifier(input.resource, 'resource'),
    policyId: identifier(input.policyId, 'entitlement policyId'),
    policyVersion: boundedPositiveInteger(
      input.policyVersion,
      'entitlement policyVersion',
      1_000_000
    ),
    subjectId: identifier(input.subjectId, 'subjectId'),
    revision: boundedPositiveInteger(input.revision, 'revision', Number.MAX_SAFE_INTEGER),
    issuedAt,
    expiresAt,
    capabilities: uniqueStrings(input.capabilities, 'entitlement capabilities', capability),
    digest: sha256Digest(input.digest, 'entitlement digest'),
    signature: text(input.signature, 'signature', MAX_SIGNATURE_BYTES),
    keyId: text(input.keyId, 'keyId', 512)
  });
}

/** Host-owned verifier: it may call an IdP, HSM, KMS, or offline verifier. */
export interface EntitlementVerifier {
  verify(
    entitlement: Readonly<VerifiedEntitlement>,
    context?: AdapterCallContext
  ): Promise<boolean | 'valid' | 'invalid' | 'unavailable'>;
}

export interface RevisionNamespace {
  readonly tenantId: string;
  readonly providerId: string;
  readonly audience: string;
  readonly subjectId: string;
  readonly resource: string;
}

export interface RevisionState {
  readonly revision: number;
  readonly revoked: boolean;
  /** Digest of the last cryptographically verified entitlement at this revision. */
  readonly digest: string;
  /** Canonical expiry of the last cryptographically verified entitlement. */
  readonly expiresAt: string;
}

/** Durable implementation required in production. All writes must be atomic per namespace. */
export interface RevisionStore {
  read(namespace: Readonly<RevisionNamespace>): Promise<Readonly<RevisionState> | undefined>;
  compareAndSet(
    namespace: Readonly<RevisionNamespace>,
    expected: Readonly<RevisionState> | undefined,
    next: Readonly<RevisionState>
  ): Promise<boolean>;
  revoke(
    namespace: Readonly<RevisionNamespace>,
    revision: number
  ): Promise<Readonly<RevisionState>>;
}

interface CapturedRevisionStore {
  readonly read: (
    namespace: Readonly<RevisionNamespace>
  ) => Promise<Readonly<RevisionState> | undefined>;
  readonly compareAndSet: (
    namespace: Readonly<RevisionNamespace>,
    expected: Readonly<RevisionState> | undefined,
    next: Readonly<RevisionState>
  ) => Promise<boolean>;
  readonly revoke: (
    namespace: Readonly<RevisionNamespace>,
    revision: number
  ) => Promise<Readonly<RevisionState>>;
}

function ownRevisionStore(store: RevisionStore): CapturedRevisionStore {
  const captured = capturePort(store, ['read', 'compareAndSet', 'revoke'], 'revision store');
  return frozen({
    read: (revisionKey) => invokePort(captured, 'read', [revisionKey]),
    compareAndSet: (revisionKey, expected, next) =>
      invokePort(captured, 'compareAndSet', [revisionKey, expected, next]),
    revoke: (revisionKey, revision) => invokePort(captured, 'revoke', [revisionKey, revision])
  });
}

function namespace(entitlement: VerifiedEntitlement): RevisionNamespace {
  return frozen({
    tenantId: entitlement.tenantId,
    providerId: entitlement.providerId,
    audience: entitlement.audience,
    subjectId: entitlement.subjectId,
    resource: entitlement.resource
  });
}

function sameState(left: RevisionState | undefined, right: RevisionState | undefined): boolean {
  return (
    left?.revision === right?.revision &&
    left?.revoked === right?.revoked &&
    left?.digest === right?.digest &&
    left?.expiresAt === right?.expiresAt
  );
}

function normalizeRevisionState(value: unknown, field: string): Readonly<RevisionState> {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError(`${field} must be an object`);
  const input = dataRecord(value, 'revision state', ['revision', 'revoked', 'digest', 'expiresAt']);
  if (input.revoked !== true && input.revoked !== false)
    throw enterpriseError(`${field}.revoked must be a boolean`);
  return frozen({
    revision: boundedPositiveInteger(input.revision, `${field}.revision`, Number.MAX_SAFE_INTEGER),
    revoked: input.revoked,
    digest: sha256Digest(input.digest, `${field}.digest`),
    expiresAt: canonicalInstant(input.expiresAt, `${field}.expiresAt`)
  });
}

async function readRevisionState(
  store: CapturedRevisionStore,
  key: Readonly<RevisionNamespace>
): Promise<Readonly<RevisionState> | undefined> {
  const state = await store.read(frozen({ ...key }));
  return state === undefined ? undefined : normalizeRevisionState(state, 'revision store result');
}

async function compareRevisionState(
  store: CapturedRevisionStore,
  key: Readonly<RevisionNamespace>,
  expected: Readonly<RevisionState> | undefined,
  next: Readonly<RevisionState>
): Promise<boolean> {
  const result = await store.compareAndSet(
    frozen({ ...key }),
    expected === undefined ? undefined : frozen({ ...expected }),
    normalizeRevisionState(next, 'next revision state')
  );
  if (result !== true && result !== false)
    throw enterpriseError('revision store compareAndSet must return a boolean');
  return result;
}

/** Test fixture only. It fails closed at capacity and never evicts revision high-water marks. */
export class InMemoryRevisionStore implements RevisionStore {
  private readonly values = new Map<string, Readonly<RevisionState>>();
  public constructor(private readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000)
      throw enterpriseError('revision store capacity is invalid');
  }
  private key(value: Readonly<RevisionNamespace>): string {
    return [value.tenantId, value.providerId, value.audience, value.subjectId, value.resource].join(
      '\u001f'
    );
  }
  public async read(
    value: Readonly<RevisionNamespace>
  ): Promise<Readonly<RevisionState> | undefined> {
    const state = this.values.get(this.key(value));
    return state === undefined ? undefined : frozen({ ...state });
  }
  public async compareAndSet(
    value: Readonly<RevisionNamespace>,
    expected: Readonly<RevisionState> | undefined,
    next: Readonly<RevisionState>
  ): Promise<boolean> {
    const key = this.key(value);
    const current = this.values.get(key);
    if (!sameState(current, expected)) return false;
    if (current === undefined && this.values.size >= this.capacity)
      throw enterpriseError('revision store capacity reached; failing closed');
    this.values.set(
      key,
      frozen({
        revision: boundedPositiveInteger(next.revision, 'revision', Number.MAX_SAFE_INTEGER),
        revoked: next.revoked === true,
        digest: sha256Digest(next.digest, 'revision digest'),
        expiresAt: canonicalInstant(next.expiresAt, 'revision expiresAt')
      })
    );
    return true;
  }
  public async revoke(
    value: Readonly<RevisionNamespace>,
    revision: number
  ): Promise<Readonly<RevisionState>> {
    const key = this.key(value);
    const current = this.values.get(key);
    const nextRevision = Math.max(
      current?.revision ?? 0,
      boundedPositiveInteger(revision, 'revision', Number.MAX_SAFE_INTEGER)
    );
    if (current === undefined && this.values.size >= this.capacity)
      throw enterpriseError('revision store capacity reached; failing closed');
    const next = frozen({
      revision: nextRevision,
      revoked: true,
      digest: current?.digest ?? '0'.repeat(64),
      expiresAt: current?.expiresAt ?? '1970-01-01T00:00:00.000Z'
    });
    this.values.set(key, next);
    return frozen({ ...next });
  }
}

/** Opaque references and ciphertext only; this contract intentionally never models raw key bytes. */
export class ManagedKeyError extends EnterpriseSecurityError {
  public constructor(code: unknown, message: unknown) {
    super(message);
    this.name = 'ManagedKeyError';
    this.code =
      code === 'rejected' || code === 'unavailable' || code === 'invalid-response'
        ? code
        : 'invalid-response';
  }
  public readonly code: 'rejected' | 'unavailable' | 'invalid-response';
}

export interface ManagedKeyPort {
  authorizeUse(
    request: Readonly<{
      readonly keyRef: string;
      readonly tenantId: string;
      readonly purpose: 'entitlement' | 'data-encryption';
    }>
  ): Promise<boolean>;
  encrypt(request: Readonly<{ readonly keyRef: string; readonly plaintext: Uint8Array }>): Promise<
    Readonly<{
      readonly keyRef: string;
      readonly ciphertext: Uint8Array;
      /** Present only when the provider atomically rotated the requested logical key. */
      readonly rotatedFrom?: string;
    }>
  >;
  decrypt(
    request: Readonly<{ readonly keyRef: string; readonly ciphertext: Uint8Array }>,
    context?: AdapterCallContext
  ): Promise<Readonly<Uint8Array>>;
}

const MAX_CRYPTO_BYTES = 1_048_576;

function opaqueKeyRef(value: unknown): string {
  return text(value, 'managed key reference', 512);
}

interface CheckedBytes {
  readonly source: Uint8Array;
  readonly length: number;
}

function checkedBytes(value: unknown, field: string): CheckedBytes {
  if (typeof value !== 'object' || value === null) {
    throw enterpriseError(`${field} must be a Uint8Array no larger than ${MAX_CRYPTO_BYTES} bytes`);
  }
  try {
    if (Object.getPrototypeOf(value) !== Uint8Array.prototype)
      throw enterpriseError(`${field} must be an exact Uint8Array`);
    const source = value as Uint8Array;
    const buffer = source.buffer;
    if (
      Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
      (buffer as ArrayBuffer & { readonly resizable?: unknown }).resizable === true ||
      ((buffer as ArrayBuffer & { readonly maxByteLength?: unknown }).maxByteLength !== undefined &&
        (buffer as ArrayBuffer & { readonly maxByteLength?: unknown }).maxByteLength !==
          buffer.byteLength)
    )
      throw enterpriseError(`${field} must use a fixed ArrayBuffer`);
    const length = source.byteLength;
    const verified = new Uint8Array(buffer, source.byteOffset, length);
    if (verified.byteLength !== length) throw enterpriseError(`${field} must be usable`);
    if (!Number.isSafeInteger(length) || length > MAX_CRYPTO_BYTES)
      throw enterpriseError(
        `${field} must be a Uint8Array no larger than ${MAX_CRYPTO_BYTES} bytes`
      );
    return Object.freeze({ source: verified, length });
  } catch (error) {
    if (isIssuedEnterpriseSecurityError(error)) throw error;
    throw enterpriseError(`${field} must be a usable Uint8Array`);
  }
}

function boundedBytes(value: unknown, field: string): Uint8Array {
  const checked = checkedBytes(value, field);
  const copy = new Uint8Array(checked.length);
  copy.set(checked.source);
  return copy;
}

/** Validates opaque KMS authorization without ever accepting or returning a raw key. */
export async function authorizeManagedKeyUse(
  port: ManagedKeyPort,
  request: Readonly<{
    readonly keyRef: string;
    readonly tenantId: string;
    readonly purpose: 'entitlement' | 'data-encryption';
  }>
): Promise<boolean> {
  const captured = capturePort(port, ['authorizeUse'], 'managed KMS port');
  if (request.purpose !== 'entitlement' && request.purpose !== 'data-encryption') {
    throw enterpriseError('managed key purpose is invalid');
  }
  const safeRequest = frozen({
    keyRef: opaqueKeyRef(request.keyRef),
    tenantId: identifier(request.tenantId, 'tenantId'),
    purpose: request.purpose
  });
  try {
    const allowed = await invokePort(captured, 'authorizeUse', [safeRequest]);
    if (allowed === true) return true;
    if (allowed === false) return false;
    throw managedKeyError('invalid-response', 'KMS authorize response must be a boolean');
  } catch (error) {
    if (isIssuedManagedKeyError(error)) throw error;
    throw managedKeyError('unavailable', 'managed KMS authorization is unavailable');
  }
}

export async function encryptWithManagedKey(
  port: ManagedKeyPort,
  keyRef: string,
  plaintext: Uint8Array
): Promise<Readonly<{ readonly keyRef: string; readonly ciphertext: Uint8Array }>> {
  const captured = capturePort(port, ['encrypt'], 'managed KMS port');
  const expectedKeyRef = opaqueKeyRef(keyRef);
  try {
    const result = dataRecord(
      await invokePort(captured, 'encrypt', [
        frozen({ keyRef: expectedKeyRef, plaintext: boundedBytes(plaintext, 'plaintext') })
      ]),
      'managed KMS encryption result',
      ['keyRef', 'ciphertext', 'rotatedFrom']
    );
    const responseKeyRef = opaqueKeyRef(result.keyRef);
    if (responseKeyRef !== expectedKeyRef && result.rotatedFrom !== expectedKeyRef)
      throw managedKeyError(
        'invalid-response',
        'KMS encrypt response key reference mismatches request'
      );
    return frozen({
      keyRef: responseKeyRef,
      ciphertext: boundedBytes(result.ciphertext, 'ciphertext')
    });
  } catch (error) {
    if (isIssuedManagedKeyError(error)) throw error;
    throw managedKeyError('unavailable', 'managed KMS encryption is unavailable');
  }
}

export async function decryptWithManagedKey(
  port: ManagedKeyPort,
  keyRef: string,
  ciphertext: Uint8Array
): Promise<Readonly<Uint8Array>> {
  const captured = capturePort(port, ['decrypt'], 'managed KMS port');
  const expectedKeyRef = opaqueKeyRef(keyRef);
  try {
    const result = await invokePort(captured, 'decrypt', [
      frozen({ keyRef: expectedKeyRef, ciphertext: boundedBytes(ciphertext, 'ciphertext') })
    ]);
    // Typed-array elements cannot be frozen by JavaScript; return an isolated copy instead.
    return boundedBytes(result, 'plaintext');
  } catch (error) {
    if (isIssuedManagedKeyError(error)) throw error;
    throw managedKeyError('unavailable', 'managed KMS decryption is unavailable');
  }
}

export type TrustedSessionEvidence = Readonly<{
  readonly source: 'host-trusted/v1';
  readonly subjectId: string;
  readonly ipAddress: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly sessionId: string;
  readonly active: boolean;
  readonly revoked: boolean;
  readonly accessVersion: number;
  readonly sessionVersion: number;
  readonly [trustedSessionBrand]: true;
}>;

/** Host adapters construct this after authentication/session verification; callers cannot forge its private brand. */
export function createTrustedSessionEvidence(value: unknown): TrustedSessionEvidence {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('session evidence must be an object');
  const input = dataRecord(value, 'session evidence', [
    'source',
    'subjectId',
    'ipAddress',
    'issuedAt',
    'expiresAt',
    'sessionId',
    'active',
    'revoked',
    'accessVersion',
    'sessionVersion'
  ]);
  if (
    input.source !== 'host-trusted/v1' ||
    (input.active !== true && input.active !== false) ||
    (input.revoked !== true && input.revoked !== false)
  )
    throw enterpriseError('session evidence trust state is invalid');
  const issuedAt = canonicalInstant(input.issuedAt, 'session issuedAt');
  const expiresAt = canonicalInstant(input.expiresAt, 'session expiresAt');
  if (instantMs(expiresAt) <= instantMs(issuedAt))
    throw enterpriseError('session expiresAt must follow issuedAt');
  const session = {
    source: 'host-trusted/v1' as const,
    subjectId: identifier(input.subjectId, 'session subjectId'),
    ipAddress: text(input.ipAddress, 'session IP address', 64),
    issuedAt,
    expiresAt,
    sessionId: identifier(input.sessionId, 'sessionId'),
    active: input.active,
    revoked: input.revoked,
    accessVersion: boundedPositiveInteger(input.accessVersion, 'accessVersion', 1_000_000),
    sessionVersion: boundedPositiveInteger(input.sessionVersion, 'sessionVersion', 1_000_000)
  };
  Object.defineProperty(session, trustedSessionBrand, { value: true });
  parseIp(session.ipAddress, 'session IP address');
  trustedSessions.add(session);
  return frozen(session) as TrustedSessionEvidence;
}

function isTrustedSession(value: unknown): value is TrustedSessionEvidence {
  return (
    typeof value === 'object' &&
    value !== null &&
    trustedSessions.has(value) &&
    (value as Record<PropertyKey, unknown>)[trustedSessionBrand] === true &&
    Object.isFrozen(value)
  );
}

export interface ExternalAccessRequest {
  readonly capability: SecurityCapability;
  readonly tenantId: string;
  readonly audience: string;
  readonly resource: string;
  readonly residency: string;
  readonly session: TrustedSessionEvidence;
  readonly now: string;
  readonly entitlement: ExternalEntitlement;
}

export type AccessDecision = Readonly<
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        'invalid' | 'denied' | 'revoked' | 'store-unavailable' | 'provider-unavailable';
    }
>;

/** Local OSS deliberately has no account, license, or entitlement check. */
export function allowLocalAccess(): AccessDecision {
  return frozen({ allowed: true as const });
}

async function advanceRevision(
  store: RevisionStore,
  key: RevisionNamespace,
  revision: number,
  digest: string,
  expiresAt: string,
  attempt = 0
): Promise<'accepted' | 'revoked' | 'unavailable'> {
  const current = await readRevisionState(store, key);
  if (
    current !== undefined &&
    (current.revision > revision || (current.revision === revision && current.revoked))
  ) {
    return 'revoked';
  }
  if (
    current !== undefined &&
    current.revision === revision &&
    current.digest === digest &&
    current.expiresAt === expiresAt
  )
    return 'accepted';
  if (
    await compareRevisionState(
      store,
      key,
      current,
      frozen({ revision, revoked: false, digest, expiresAt })
    )
  ) {
    return 'accepted';
  }
  return attempt >= 2
    ? 'unavailable'
    : advanceRevision(store, key, revision, digest, expiresAt, attempt + 1);
}

function normalizeEntitlementVerification(value: unknown): 'valid' | 'invalid' | 'unavailable' {
  if (value === true || value === 'valid') return 'valid';
  if (value === false || value === 'invalid') return 'invalid';
  if (value === 'unavailable') return 'unavailable';
  throw enterpriseError('entitlement verifier returned an invalid result');
}

async function cachedEntitlementIsUsable(
  store: CapturedRevisionStore,
  key: Readonly<RevisionNamespace>,
  entitlement: Readonly<VerifiedEntitlement>,
  now: string,
  graceSeconds: number
): Promise<boolean> {
  const state = await readRevisionState(store, key);
  return (
    state !== undefined &&
    !state.revoked &&
    state.revision === entitlement.revision &&
    state.digest === entitlement.digest &&
    state.expiresAt === entitlement.expiresAt &&
    instantMs(now) <= instantMs(entitlement.expiresAt) + graceSeconds * 1000
  );
}

/** Fail-closed external policy evaluation with runtime validation and verifier exception containment. */
export async function evaluateExternalAccess(
  policy: CompiledEnterprisePolicy,
  request: unknown,
  verifier: EntitlementVerifier,
  revisions: RevisionStore
): Promise<AccessDecision> {
  try {
    const capturedVerifier = capturePort(verifier, ['verify'], 'entitlement verifier');
    const capturedRevisions = ownRevisionStore(revisions);
    // Raw compiled policies are useful for local validation, but must never
    // authorize an external request until a signed, durable activation created
    // this specific branded instance.
    if (!isActivatedSignedPolicy(policy))
      return frozen({ allowed: false as const, reason: 'invalid' as const });
    if (typeof request !== 'object' || request === null)
      throw enterpriseError('request must be an object');
    const input = dataRecord(request, 'external access request', [
      'capability',
      'tenantId',
      'audience',
      'resource',
      'residency',
      'session',
      'now',
      'entitlement'
    ]);
    const now = canonicalInstant(input.now, 'request now');
    const livePolicyStore = activatedPolicyStores.get(policy as object);
    if (livePolicyStore === undefined)
      return frozen({ allowed: false as const, reason: 'invalid' as const });
    let livePolicy: Readonly<PolicyRevisionState> | undefined;
    try {
      livePolicy = await livePolicyStore.read(policy.signedPolicy.organizationId, policy.policyId);
    } catch {
      return frozen({ allowed: false as const, reason: 'store-unavailable' as const });
    }
    const policyState =
      livePolicy === undefined ? undefined : normalizePolicyRevisionState(livePolicy);
    if (
      policyState === undefined ||
      policyState.revoked ||
      policyState.revision !== policy.signedPolicy.revision ||
      policyState.digest !== policy.signedPolicy.digest ||
      policyState.expiresAt !== policy.signedPolicy.expiresAt ||
      instantMs(policyState.expiresAt) <= instantMs(now)
    )
      return frozen({ allowed: false as const, reason: 'revoked' as const });
    const session = input.session;
    if (!isTrustedSession(session)) throw enterpriseError('session must be host trusted evidence');
    const evidence = session;
    const sessionIssuedAt = evidence.issuedAt;
    if (
      !evidence.active ||
      evidence.revoked ||
      instantMs(sessionIssuedAt) > instantMs(now) ||
      instantMs(now) - instantMs(sessionIssuedAt) > policy.sessionMaxAgeSeconds * 1000 ||
      instantMs(evidence.expiresAt) <= instantMs(now) ||
      evidence.accessVersion < policy.minimumAccessVersion ||
      evidence.sessionVersion < policy.minimumSessionVersion
    )
      return frozen({ allowed: false as const, reason: 'denied' as const });
    const capabilityValue = capability(input.capability, 'request capability');
    const tenantId = identifier(input.tenantId, 'request tenantId');
    const audience = identifier(input.audience, 'request audience');
    const resource = identifier(input.resource, 'request resource');
    const residency = identifier(input.residency, 'request residency');
    const subjectId = evidence.subjectId;
    const ip = parseIp(evidence.ipAddress, 'session IP address');
    if (
      !policy.capabilities.includes(capabilityValue) ||
      tenantId !== policy.tenantId ||
      audience !== policy.audience ||
      !policy.residency.includes(residency) ||
      !policy.allowedIpCidrs.some((cidr) => cidrMatches(ip, cidr))
    )
      return frozen({ allowed: false as const, reason: 'denied' as const });
    const entitlement = normalizeEntitlement(input.entitlement);
    if (
      entitlement.tenantId !== tenantId ||
      entitlement.audience !== audience ||
      entitlement.resource !== resource ||
      entitlement.subjectId !== subjectId ||
      entitlement.policyId !== policy.policyId ||
      entitlement.policyVersion !== policy.policyVersion ||
      !entitlement.capabilities.includes(capabilityValue) ||
      instantMs(entitlement.issuedAt) > instantMs(now) ||
      instantMs(now) - instantMs(entitlement.issuedAt) > policy.entitlementTtlSeconds * 1000 ||
      instantMs(entitlement.expiresAt) <= instantMs(entitlement.issuedAt)
    )
      return frozen({ allowed: false as const, reason: 'invalid' as const });
    let verification: 'valid' | 'invalid' | 'unavailable';
    try {
      verification = normalizeEntitlementVerification(
        await invokePort(capturedVerifier, 'verify', [entitlement])
      );
    } catch {
      verification = 'unavailable';
    }
    if (verification === 'invalid')
      return frozen({ allowed: false as const, reason: 'invalid' as const });
    if (verification === 'unavailable') {
      try {
        return (await cachedEntitlementIsUsable(
          capturedRevisions,
          namespace(entitlement),
          entitlement,
          now,
          policy.entitlementGraceSeconds
        ))
          ? frozen({ allowed: true as const })
          : frozen({ allowed: false as const, reason: 'provider-unavailable' as const });
      } catch {
        return frozen({ allowed: false as const, reason: 'store-unavailable' as const });
      }
    }
    if (instantMs(entitlement.expiresAt) <= instantMs(now))
      return frozen({ allowed: false as const, reason: 'denied' as const });
    let revision: 'accepted' | 'revoked' | 'unavailable';
    try {
      revision = await advanceRevision(
        capturedRevisions,
        namespace(entitlement),
        entitlement.revision,
        entitlement.digest,
        entitlement.expiresAt
      );
    } catch {
      return frozen({ allowed: false as const, reason: 'store-unavailable' as const });
    }
    return revision === 'accepted'
      ? frozen({ allowed: true as const })
      : frozen({
          allowed: false as const,
          reason: revision === 'revoked' ? ('revoked' as const) : ('store-unavailable' as const)
        });
  } catch (error) {
    if (isIssuedEnterpriseSecurityError(error))
      return frozen({ allowed: false as const, reason: 'invalid' as const });
    return frozen({ allowed: false as const, reason: 'store-unavailable' as const });
  }
}

export interface DlpScannerPort {
  scan(
    input: Readonly<{
      readonly tenantId: string;
      readonly content: string;
      readonly maxFindings: number;
    }>,
    context?: AdapterCallContext
  ): Promise<
    Readonly<{ readonly redactedContent: string; readonly detectionIds: readonly string[] }>
  >;
}

export interface DlpPolicy {
  readonly format: typeof enterpriseSecurityFormat;
  readonly maxContentBytes: number;
  readonly maxFindings: number;
  readonly watermarkTemplate?: string;
}
export interface ProtectedContent {
  readonly text: string;
  readonly watermark?: string;
  readonly detections: readonly string[];
}

/** Matching is delegated to a bounded host scanner; core never compiles attacker-controlled regexes. */
export async function protectContent(
  policy: DlpPolicy,
  scanner: DlpScannerPort,
  tenantId: string,
  subjectId: string,
  content: string
): Promise<ProtectedContent> {
  const policyInput = dataRecord(policy, 'DLP policy', [
    'format',
    'maxContentBytes',
    'maxFindings',
    'watermarkTemplate'
  ]);
  const maxContentBytes = policyInput.maxContentBytes;
  const maxFindings = policyInput.maxFindings;
  if (
    policyInput.format !== enterpriseSecurityFormat ||
    typeof maxContentBytes !== 'number' ||
    !Number.isSafeInteger(maxContentBytes) ||
    maxContentBytes < 1 ||
    maxContentBytes > 1_048_576 ||
    typeof maxFindings !== 'number' ||
    !Number.isSafeInteger(maxFindings) ||
    maxFindings < 1 ||
    maxFindings > MAX_ARRAY_ITEMS
  )
    throw enterpriseError('DLP policy is invalid');
  const safePolicy = frozen({
    format: enterpriseSecurityFormat,
    maxContentBytes,
    maxFindings,
    ...(policyInput.watermarkTemplate === undefined
      ? {}
      : { watermarkTemplate: text(policyInput.watermarkTemplate, 'watermark template', 512) })
  });
  const capturedScanner = capturePort(scanner, ['scan'], 'DLP scanner');
  let safeContent: string;
  try {
    safeContent = text(content, 'content', safePolicy.maxContentBytes);
  } catch {
    throw enterpriseError('content exceeds DLP bound');
  }
  let scan: Readonly<Record<string, unknown>>;
  try {
    scan = dataRecord(
      await invokePort(capturedScanner, 'scan', [
        frozen({
          tenantId: identifier(tenantId, 'tenantId'),
          content: safeContent,
          maxFindings: safePolicy.maxFindings
        })
      ]),
      'DLP scanner result',
      ['redactedContent', 'detectionIds']
    );
  } catch {
    throw enterpriseError('DLP scanner failed closed');
  }
  const output = text(scan.redactedContent, 'DLP scanner output', safePolicy.maxContentBytes);
  const detections = uniqueStrings(scan.detectionIds, 'DLP detection IDs', identifier);
  if (detections.length > safePolicy.maxFindings)
    throw enterpriseError('DLP scanner exceeded finding bound');
  const watermarkTemplate =
    safePolicy.watermarkTemplate === undefined ? undefined : safePolicy.watermarkTemplate;
  const watermark =
    watermarkTemplate === undefined
      ? undefined
      : watermarkTemplate.replaceAll('{subject}', identifier(subjectId, 'subjectId'));
  if (
    watermark !== undefined &&
    (watermark.length > MAX_WATERMARK_BYTES || bytes(watermark) > MAX_WATERMARK_BYTES)
  )
    throw enterpriseError('watermark exceeds bound');
  return frozen(
    watermark === undefined
      ? { text: output, detections }
      : {
          text: output,
          watermark,
          detections
        }
  );
}

export interface RetentionRecord {
  readonly format: 'selene-retention-record/v1';
  readonly recordId: string;
  readonly tenantId: string;
  readonly createdAt: string;
  readonly legalHoldId?: string;
}
export function canDeleteAfterRetention(
  record: unknown,
  retentionDays: unknown,
  maxRetentionDays: unknown,
  now: unknown
): boolean {
  const input = dataRecord(record, 'retention record', [
    'format',
    'recordId',
    'tenantId',
    'createdAt',
    'legalHoldId'
  ]);
  if (input.format !== 'selene-retention-record/v1')
    throw enterpriseError('retention record is invalid');
  identifier(input.recordId, 'recordId');
  identifier(input.tenantId, 'record tenantId');
  if (input.legalHoldId !== undefined) {
    identifier(input.legalHoldId, 'legalHoldId');
    return false;
  }
  const maximum = boundedPositiveInteger(maxRetentionDays, 'maxRetentionDays', 36_500);
  const days = boundedPositiveInteger(retentionDays, 'retentionDays', maximum);
  return (
    instantMs(canonicalInstant(now, 'now')) >=
    instantMs(canonicalInstant(input.createdAt, 'record createdAt')) + days * 86_400_000
  );
}

/**
 * Hosts must atomically consume the replay key and persist the activation audit
 * record. A separate consume followed by audit write can silently authorize an
 * emergency action without an audit trail if the second operation fails.
 */
export interface BreakGlassActivationPort {
  consumeAndAudit(
    request: Readonly<ActiveBreakGlass>,
    context?: AdapterCallContext
  ): Promise<boolean>;
}
/** Expected policy scope supplied by the host that is about to honor break-glass. */
export interface BreakGlassScope {
  readonly tenantId: string;
  readonly audience: string;
  readonly policyId: string;
  readonly policyVersion: number;
}
/** Signed, request-bound approval evidence. The host owns the signature scheme and keys. */
export interface BreakGlassApproval {
  readonly format: 'selene-break-glass-approval/v1';
  readonly requestId: string;
  readonly approverId: string;
  readonly issuedAt: string;
  readonly signature: string;
  readonly keyId: string;
}
export interface BreakGlassApprovalVerifier {
  verify(
    approval: Readonly<BreakGlassApproval>,
    request: Readonly<{
      readonly tenantId: string;
      readonly audience: string;
      readonly policyId: string;
      readonly policyVersion: number;
      readonly requesterId: string;
      readonly expiresAt: string;
    }>,
    context?: AdapterCallContext
  ): Promise<boolean>;
}
export interface BreakGlassRequest {
  readonly format: 'selene-break-glass/v1';
  readonly requestId: string;
  readonly auditEventId: string;
  readonly tenantId: string;
  readonly audience: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly requesterId: string;
  readonly caseId: string;
  readonly reason: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: 'pending';
  readonly approvals: readonly BreakGlassApproval[];
}

function normalizeBreakGlassScope(value: unknown): Readonly<BreakGlassScope> {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('expected break-glass scope is invalid');
  const input = dataRecord(value, 'expected break-glass scope', [
    'tenantId',
    'audience',
    'policyId',
    'policyVersion'
  ]);
  return frozen({
    tenantId: identifier(input.tenantId, 'expected break-glass tenantId'),
    audience: identifier(input.audience, 'expected break-glass audience'),
    policyId: identifier(input.policyId, 'expected break-glass policyId'),
    policyVersion: boundedPositiveInteger(
      input.policyVersion,
      'expected break-glass policyVersion',
      1_000_000
    )
  });
}
export interface ActiveBreakGlass {
  readonly format: 'selene-break-glass/v1';
  readonly requestId: string;
  readonly auditEventId: string;
  readonly tenantId: string;
  readonly audience: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly requesterId: string;
  readonly caseId: string;
  readonly reason: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly state: 'active';
  readonly approvers: readonly string[];
}

export async function activateBreakGlass(
  value: unknown,
  now: unknown,
  activation: BreakGlassActivationPort,
  expectedScope: BreakGlassScope,
  approvalVerifier: BreakGlassApprovalVerifier
): Promise<ActiveBreakGlass> {
  const capturedActivation = capturePort(
    activation,
    ['consumeAndAudit'],
    'break-glass activation port'
  );
  const capturedApprovalVerifier = capturePort(
    approvalVerifier,
    ['verify'],
    'break-glass approval verifier'
  );
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('break-glass request must be an object');
  const input = dataRecord(value, 'break-glass request', [
    'format',
    'requestId',
    'auditEventId',
    'tenantId',
    'audience',
    'policyId',
    'policyVersion',
    'requesterId',
    'caseId',
    'reason',
    'issuedAt',
    'expiresAt',
    'state',
    'approvals'
  ]);
  if (input.format !== 'selene-break-glass/v1' || input.state !== 'pending')
    throw enterpriseError('break-glass request state is invalid');
  const requestId = identifier(input.requestId, 'requestId');
  const requesterId = identifier(input.requesterId, 'requesterId');
  const auditEventId = identifier(input.auditEventId, 'auditEventId');
  const tenantId = identifier(input.tenantId, 'break-glass tenantId');
  const audience = identifier(input.audience, 'break-glass audience');
  const policyId = identifier(input.policyId, 'policyId');
  const policyVersion = boundedPositiveInteger(input.policyVersion, 'policyVersion', 1_000_000);
  const caseId = identifier(input.caseId, 'caseId');
  const reason = text(input.reason, 'break-glass reason', 2_048);
  if (bytes(reason) < 20) throw enterpriseError('break-glass reason must be at least 20 bytes');
  const approvalValues = dataArray(input.approvals, 'break-glass approvals');
  if (approvalValues.length !== 2)
    throw enterpriseError('break-glass requires exactly two approval records');
  const approvals = approvalValues.map((approvalValue) => {
    if (typeof approvalValue !== 'object' || approvalValue === null)
      throw enterpriseError('break-glass approval must be an object');
    const approval = dataRecord(approvalValue, 'break-glass approval', [
      'format',
      'requestId',
      'approverId',
      'issuedAt',
      'signature',
      'keyId'
    ]);
    if (approval.format !== 'selene-break-glass-approval/v1')
      throw enterpriseError('unsupported break-glass approval format');
    return frozen({
      format: 'selene-break-glass-approval/v1' as const,
      requestId: identifier(approval.requestId, 'approval requestId'),
      approverId: identifier(approval.approverId, 'approval approverId'),
      issuedAt: canonicalInstant(approval.issuedAt, 'approval issuedAt'),
      signature: text(approval.signature, 'approval signature', MAX_SIGNATURE_BYTES),
      keyId: text(approval.keyId, 'approval keyId', 512)
    });
  });
  const approvers = Object.freeze(approvals.map((approval) => approval.approverId).sort());
  if (new Set(approvers).size !== approvers.length || approvers.includes(requesterId))
    throw enterpriseError('break-glass requires two distinct non-requester approvers');
  const issuedAt = canonicalInstant(input.issuedAt, 'break-glass issuedAt');
  const expiresAt = canonicalInstant(input.expiresAt, 'break-glass expiresAt');
  const nowValue = canonicalInstant(now, 'now');
  const scope = normalizeBreakGlassScope(expectedScope);
  if (
    instantMs(issuedAt) > instantMs(nowValue) ||
    instantMs(expiresAt) <= instantMs(nowValue) ||
    instantMs(expiresAt) <= instantMs(issuedAt) ||
    instantMs(expiresAt) - instantMs(issuedAt) > 86_400_000
  )
    throw enterpriseError('break-glass expiry must be within 24 hours');
  if (
    scope.tenantId !== tenantId ||
    scope.audience !== audience ||
    scope.policyId !== policyId ||
    scope.policyVersion !== policyVersion
  )
    throw enterpriseError('break-glass request scope does not match policy');
  const approvalScope = frozen({
    tenantId,
    audience,
    policyId,
    policyVersion,
    requesterId,
    expiresAt
  });
  for (const approval of approvals) {
    if (
      approval.requestId !== requestId ||
      instantMs(approval.issuedAt) < instantMs(issuedAt) ||
      instantMs(approval.issuedAt) > instantMs(expiresAt)
    )
      throw enterpriseError('break-glass approval is not bound to the active request');
  }
  let approvalResults: readonly boolean[];
  try {
    approvalResults = await Promise.all(
      approvals.map((approval) =>
        invokePort<boolean>(capturedApprovalVerifier, 'verify', [approval, approvalScope])
      )
    );
  } catch {
    throw enterpriseError('break-glass approval verifier is unavailable');
  }
  if (!approvalResults.every((verified) => verified === true))
    throw enterpriseError('break-glass approval was rejected');
  // All validation precedes the one-way atomic replay-and-audit operation.
  const active = frozen({
    format: 'selene-break-glass/v1' as const,
    requestId,
    auditEventId,
    tenantId,
    audience,
    policyId,
    policyVersion,
    requesterId,
    caseId,
    reason,
    issuedAt,
    expiresAt,
    state: 'active' as const,
    approvers
  });
  let recorded: unknown;
  try {
    recorded = await invokePort(capturedActivation, 'consumeAndAudit', [active]);
  } catch {
    throw enterpriseError('break-glass activation audit is unavailable');
  }
  if (recorded !== true)
    throw enterpriseError('break-glass request was replayed or audit was rejected');
  return active;
}

export interface SecurityEvent {
  readonly format: 'selene-security-event/v1';
  readonly id: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly type: string;
  readonly payload: Readonly<RedactedSecurityPayload>;
}
/** Deliberately small, typed payload. Adapters must redact before enqueueing. */
export interface RedactedSecurityPayload {
  readonly format: 'selene-redacted-security-payload/v1';
  readonly summary: string;
  readonly attributes: readonly Readonly<{ readonly key: string; readonly value: string }>[];
}
export interface ClaimedSecurityEvent {
  readonly claimId: string;
  readonly event: Readonly<SecurityEvent>;
  readonly attempts: number;
  readonly leaseExpiresAt: string;
}
/** Persistent adapters must atomically claim, ack, retry, or dead-letter each event. */
export interface SiemOutboxPort {
  enqueue(event: Readonly<SecurityEvent>): Promise<void>;
  claim(limit: number, now: string): Promise<readonly ClaimedSecurityEvent[]>;
  /** The adapter must reject settlement after the supplied lease has expired. */
  ack(claimId: string, now: string): Promise<void>;
  nack(claimId: string, retryAt: string, now: string): Promise<void>;
  deadLetter(claimId: string, reasonCode: string, now: string): Promise<void>;
}

export interface DeadLetteredSecurityEvent {
  readonly event: Readonly<SecurityEvent>;
  /** Bounded stable code only; do not place source content or provider errors here. */
  readonly reasonCode: string;
}

type StoredEvent = {
  event: Readonly<SecurityEvent>;
  attempts: number;
  retryAt: string;
  claim?: Readonly<{ readonly id: string; readonly expiresAt: string }>;
};
export class InMemorySiemOutbox implements SiemOutboxPort {
  private readonly events = new Map<string, StoredEvent>();
  private readonly deadLetters = new Map<string, Readonly<DeadLetteredSecurityEvent>>();
  private lock = Promise.resolve();
  private sequence = 0;
  public constructor(
    private readonly capacity = 1_024,
    private readonly leaseSeconds = 60
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000)
      throw enterpriseError('outbox bounds are invalid');
    boundedSeconds(leaseSeconds, 'SIEM leaseSeconds', MAX_SIEM_LEASE_SECONDS, 1);
  }
  private async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  public async enqueue(value: Readonly<SecurityEvent>): Promise<void> {
    await this.exclusive(() => {
      const event = normalizeSecurityEvent(value);
      if (this.events.has(event.id) || this.deadLetters.has(event.id))
        throw enterpriseError('duplicate SIEM event id');
      if (this.events.size + this.deadLetters.size >= this.capacity)
        throw enterpriseError('SIEM outbox capacity reached');
      this.events.set(event.id, { event, attempts: 0, retryAt: event.occurredAt });
    });
  }
  public async claim(limit: number, now: string): Promise<readonly ClaimedSecurityEvent[]> {
    const timestamp = canonicalInstant(now, 'now');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
      throw enterpriseError('claim limit is invalid');
    return this.exclusive(() => {
      const claims: ClaimedSecurityEvent[] = [];
      for (const [, stored] of this.events) {
        if (
          stored.claim !== undefined &&
          instantMs(stored.claim.expiresAt) <= instantMs(timestamp)
        ) {
          delete stored.claim;
        }
        if (
          claims.length === limit ||
          stored.claim !== undefined ||
          instantMs(stored.retryAt) > instantMs(timestamp)
        )
          continue;
        const claimId = `claim-${++this.sequence}`;
        const leaseExpiresAt = new Date(
          instantMs(timestamp) + this.leaseSeconds * 1000
        ).toISOString();
        stored.claim = frozen({ id: claimId, expiresAt: leaseExpiresAt });
        claims.push(
          frozen({
            claimId,
            event: frozen({ ...stored.event }),
            attempts: stored.attempts,
            leaseExpiresAt
          })
        );
      }
      return Object.freeze(claims);
    });
  }
  public async ack(claimId: string, now: string): Promise<void> {
    await this.finish(claimId, now, () => undefined);
  }
  public async nack(claimId: string, retryAt: string, now: string): Promise<void> {
    const at = canonicalInstant(retryAt, 'retryAt');
    await this.finish(claimId, now, (stored) => {
      stored.attempts += 1;
      delete stored.claim;
      stored.retryAt = at;
    });
  }
  public async deadLetter(claimId: string, reasonCode: string, now: string): Promise<void> {
    const safeReasonCode = identifier(reasonCode, 'dead-letter reason code');
    await this.finish(claimId, now, (stored) => {
      this.deadLetters.set(
        stored.event.id,
        frozen({ event: frozen({ ...stored.event }), reasonCode: safeReasonCode })
      );
    });
  }
  private async finish(
    claimId: string,
    now: string,
    update: (stored: StoredEvent) => void
  ): Promise<void> {
    text(claimId, 'claimId', 256);
    const timestamp = canonicalInstant(now, 'now');
    await this.exclusive(() => {
      const entry = [...this.events.entries()].find(([, stored]) => stored.claim?.id === claimId);
      if (entry === undefined) throw enterpriseError('unknown or settled SIEM claim');
      const [id, stored] = entry;
      if (stored.claim === undefined || instantMs(stored.claim.expiresAt) <= instantMs(timestamp)) {
        if (stored.claim !== undefined) delete stored.claim;
        throw enterpriseError('expired SIEM claim cannot be settled');
      }
      update(stored);
      if (stored.claim?.id === claimId) this.events.delete(id);
    });
  }
  public size(): number {
    return this.events.size;
  }
  public deadLetterSize(): number {
    return this.deadLetters.size;
  }
  public deadLetterFor(id: string): Readonly<DeadLetteredSecurityEvent> | undefined {
    return this.deadLetters.get(identifier(id, 'SIEM event id'));
  }
}

function normalizeSecurityEvent(value: unknown): Readonly<SecurityEvent> {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('SIEM event must be an object');
  const input = dataRecord(value, 'security event', [
    'format',
    'id',
    'tenantId',
    'occurredAt',
    'type',
    'payload'
  ]);
  if (input.format !== 'selene-security-event/v1')
    throw enterpriseError('unsupported SIEM event format');
  return frozen({
    format: 'selene-security-event/v1' as const,
    id: identifier(input.id, 'SIEM event id'),
    tenantId: identifier(input.tenantId, 'SIEM tenantId'),
    occurredAt: canonicalInstant(input.occurredAt, 'SIEM occurredAt'),
    type: text(input.type, 'SIEM type', 192),
    payload: normalizeRedactedSecurityPayload(input.payload)
  });
}

function normalizeRedactedSecurityPayload(value: unknown): Readonly<RedactedSecurityPayload> {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('SIEM payload must be an object');
  const input = dataRecord(value, 'security event payload', ['format', 'summary', 'attributes']);
  if (input.format !== 'selene-redacted-security-payload/v1')
    throw enterpriseError('SIEM payload must be a redacted payload');
  const attributeValues = dataArray(input.attributes, 'SIEM payload attributes');
  const attributes = attributeValues.map((attribute) => {
    if (typeof attribute !== 'object' || attribute === null)
      throw enterpriseError('SIEM payload attribute is invalid');
    const record = dataRecord(attribute, 'security event attribute', ['key', 'value']);
    return frozen({
      key: identifier(record.key, 'SIEM payload attribute key'),
      value: text(record.value, 'SIEM payload attribute value', 512)
    });
  });
  if (new Set(attributes.map((attribute) => attribute.key)).size !== attributes.length)
    throw enterpriseError('SIEM payload attribute keys must not duplicate');
  return frozen({
    format: 'selene-redacted-security-payload/v1' as const,
    summary: text(input.summary, 'SIEM payload summary', 2_048),
    attributes: Object.freeze(attributes)
  });
}

function normalizeClaimedSecurityEvent(value: unknown): Readonly<ClaimedSecurityEvent> {
  if (typeof value !== 'object' || value === null)
    throw enterpriseError('SIEM claim must be an object');
  const input = dataRecord(value, 'SIEM claim', ['claimId', 'event', 'attempts', 'leaseExpiresAt']);
  if (
    typeof input.attempts !== 'number' ||
    !Number.isSafeInteger(input.attempts) ||
    input.attempts < 0 ||
    input.attempts > 100
  )
    throw enterpriseError('SIEM claim attempts are invalid');
  return frozen({
    claimId: identifier(input.claimId, 'SIEM claim id'),
    event: normalizeSecurityEvent(input.event),
    attempts: input.attempts,
    leaseExpiresAt: canonicalInstant(input.leaseExpiresAt, 'SIEM claim lease expiry')
  });
}

export async function deliverSiemBatch(
  outbox: SiemOutboxPort,
  now: string,
  deliver: (event: Readonly<SecurityEvent>) => Promise<void>,
  maxAttempts = 5
): Promise<Readonly<{ readonly delivered: number; readonly deadLettered: number }>> {
  const capturedDeliver = captureCallback(deliver, 'SIEM delivery callback');
  const capturedOutbox = capturePort(
    outbox,
    ['enqueue', 'claim', 'ack', 'nack', 'deadLetter'],
    'SIEM outbox'
  );
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100)
    throw enterpriseError('maxAttempts is invalid');
  const timestamp = canonicalInstant(now, 'SIEM now');
  const claimed = await invokePort<unknown>(capturedOutbox, 'claim', [64, timestamp]);
  const claims = dataArray(claimed, 'SIEM claims').map(normalizeClaimedSecurityEvent);
  let delivered = 0;
  let deadLettered = 0;
  let nextClaim = 0;
  const workers = Array.from({ length: Math.min(8, claims.length) }, async () => {
    while (nextClaim < claims.length) {
      const claim = claims[nextClaim];
      nextClaim += 1;
      if (claim === undefined) continue;
      try {
        // oxlint-disable-next-line no-await-in-loop -- bounded worker serializes one claim.
        await invokeCallback<void>(capturedDeliver, [claim.event]);
        // oxlint-disable-next-line no-await-in-loop -- acknowledgement follows this delivery.
        await invokePort(capturedOutbox, 'ack', [claim.claimId, timestamp]);
        delivered += 1;
      } catch {
        if (claim.attempts + 1 >= maxAttempts) {
          // oxlint-disable-next-line no-await-in-loop -- each claim has exactly one terminal settlement.
          await invokePort(capturedOutbox, 'deadLetter', [
            claim.claimId,
            'delivery-failed-after-retry-budget',
            timestamp
          ]);
          deadLettered += 1;
        } else {
          const delaySeconds = Math.min(60, 2 ** Math.min(claim.attempts, 5));
          // oxlint-disable-next-line no-await-in-loop -- each claim has exactly one retry settlement.
          await invokePort(capturedOutbox, 'nack', [
            claim.claimId,
            new Date(instantMs(timestamp) + delaySeconds * 1000).toISOString(),
            timestamp
          ]);
        }
      }
    }
  });
  await Promise.all(workers);
  return frozen({ delivered, deadLettered });
}
