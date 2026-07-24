import { AsyncLocalStorage } from 'node:async_hooks';
import { createPublicKey, X509Certificate } from 'node:crypto';

import { SAML, ValidateInResponseTo, type Profile } from '@node-saml/node-saml';

export type SamlRuntimeErrorCode = 'INVALID_SAML_CONFIG' | 'INVALID_SAML_RESPONSE';

export class SamlRuntimeError extends Error {
  constructor(
    readonly code: SamlRuntimeErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SamlRuntimeError';
  }
}

/**
 * Server-owned SAML configuration. The correlation cache must be shared by the
 * servers that create AuthnRequests and receive responses; callers never mark
 * XML or claims as trusted.
 */
export interface SamlServerConfig {
  readonly entryPoint: string;
  readonly callbackUrl: string;
  readonly serviceProviderIssuer: string;
  readonly idpIssuer: string;
  readonly idpSigningCertificates: readonly string[];
  readonly requestCorrelationStore: SamlRequestCorrelationStore;
  readonly attributes: SamlAttributeMapping;
  readonly requestIdTtlMs?: number;
  readonly acceptedClockSkewMs?: number;
  readonly maxResponseBytes?: number;
}

const verifiedSamlIdentityBrand = Symbol('verified-saml-identity');

/**
 * Opaque, bounded output of server-side Node-SAML 5.1 verification. It never
 * carries raw XML, a certificate, a browser-provided trust flag, or attributes
 * other than the small identity projection needed by a session provider.
 */
export interface VerifiedSamlIdentity {
  readonly provider: 'saml';
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  /** Present only when the configured signed attribute is exactly `true`. */
  readonly emailVerified?: true;
  readonly groups: readonly string[];
  readonly displayName?: string;
  readonly sessionIndex?: string;
  readonly validation: {
    readonly audience: string;
    readonly expiresAt: string;
    readonly requestCorrelation: 'required';
  };
  readonly [verifiedSamlIdentityBrand]: true;
}

const maxSamlResponseBytes = 256 * 1024;
const maxSamlRequestIdTtlMs = 10 * 60_000;
const minSamlRequestIdTtlMs = 10_000;
const maxSamlClockSkewMs = 2 * 60_000;
const maxSamlIssuerBytes = 1_024;
const maxSamlCertificateBytes = 64 * 1024;
const maxSamlSigningCertificates = 4;
const maxSamlEndpointBytes = 4_096;
const maxSamlRelayStateBytes = 2_048;
const defaultMaxCorrelationEntries = 512;
const maxCorrelationEntries = 1_024;
const maxCorrelationKeyBytes = 512;
const maxCorrelationEnvelopeBytes = 1_024;
const maxCorrelationExpiryHorizonMs = maxSamlRequestIdTtlMs;

/**
 * Server-owned persistence contract. `take` must atomically consume a live
 * entry across all application instances; `putIfAbsent` must enforce physical
 * expiry and never overwrite a still-live key.
 */
export interface SamlRequestCorrelationStore {
  putIfAbsent(key: string, envelope: string, expiresAt: number): Promise<boolean>;
  take(key: string): Promise<string | null>;
}

