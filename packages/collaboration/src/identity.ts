/**
 * Provider-neutral enterprise identity contract.
 *
 * This module intentionally contains no cryptography, token parsing, or XML
 * signature processing. Production OIDC and SAML adapters must delegate those
 * operations to a maintained protocol library or the identity provider SDK.
 */
export const identityContract = 'selene-identity/v1' as const;

export type IdentityRole = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer' | 'guest';
export type IdentityProviderKind = 'local' | 'oidc' | 'saml' | 'scim';

export interface IdentityOrganization {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface IdentitySubject {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly displayName: string;
  /** Stable provider subject, never an email address. */
  readonly externalSubject?: string;
  readonly provider: IdentityProviderKind;
}

export interface IdentityMembership {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly role: IdentityRole;
}

export interface AuthenticatedIdentity {
  readonly contract: typeof identityContract;
  readonly subject: IdentitySubject;
  readonly organization: IdentityOrganization;
  readonly membership: IdentityMembership;
}

/** Explicit, account-free development identity. It must never be selected by a production host. */
export interface LocalIdentityProvider {
  readonly kind: 'local';
  authenticate(): Promise<AuthenticatedIdentity>;
}

export function createLocalIdentityProvider(
  identity: AuthenticatedIdentity
): LocalIdentityProvider {
  if (identity.contract !== identityContract || identity.subject.provider !== 'local') {
    throw new IdentityContractError(
      'INVALID_LOCAL_IDENTITY',
      'Local mode requires a local identity'
    );
  }
  if (
    identity.subject.organizationId !== identity.organization.id ||
    identity.membership.organizationId !== identity.organization.id ||
    identity.membership.subjectId !== identity.subject.id
  ) {
    throw new IdentityContractError(
      'INVALID_LOCAL_IDENTITY',
      'Local identity ownership does not match'
    );
  }
  return {
    kind: 'local',
    async authenticate() {
      return identity;
    }
  };
}

export type IdentityContractErrorCode =
  'INVALID_CALLBACK' | 'PROVIDER_ERROR' | 'INVALID_PKCE_VERIFIER' | 'INVALID_LOCAL_IDENTITY';

export class IdentityContractError extends Error {
  constructor(
    readonly code: IdentityContractErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'IdentityContractError';
  }
}

export interface OidcAuthorizationRequest {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  /** Opaque, one-time BFF transaction identifier. */
  readonly state: string;
  /** SHA-256 derived PKCE challenge. The verifier stays only in the BFF transaction store. */
  readonly codeChallenge: string;
  readonly codeChallengeMethod: 'S256';
}

export interface OidcCallbackExpectation {
  readonly state: string;
  readonly codeVerifier: string;
}

export interface OidcAuthorizationCallback {
  readonly code: string;
  readonly state: string;
}

export interface OidcTokenSet {
  /** Tokens are opaque credentials; adapters must not log or return them to browsers. */
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: string;
}

/**
 * Authorization Code + PKCE port. An implementation verifies issuer,
 * signature, audience, nonce, expiry, and `at_hash` (where applicable) with
 * its maintained OIDC library before returning an identity.
 */
export interface OidcAuthorizationCodePort {
  beginAuthorization(
    request: OidcAuthorizationRequest
  ): Promise<{ readonly authorizationUrl: string }>;
  exchangeAuthorizationCode(input: {
    readonly callback: OidcAuthorizationCallback;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<{ readonly tokens: OidcTokenSet; readonly identity: AuthenticatedIdentity }>;
}

/** RFC 7636 permits 43--128 unreserved characters. Do not generate it here. */
export function assertPkceVerifier(value: string): void {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(value)) {
    throw new IdentityContractError(
      'INVALID_PKCE_VERIFIER',
      'PKCE verifier must be 43-128 unreserved characters'
    );
  }
}

/** Rejects provider errors, duplicate parameters, missing state, and malformed authorization codes. */
export function validateOidcAuthorizationCallback(
  parameters: URLSearchParams,
  expected: OidcCallbackExpectation
): OidcAuthorizationCallback {
  assertPkceVerifier(expected.codeVerifier);
  const error = singleParameter(parameters, 'error');
  if (error !== undefined) {
    throw new IdentityContractError('PROVIDER_ERROR', `OIDC provider returned ${error}`);
  }
  const code = requiredParameter(parameters, 'code');
  const state = requiredParameter(parameters, 'state');
  if (state !== expected.state) {
    throw new IdentityContractError(
      'INVALID_CALLBACK',
      'OIDC callback state did not match the BFF transaction'
    );
  }
  if (code.length > 2048 || containsAsciiControl(code)) {
    throw new IdentityContractError('INVALID_CALLBACK', 'OIDC callback code is malformed');
  }
  return { code, state };
}

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || point === 127);
  });
}