export interface InMemorySamlRequestCorrelationStoreOptions {
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/** Attribute names are deployment configuration, never browser or caller input. */
export interface SamlAttributeMapping {
  readonly emailAttribute: string;
  readonly emailVerifiedAttribute?: string;
  readonly groupsAttribute?: string;
  readonly displayNameAttribute?: string;
}

/** Test/development cache with strict expiry and capacity bounds. */
export function createInMemorySamlRequestCorrelationStore(
  options: InMemorySamlRequestCorrelationStoreOptions = {}
): SamlRequestCorrelationStore {
  const input = record(options);
  if (!input) invalidSamlConfig('SAML in-memory correlation options are invalid');
  const configuredMaxEntries = input.maxEntries ?? defaultMaxCorrelationEntries;
  const now = input.now ?? Date.now;
  if (
    !Number.isInteger(configuredMaxEntries) ||
    (configuredMaxEntries as number) < 1 ||
    (configuredMaxEntries as number) > maxCorrelationEntries
  ) {
    throw new SamlRuntimeError(
      'INVALID_SAML_CONFIG',
      'SAML in-memory correlation capacity is invalid'
    );
  }
  const maxEntries = configuredMaxEntries as number;
  if (typeof now !== 'function') invalidSamlConfig('SAML in-memory correlation clock is invalid');
  let previousNow: number | undefined;
  const sampleNow = (): number => {
    let current: unknown;
    try {
      current = now();
    } catch {
      invalidSamlConfig('SAML in-memory correlation clock failed');
    }
    if (
      !Number.isSafeInteger(current) ||
      (current as number) < 0 ||
      (previousNow !== undefined && (current as number) < previousNow)
    ) {
      invalidSamlConfig('SAML in-memory correlation clock is invalid');
    }
    previousNow = current as number;
    return current as number;
  };
  const entries = new Map<string, { readonly envelope: string; readonly expiresAt: number }>();
  const pruneExpired = () => {
    const current = sampleNow();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key);
    }
  };
  const evictForInsertion = () => {
    pruneExpired();
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };
  return Object.freeze({
    async putIfAbsent(key: string, envelope: string, expiresAt: number): Promise<boolean> {
      const current = sampleNow();
      assertCorrelationStoreInput(key, envelope, expiresAt, current);
      pruneExpired();
      if (entries.has(key)) return false;
      evictForInsertion();
      entries.set(key, { envelope, expiresAt });
      return true;
    },
    async take(key: string): Promise<string | null> {
      assertCorrelationKey(key, 'SAML correlation key is invalid');
      pruneExpired();
      const value = entries.get(key)?.envelope ?? null;
      entries.delete(key);
      return value;
    }
  });
}

type CorrelationEnvelope = {
  readonly version: 1;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly value: string;
};

function parseCorrelationEnvelope(value: string): CorrelationEnvelope {
  if (utf8ByteLength(value) > 1_024) correlationFailure('SAML correlation data is oversized');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    correlationFailure('SAML correlation data is corrupt');
  }
  const envelope = record(parsed);
  if (
    envelope === undefined ||
    Object.keys(envelope).length !== 4 ||
    envelope.version !== 1 ||
    !Number.isSafeInteger(envelope.createdAt) ||
    (envelope.createdAt as number) < 0 ||
    !Number.isSafeInteger(envelope.expiresAt) ||
    (envelope.expiresAt as number) <= (envelope.createdAt as number) ||
    typeof envelope.value !== 'string' ||
    utf8ByteLength(envelope.value) > 512 ||
    containsAsciiControl(envelope.value)
  ) {
    correlationFailure('SAML correlation data is corrupt');
  }
  return envelope as CorrelationEnvelope;
}

function correlationFailure(message: string): never {
  throw new SamlRuntimeError('INVALID_SAML_RESPONSE', message);
}

type ValidationContext = { readonly values: Map<string, string> };

/** Private Node-SAML CacheProvider adapter over the atomic Selene store. */
class NodeSamlCorrelationAdapter {
  private readonly context = new AsyncLocalStorage<ValidationContext>();

  constructor(
    private readonly store: SamlRequestCorrelationStore,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    return this.context.run({ values: new Map() }, operation);
  }

  async saveAsync(key: string, value: string): Promise<{ value: string; createdAt: number }> {
    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    const envelope = JSON.stringify({
      version: 1,
      createdAt,
      expiresAt,
      value
    } satisfies CorrelationEnvelope);
    let inserted: unknown;
    try {
      inserted = await this.store.putIfAbsent(key, envelope, expiresAt);
    } catch {
      correlationFailure('SAML correlation store failed');
    }
    if (inserted !== true) correlationFailure('SAML correlation store rejected request ID');
    return { value, createdAt };
  }

  async getAsync(key: string): Promise<string | null> {
    const context = this.context.getStore();
    if (!context) correlationFailure('SAML correlation context is unavailable');
    const cached = context.values.get(key);
    if (cached !== undefined) return cached;
    let raw: string | null;
    try {
      raw = await this.store.take(key);
    } catch {
      correlationFailure('SAML correlation store failed');
    }
    if (raw !== null && typeof raw !== 'string') {
      correlationFailure('SAML correlation store returned invalid data');
    }
    if (raw === null) return null;
    const envelope = parseCorrelationEnvelope(raw);
    const now = this.now();
    if (
      envelope.expiresAt <= now ||
      envelope.createdAt > now ||
      envelope.expiresAt - envelope.createdAt !== this.ttlMs
    ) {
      correlationFailure('SAML correlation data is expired or invalid');
    }
    context.values.set(key, envelope.value);
    return envelope.value;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key !== null) this.context.getStore()?.values.delete(key);
    return null;
  }
}

/**
 * Node-SAML 5.1 boundary. Assertions must be signed; response bytes are size
 * bounded before library parsing; issuer, audience, recipient, expiry, and
 * one-time InResponseTo correlation are mandatory.
 */
export class SamlServerVerifier {
  private readonly saml: SAML;
  private readonly callbackUrl: string;
  private readonly idpIssuer: string;
  private readonly serviceProviderIssuer: string;
  private readonly attributes: ValidatedSamlAttributeMapping;
  private readonly maxResponseBytes: number;
  private readonly correlation: NodeSamlCorrelationAdapter;

  constructor(config: SamlServerConfig) {
    const validated = validateSamlServerConfig(config);
    this.callbackUrl = validated.callbackUrl;
    this.idpIssuer = validated.idpIssuer;
    this.serviceProviderIssuer = validated.serviceProviderIssuer;
    this.attributes = validated.attributes;
    this.maxResponseBytes = validated.maxResponseBytes;
    this.correlation = new NodeSamlCorrelationAdapter(
      validated.requestCorrelationStore,
      validated.requestIdTtlMs
    );
    this.saml = new SAML({
      entryPoint: validated.entryPoint,
      callbackUrl: validated.callbackUrl,
      issuer: validated.serviceProviderIssuer,
      audience: validated.serviceProviderIssuer,
      idpIssuer: validated.idpIssuer,
      idpCert: [...validated.idpSigningCertificates],
      cacheProvider: this.correlation,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: validated.requestIdTtlMs,
      acceptedClockSkewMs: validated.acceptedClockSkewMs,
      maxAssertionAgeMs: validated.requestIdTtlMs,
      // Assertion signatures are accepted, but a response-only signature is not
      // sufficient because identity attributes must come from signed assertion bytes.
      wantAuthnResponseSigned: false,
      wantAssertionsSigned: true
    });
  }

  /** Creates and stores a one-time AuthnRequest correlation ID in the configured server cache. */
  async beginAuthorization(relayState = ''): Promise<URL> {
    if (
      typeof relayState !== 'string' ||
      utf8ByteLength(relayState) > maxSamlRelayStateBytes ||
      containsAsciiControl(relayState)
    ) {
      throw new SamlRuntimeError('INVALID_SAML_RESPONSE', 'SAML RelayState is malformed');
    }
    return new URL(await this.saml.getAuthorizeUrlAsync(relayState, undefined, {}));
  }

  async validatePostResponse(response: string): Promise<VerifiedSamlIdentity> {
    if (typeof response !== 'string') rejectSamlResponse('SAML response is malformed or too large');
    assertBoundedSamlResponse(response, this.maxResponseBytes);
    return this.correlation.run(async () => {
      try {
        const result = await this.saml.validatePostResponseAsync({ SAMLResponse: response });
        if (result.loggedOut || !result.profile)
          rejectSamlResponse('SAML response has no assertion');
        return projectVerifiedSamlIdentity({
          profile: result.profile,
          expectedIssuer: this.idpIssuer,
          expectedRecipient: this.callbackUrl,
          expectedAudience: this.serviceProviderIssuer,
          attributes: this.attributes
        });
      } catch (error) {
        if (error instanceof SamlRuntimeError) throw error;
        throw new SamlRuntimeError('INVALID_SAML_RESPONSE', 'SAML response validation failed');
      }
    });
  }
}