function singleParameter(parameters: URLSearchParams, name: string): string | undefined {
  const values = parameters.getAll(name);
  if (values.length > 1) {
    throw new IdentityContractError('INVALID_CALLBACK', `OIDC callback has repeated ${name}`);
  }
  return values[0];
}

function requiredParameter(parameters: URLSearchParams, name: string): string {
  const value = singleParameter(parameters, name);
  if (!value)
    throw new IdentityContractError('INVALID_CALLBACK', `OIDC callback is missing ${name}`);
  return value;
}

/** Server-side BFF transaction and session ports. Browser cookies contain opaque IDs only. */
export interface BffTransaction {
  readonly id: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly expiresAt: string;
}

export interface BffSession {
  readonly id: string;
  readonly subjectId: string;
  readonly organizationId: string;
  readonly role: IdentityRole;
  readonly expiresAt: string;
}

export interface BffSessionStore {
  createTransaction(transaction: BffTransaction): Promise<void>;
  consumeTransaction(id: string): Promise<BffTransaction | undefined>;
  createSession(session: BffSession): Promise<void>;
  readSession(id: string): Promise<BffSession | undefined>;
  revokeSession(id: string): Promise<void>;
}

export interface BffSessionPort {
  begin(input: { readonly redirectUri: string }): Promise<{
    readonly authorizationUrl: string;
    readonly transactionCookie: string;
  }>;
  complete(input: {
    readonly callback: URLSearchParams;
    readonly transactionCookie: string;
  }): Promise<{
    readonly sessionCookie: string;
    readonly identity: AuthenticatedIdentity;
  }>;
  authenticate(sessionCookie: string): Promise<AuthenticatedIdentity | undefined>;
  logout(sessionCookie: string): Promise<void>;
}

/** A SAML adapter receives a verified assertion from a maintained SAML library, never raw XML. */
export interface SamlVerifiedAssertion {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
  readonly audience: string;
  readonly notOnOrAfter: string;
  readonly sessionIndex?: string;
}

export interface SamlAdapterPort {
  validateResponse(input: {
    readonly response: string;
    readonly relayState?: string;
  }): Promise<SamlVerifiedAssertion>;
  provision(assertion: SamlVerifiedAssertion): Promise<AuthenticatedIdentity>;
}

export interface ScimUser {
  readonly id: string;
  readonly externalId?: string;
  readonly userName: string;
  readonly displayName?: string;
  readonly active: boolean;
}

export interface ScimDirectoryPort {
  upsertUser(user: ScimUser): Promise<AuthenticatedIdentity>;
  /** Must be idempotent: repeating the same SCIM delete/deactivation is a no-op. */
  deprovisionUser(scimUserId: string): Promise<'deprovisioned' | 'already_deprovisioned'>;
}

export async function applyScimUser(
  directory: ScimDirectoryPort,
  user: ScimUser
): Promise<AuthenticatedIdentity | 'deprovisioned' | 'already_deprovisioned'> {
  return user.active ? directory.upsertUser(user) : directory.deprovisionUser(user.id);
}

const auditSensitiveKey =
  /authorization|cookie|credential|password|secret|token|assertion|code[_-]?verifier/i;

/** Removes credentials and assertions before an authentication audit record is emitted. */
export function redactAuditAttributes(value: unknown, key = ''): unknown {
  if (auditSensitiveKey.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactAuditAttributes(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactAuditAttributes(entryValue, entryKey)
      ])
    );
  }
  return value;
}

export interface IdentityAuditEvent {
  readonly occurredAt: string;
  readonly action: 'login.succeeded' | 'login.failed' | 'logout' | 'scim.deprovisioned';
  readonly subjectId?: string;
  readonly attributes: Record<string, unknown>;
}

export function redactIdentityAuditEvent(event: IdentityAuditEvent): IdentityAuditEvent {
  return {
    ...event,
    attributes: redactAuditAttributes(event.attributes) as Record<string, unknown>
  };
}