function validateSamlServerConfig(config: unknown): {
  readonly entryPoint: string;
  readonly callbackUrl: string;
  readonly serviceProviderIssuer: string;
  readonly idpIssuer: string;
  readonly idpSigningCertificates: readonly string[];
  readonly requestCorrelationStore: SamlRequestCorrelationStore;
  readonly attributes: ValidatedSamlAttributeMapping;
  readonly requestIdTtlMs: number;
  readonly acceptedClockSkewMs: number;
  readonly maxResponseBytes: number;
} {
  const input = record(config);
  if (!input) invalidSamlConfig('SAML server configuration is invalid');
  const entryPoint = serverHttpsUrl(input.entryPoint, 'entry point', true);
  const callbackUrl = serverHttpsUrl(input.callbackUrl, 'callback URL');
  const configuredRequestIdTtlMs = input.requestIdTtlMs ?? 5 * 60_000;
  const configuredClockSkewMs = input.acceptedClockSkewMs ?? 0;
  const configuredResponseLimit = input.maxResponseBytes ?? maxSamlResponseBytes;
  const serviceProviderIssuer = boundedConfigText(
    input.serviceProviderIssuer,
    'service provider issuer',
    maxSamlIssuerBytes
  );
  const idpIssuer = boundedConfigText(input.idpIssuer, 'IdP issuer', maxSamlIssuerBytes);
  const idpSigningCertificates = validatedSigningCertificates(input.idpSigningCertificates);
  const requestCorrelationStore = captureCorrelationStore(input.requestCorrelationStore);
  if (
    !Number.isInteger(configuredRequestIdTtlMs) ||
    (configuredRequestIdTtlMs as number) < minSamlRequestIdTtlMs ||
    (configuredRequestIdTtlMs as number) > maxSamlRequestIdTtlMs
  ) {
    invalidSamlConfig('SAML request correlation TTL must be between 10 seconds and 10 minutes');
  }
  if (
    !Number.isInteger(configuredClockSkewMs) ||
    (configuredClockSkewMs as number) < 0 ||
    (configuredClockSkewMs as number) > maxSamlClockSkewMs
  ) {
    invalidSamlConfig('SAML clock skew must be between 0 and 2 minutes');
  }
  if (
    !Number.isInteger(configuredResponseLimit) ||
    (configuredResponseLimit as number) < 1_024 ||
    (configuredResponseLimit as number) > maxSamlResponseBytes
  ) {
    invalidSamlConfig('SAML response size limit is invalid');
  }
  return Object.freeze({
    entryPoint,
    callbackUrl,
    serviceProviderIssuer,
    idpIssuer,
    idpSigningCertificates,
    requestCorrelationStore,
    attributes: validateSamlAttributeMapping(input.attributes),
    requestIdTtlMs: configuredRequestIdTtlMs as number,
    acceptedClockSkewMs: configuredClockSkewMs as number,
    maxResponseBytes: configuredResponseLimit as number
  });
}

function serverHttpsUrl(value: unknown, label: string, allowQuery = false): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8ByteLength(value) > maxSamlEndpointBytes ||
    containsAsciiControl(value)
  ) {
    invalidSamlConfig(`SAML ${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidSamlConfig(`SAML ${label} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (!allowQuery && url.search)
  ) {
    invalidSamlConfig(`SAML ${label} must be an absolute HTTPS URL without credentials`);
  }
  return url.href;
}

function boundedConfigText(value: unknown, label: string, maximumBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    utf8ByteLength(value) > maximumBytes ||
    containsAsciiControl(value)
  ) {
    invalidSamlConfig(`SAML ${label} is invalid`);
  }
  return value;
}

function validatedSigningCertificates(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxSamlSigningCertificates) {
    invalidSamlConfig('SAML IdP signing certificates are invalid');
  }
  const certificates = value.map((entry) => boundedCertificate(entry));
  if (new Set(certificates).size !== certificates.length) {
    invalidSamlConfig('SAML IdP signing certificates must not contain duplicates');
  }
  return Object.freeze([...certificates]);
}

function boundedCertificate(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    utf8ByteLength(value) > maxSamlCertificateBytes ||
    containsUnsafeCertificateControl(value)
  ) {
    invalidSamlConfig('SAML IdP signing certificate is invalid');
  }
  if (/-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/.test(value)) {
    invalidSamlConfig('SAML IdP signing certificate is invalid');
  }
  let certificate: X509Certificate | undefined;
  try {
    certificate = new X509Certificate(value);
  } catch {
    // A PEM public key (rather than a full X.509 certificate) is also valid.
  }
  if (certificate) {
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    const now = Date.now();
    if (
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      validFrom > now ||
      validTo <= now
    ) {
      invalidSamlConfig('SAML IdP signing certificate is expired or not yet valid');
    }
  } else {
    try {
      createPublicKey(value);
    } catch {
      invalidSamlConfig('SAML IdP signing certificate is invalid');
    }
  }
  return value;
}

function captureCorrelationStore(value: unknown): SamlRequestCorrelationStore {
  if (value === null || typeof value !== 'object') {
    invalidSamlConfig('SAML request correlation store is required');
  }
  const store = value as Partial<SamlRequestCorrelationStore>;
  if (typeof store.putIfAbsent !== 'function' || typeof store.take !== 'function') {
    invalidSamlConfig('SAML request correlation store is required');
  }
  const putIfAbsent = store.putIfAbsent.bind(store);
  const take = store.take.bind(store);
  return Object.freeze({ putIfAbsent, take });
}

function assertCorrelationStoreInput(
  key: unknown,
  envelope: unknown,
  expiresAt: unknown,
  now: number
): void {
  assertCorrelationKey(key, 'SAML correlation key is invalid');
  if (
    typeof envelope !== 'string' ||
    envelope.length === 0 ||
    utf8ByteLength(envelope) > maxCorrelationEnvelopeBytes ||
    containsAsciiControl(envelope)
  ) {
    invalidSamlConfig('SAML correlation envelope is invalid');
  }
  if (
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= now ||
    (expiresAt as number) - now > maxCorrelationExpiryHorizonMs
  ) {
    invalidSamlConfig('SAML correlation expiry is invalid');
  }
}

function assertCorrelationKey(key: unknown, message: string): asserts key is string {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    utf8ByteLength(key) > maxCorrelationKeyBytes ||
    containsAsciiControl(key)
  ) {
    invalidSamlConfig(message);
  }
}

function invalidSamlConfig(message: string): never {
  throw new SamlRuntimeError('INVALID_SAML_CONFIG', message);
}

function assertBoundedSamlResponse(response: string, maxBytes: number): void {
  const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
  if (
    response.length === 0 ||
    response.length > maxEncodedLength ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(response)
  ) {
    rejectSamlResponse('SAML response is malformed or too large');
  }
  let decoded: string;
  try {
    decoded = atob(response);
  } catch {
    rejectSamlResponse('SAML response is malformed or too large');
  }
  if (decoded.length > maxBytes) rejectSamlResponse('SAML response is malformed or too large');
}

type ValidatedSamlAttributeMapping = {
  readonly emailAttribute: string;
  readonly emailVerifiedAttribute?: string;
  readonly groupsAttribute?: string;
  readonly displayNameAttribute?: string;
};

function validateSamlAttributeMapping(input: unknown): ValidatedSamlAttributeMapping {
  const mapping = record(input);
  if (!mapping) invalidSamlConfig('SAML attribute mapping is required');
  const emailAttribute = validateSamlAttributeName(mapping.emailAttribute, 'email');
  const emailVerifiedAttribute = optionalSamlAttributeName(
    mapping.emailVerifiedAttribute,
    'email verification'
  );
  const groupsAttribute = optionalSamlAttributeName(mapping.groupsAttribute, 'groups');
  const displayNameAttribute = optionalSamlAttributeName(
    mapping.displayNameAttribute,
    'display name'
  );
  const names = [
    emailAttribute,
    emailVerifiedAttribute,
    groupsAttribute,
    displayNameAttribute
  ].filter((name): name is string => name !== undefined);
  if (new Set(names).size !== names.length) {
    invalidSamlConfig('SAML attribute mapping names must not be duplicated');
  }
  return Object.freeze({
    emailAttribute,
    ...(emailVerifiedAttribute === undefined ? {} : { emailVerifiedAttribute }),
    ...(groupsAttribute === undefined ? {} : { groupsAttribute }),
    ...(displayNameAttribute === undefined ? {} : { displayNameAttribute })
  });
}

function optionalSamlAttributeName(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : validateSamlAttributeName(value, label);
}

function validateSamlAttributeName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
    invalidSamlConfig(`SAML ${label} attribute name is invalid`);
  }
  return value;
}

function projectVerifiedSamlIdentity(input: {
  readonly profile: Profile;
  readonly expectedIssuer: string;
  readonly expectedRecipient: string;
  readonly expectedAudience: string;
  readonly attributes: ValidatedSamlAttributeMapping;
}): VerifiedSamlIdentity {
  const { profile, expectedIssuer, expectedRecipient, expectedAudience, attributes } = input;
  if (profile.issuer !== expectedIssuer) rejectSamlResponse('SAML assertion issuer is not allowed');
  const subject = boundedSamlText(profile.nameID, 'subject', 512);
  const confirmation = verifiedSubjectConfirmation(profile);
  if (confirmation.recipient !== expectedRecipient) {
    rejectSamlResponse('SAML assertion recipient does not match the callback URL');
  }
  const expiresAt = boundedSamlText(confirmation.notOnOrAfter, 'expiry', 64);
  if (!Number.isFinite(Date.parse(expiresAt)))
    rejectSamlResponse('SAML assertion expiry is malformed');
  const signedAttributes = record(profile.attributes);
  if (!signedAttributes) rejectSamlResponse('SAML assertion has no signed attributes');
  assertNoDuplicateConfiguredAttributes(profile, attributes);
  const email = singleSignedAttribute(signedAttributes, attributes.emailAttribute, 'email', 320);
  const emailVerified = signedBooleanAttribute(
    signedAttributes,
    attributes.emailVerifiedAttribute,
    'email verification'
  );
  const groups = signedGroupIds(signedAttributes, attributes.groupsAttribute);
  const displayName = optionalSignedAttribute(
    signedAttributes,
    attributes.displayNameAttribute,
    'display name',
    256
  );
  const sessionIndex =
    typeof profile.sessionIndex === 'string'
      ? boundedSamlText(profile.sessionIndex, 'session index', 512)
      : undefined;
  return Object.freeze({
    provider: 'saml' as const,
    issuer: expectedIssuer,
    subject,
    email,
    ...(emailVerified ? { emailVerified: true as const } : {}),
    groups: Object.freeze(groups),
    ...(displayName === undefined ? {} : { displayName }),
    ...(sessionIndex === undefined ? {} : { sessionIndex }),
    validation: Object.freeze({
      audience: expectedAudience,
      expiresAt,
      requestCorrelation: 'required' as const
    }),
    [verifiedSamlIdentityBrand]: true as const
  });
}

function singleSignedAttribute(
  attributes: Record<string, unknown>,
  name: string,
  label: string,
  maximumLength: number
): string {
  const values = signedAttributeValues(attributes, name, label);
  if (!values || values.length !== 1)
    rejectSamlResponse(`SAML ${label} attribute is required once`);
  return boundedSamlText(values[0], label, maximumLength);
}

function optionalSignedAttribute(
  attributes: Record<string, unknown>,
  name: string | undefined,
  label: string,
  maximumLength: number
): string | undefined {
  if (name === undefined) return undefined;
  const values = signedAttributeValues(attributes, name, label);
  if (values === undefined) return undefined;
  if (values.length !== 1) rejectSamlResponse(`SAML ${label} attribute must be singular`);
  return boundedSamlText(values[0], label, maximumLength);
}

function signedBooleanAttribute(
  attributes: Record<string, unknown>,
  name: string | undefined,
  label: string
): boolean {
  if (name === undefined) return false;
  const values = signedAttributeValues(attributes, name, label);
  if (values === undefined) return false;
  if (values.length !== 1 || (values[0] !== 'true' && values[0] !== 'false')) {
    rejectSamlResponse(`SAML ${label} attribute must be true or false`);
  }
  return values[0] === 'true';
}

function signedGroupIds(
  attributes: Record<string, unknown>,
  name: string | undefined
): readonly string[] {
  if (name === undefined) return [];
  const values = signedAttributeValues(attributes, name, 'groups');
  if (values === undefined) return [];
  if (values.length > 64) rejectSamlResponse('SAML groups attribute has too many values');
  const groups = new Set<string>();
  for (const value of values) {
    const group = boundedSamlText(value, 'group', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(group)) {
      rejectSamlResponse('SAML group identifier is malformed');
    }
    if (groups.has(group)) rejectSamlResponse('SAML groups attribute contains duplicate values');
    groups.add(group);
  }
  return [...groups];
}

function signedAttributeValues(
  attributes: Record<string, unknown>,
  name: string,
  label: string
): readonly string[] | undefined {
  const value = attributes[name];
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== 'string')) {
    rejectSamlResponse(`SAML ${label} attribute is malformed`);
  }
  return values as readonly string[];
}

function assertNoDuplicateConfiguredAttributes(
  profile: Profile,
  attributes: ValidatedSamlAttributeMapping
): void {
  const assertion = record(profile.getAssertion?.());
  const signedAssertion = assertion && firstRecord(assertion.Assertion);
  const statements = signedAssertion && recordArray(signedAssertion.AttributeStatement);
  if (!statements) rejectSamlResponse('SAML assertion has no signed attributes');
  const configured = new Set(
    [
      attributes.emailAttribute,
      attributes.emailVerifiedAttribute,
      attributes.groupsAttribute,
      attributes.displayNameAttribute
    ].filter((name): name is string => name !== undefined)
  );
  const occurrences = new Map<string, number>();
  for (const statement of statements) {
    const values = recordArray(statement.Attribute) ?? [];
    for (const attribute of values) {
      const name = record(attribute.$)?.Name;
      if (typeof name !== 'string' || !configured.has(name)) continue;
      const count = (occurrences.get(name) ?? 0) + 1;
      if (count > 1) rejectSamlResponse(`SAML ${name} attribute appears more than once`);
      occurrences.set(name, count);
    }
  }
}

function verifiedSubjectConfirmation(profile: Profile): {
  readonly recipient: string;
  readonly notOnOrAfter: string;
} {
  const assertion = profile.getAssertion?.();
  const root = record(assertion);
  const signedAssertion = root && firstRecord(root.Assertion);
  const subject = signedAssertion && firstRecord(signedAssertion.Subject);
  const confirmations = subject && recordArray(subject.SubjectConfirmation);
  if (!confirmations || confirmations.length !== 1) {
    rejectSamlResponse('SAML assertion must have exactly one subject confirmation');
  }
  const confirmationData = recordArray(confirmations[0]?.SubjectConfirmationData);
  if (!confirmationData || confirmationData.length !== 1) {
    rejectSamlResponse('SAML assertion subject confirmation is malformed');
  }
  const attributes = record(confirmationData[0]?.$);
  const recipient = attributes?.Recipient;
  const notOnOrAfter = attributes?.NotOnOrAfter;
  if (typeof recipient !== 'string' || typeof notOnOrAfter !== 'string') {
    rejectSamlResponse('SAML assertion subject confirmation is incomplete');
  }
  return { recipient, notOnOrAfter };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return record(value) ?? (Array.isArray(value) ? record(value[0]) : undefined);
}

function recordArray(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(record);
  return values.every((item) => item !== undefined)
    ? (values as readonly Record<string, unknown>[])
    : undefined;
}

function boundedSamlText(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    utf8ByteLength(value) > maximumLength ||
    containsAsciiControl(value)
  ) {
    rejectSamlResponse(`SAML ${label} is malformed`);
  }
  return value;
}

function rejectSamlResponse(message: string): never {
  throw new SamlRuntimeError('INVALID_SAML_RESPONSE', message);
}

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || point === 127);
  });
}

function containsUnsafeCertificateControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && point < 32 && point !== 10 && point !== 13;
  });
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
