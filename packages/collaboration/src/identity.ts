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
  | 'INVALID_CALLBACK'
  | 'PROVIDER_ERROR'
  | 'INVALID_PKCE_VERIFIER'
  | 'INVALID_LOCAL_IDENTITY'
  | 'INVALID_ADMINISTRATION_INPUT';

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
  readonly action:
    | 'login.succeeded'
    | 'login.failed'
    | 'logout'
    | 'scim.deprovisioned'
    | 'break_glass.recovery_started';
  readonly subjectId?: string;
  readonly attributes: Record<string, unknown>;
}

export function redactIdentityAuditEvent(event: IdentityAuditEvent): IdentityAuditEvent {
  return {
    ...event,
    attributes: redactAuditAttributes(event.attributes) as Record<string, unknown>
  };
}

/**
 * Provider-neutral organization administration contracts. These contracts do
 * not verify a DNS record, JWT, or SAML assertion themselves: adapters supply
 * verified inputs and persist the resulting decisions atomically.
 */
export type SsoEnforcement = 'optional' | 'required';
export type MappedIdentityProvider = 'oidc' | 'saml';
export type InvitationRole = Exclude<IdentityRole, 'owner'>;
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface VerifiedOrganizationDomain {
  readonly organizationId: string;
  /** Lowercase ASCII DNS name; wildcard and email-address values are invalid. */
  readonly domain: string;
  readonly verifiedAt: string;
}

/** A verified email domain may discover an organization, but never authorizes it alone. */
export function findOrganizationForVerifiedEmail(
  email: string,
  domains: readonly VerifiedOrganizationDomain[]
): string | undefined {
  const domain = emailDomain(email);
  if (domain === undefined) return undefined;
  const matches = domains.filter((candidate) => candidate.domain === domain);
  // A domain must belong to exactly one live organization; ambiguity fails closed.
  return matches.length === 1 ? matches[0]?.organizationId : undefined;
}

export interface OrganizationSsoPolicy {
  readonly organizationId: string;
  readonly enforcement: SsoEnforcement;
  /** Empty means any configured OIDC/SAML provider may authenticate. */
  readonly allowedProviders: readonly MappedIdentityProvider[];
  /** Empty means issuer selection is delegated to the configured provider adapter. */
  readonly allowedIssuers: readonly string[];
}

export interface SsoSignInAttempt {
  readonly organizationId: string;
  readonly provider: IdentityProviderKind;
  readonly issuer?: string;
  readonly email: string;
  /** Set only after the adapter has cryptographically verified the provider assertion. */
  readonly providerAssertionVerified: boolean;
  /** Set only after the adapter has verified the email claim according to its provider policy. */
  readonly emailVerified: boolean;
}

export type SsoSignInDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | 'UNVERIFIED_ASSERTION'
        | 'UNVERIFIED_EMAIL'
        | 'UNVERIFIED_DOMAIN'
        | 'SSO_REQUIRED'
        | 'PROVIDER_NOT_ALLOWED'
        | 'ISSUER_NOT_ALLOWED';
    };

/**
 * Evaluates organization SSO policy after protocol verification. Local mode is
 * deliberately outside this function: a local-only host has no enterprise
 * organization policy and therefore does not accidentally inherit SSO rules.
 */
export function evaluateOrganizationSsoPolicy(
  policy: OrganizationSsoPolicy,
  attempt: SsoSignInAttempt,
  domains: readonly VerifiedOrganizationDomain[]
): SsoSignInDecision {
  if (attempt.organizationId !== policy.organizationId || !attempt.providerAssertionVerified) {
    return { allowed: false, reason: 'UNVERIFIED_ASSERTION' };
  }
  if (!attempt.emailVerified) return { allowed: false, reason: 'UNVERIFIED_EMAIL' };
  if (findOrganizationForVerifiedEmail(attempt.email, domains) !== policy.organizationId) {
    return { allowed: false, reason: 'UNVERIFIED_DOMAIN' };
  }
  if (attempt.provider === 'local' || attempt.provider === 'scim') {
    return {
      allowed: false,
      reason: policy.enforcement === 'required' ? 'SSO_REQUIRED' : 'PROVIDER_NOT_ALLOWED'
    };
  }
  if (policy.allowedProviders.length > 0 && !policy.allowedProviders.includes(attempt.provider)) {
    return { allowed: false, reason: 'PROVIDER_NOT_ALLOWED' };
  }
  if (
    policy.allowedIssuers.length > 0 &&
    (attempt.issuer === undefined || !policy.allowedIssuers.includes(attempt.issuer))
  ) {
    return { allowed: false, reason: 'ISSUER_NOT_ALLOWED' };
  }
  return { allowed: true };
}

export interface GroupRoleMapping {
  readonly id: string;
  readonly organizationId: string;
  readonly provider: MappedIdentityProvider;
  readonly issuer: string;
  /** Immutable provider group identifier, never an administrator-entered display name. */
  readonly externalGroupId: string;
  readonly role: InvitationRole;
}

export interface VerifiedGroupClaims {
  readonly organizationId: string;
  readonly provider: MappedIdentityProvider;
  readonly issuer: string;
  readonly subject: string;
  readonly groups: readonly string[];
  /** False for browser input, unsigned claims, or a claim from another issuer. */
  readonly verified: boolean;
}

const groupRoleRank: Readonly<Record<InvitationRole, number>> = {
  guest: 0,
  viewer: 1,
  commenter: 2,
  editor: 3,
  admin: 4
};

/**
 * Derives the highest explicitly configured non-owner role from verified group
 * IDs. A missing, duplicated, or forged claim never grants a role.
 */
export function roleFromVerifiedGroups(
  claims: VerifiedGroupClaims,
  mappings: readonly GroupRoleMapping[]
): InvitationRole | undefined {
  if (!claims.verified || !claims.subject || new Set(claims.groups).size !== claims.groups.length) {
    return undefined;
  }
  const claimedGroups = new Set(claims.groups);
  const applicable = mappings.filter(
    (mapping) =>
      mapping.organizationId === claims.organizationId &&
      mapping.provider === claims.provider &&
      mapping.issuer === claims.issuer &&
      claimedGroups.has(mapping.externalGroupId)
  );
  return applicable.reduce<InvitationRole | undefined>((highest, mapping) => {
    if (highest === undefined || groupRoleRank[mapping.role] > groupRoleRank[highest]) {
      return mapping.role;
    }
    return highest;
  }, undefined);
}

export interface GuestReviewPolicy {
  readonly organizationId: string;
  readonly allowInvitedGuests: boolean;
}

/** Guests are explicit, read-only review identities and cannot gain a stronger role by invite. */
export function mayInviteGuest(policy: GuestReviewPolicy, role: InvitationRole): boolean {
  return policy.allowInvitedGuests && role === 'guest';
}

export interface OrganizationInvitation {
  readonly id: string;
  readonly organizationId: string;
  readonly email: string;
  readonly role: InvitationRole;
  /** SHA-256 digest of an opaque one-time secret; the raw secret is never persisted. */
  readonly tokenHash: string;
  readonly status: InvitationStatus;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly acceptedBy?: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
}

export interface InvitationAcceptance {
  readonly subjectId: string;
  readonly email: string;
  readonly organizationId: string;
  /** An adapter may set this only after provider/local-account verification. */
  readonly emailVerified: boolean;
}

export type InvitationAcceptanceDecision =
  | { readonly accepted: true; readonly membership: IdentityMembership }
  | {
      readonly accepted: false;
      readonly reason:
        | 'NOT_PENDING'
        | 'EXPIRED'
        | 'ORGANIZATION_MISMATCH'
        | 'EMAIL_MISMATCH'
        | 'UNVERIFIED_EMAIL'
        | 'GUESTS_DISABLED';
    };

/** Accept an already token-resolved invitation; lookup and token hashing stay in the host adapter. */
export function acceptOrganizationInvitation(
  invitation: OrganizationInvitation,
  acceptance: InvitationAcceptance,
  guestPolicy: GuestReviewPolicy,
  now: string
): InvitationAcceptanceDecision {
  if (invitation.status !== 'pending') return { accepted: false, reason: 'NOT_PENDING' };
  if (!isFuture(invitation.expiresAt, now)) return { accepted: false, reason: 'EXPIRED' };
  if (invitation.organizationId !== acceptance.organizationId)
    return { accepted: false, reason: 'ORGANIZATION_MISMATCH' };
  if (
    invitation.role === 'guest' &&
    (guestPolicy.organizationId !== invitation.organizationId ||
      !mayInviteGuest(guestPolicy, invitation.role))
  ) {
    return { accepted: false, reason: 'GUESTS_DISABLED' };
  }
  if (!acceptance.emailVerified) return { accepted: false, reason: 'UNVERIFIED_EMAIL' };
  const invitedEmail = normalizeEmail(invitation.email);
  const acceptedEmail = normalizeEmail(acceptance.email);
  if (invitedEmail === undefined || acceptedEmail === undefined || invitedEmail !== acceptedEmail)
    return { accepted: false, reason: 'EMAIL_MISMATCH' };
  return {
    accepted: true,
    membership: {
      organizationId: invitation.organizationId,
      subjectId: acceptance.subjectId,
      role: invitation.role
    }
  };
}

export interface MembershipAccessState {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly role: IdentityRole;
  readonly accessVersion: number;
  readonly revokedAt?: string;
}

export interface SessionAccessState {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly accessVersion: number;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

/** Access versioning plus membership revocation makes deprovisioning effective before token expiry. */
export function sessionHasActiveMembership(
  session: SessionAccessState,
  membership: MembershipAccessState | undefined,
  now: string
): boolean {
  return (
    membership !== undefined &&
    membership.revokedAt === undefined &&
    session.revokedAt === undefined &&
    isFuture(session.expiresAt, now) &&
    membership.organizationId === session.organizationId &&
    membership.subjectId === session.subjectId &&
    membership.accessVersion === session.accessVersion
  );
}

export interface BreakGlassRecoveryRequest {
  readonly organizationId: string;
  readonly subjectId: string;
  readonly caseId: string;
  readonly reason: string;
  readonly expiresAt: string;
}

/** Break-glass may restore an owner only briefly, with a traceable case and a substantive reason. */
export function validateBreakGlassRecovery(request: BreakGlassRecoveryRequest, now: string): void {
  if (!request.caseId.trim() || request.reason.trim().length < 20) {
    throw new IdentityContractError(
      'INVALID_ADMINISTRATION_INPUT',
      'Break-glass recovery requires a case ID and a 20-character reason'
    );
  }
  const expires = new Date(request.expiresAt).getTime();
  const current = new Date(now).getTime();
  if (
    !Number.isFinite(expires) ||
    !Number.isFinite(current) ||
    expires <= current ||
    expires > current + 86_400_000
  ) {
    throw new IdentityContractError(
      'INVALID_ADMINISTRATION_INPUT',
      'Break-glass recovery must expire within 24 hours'
    );
  }
}

/** Emit this immutable redacted event in the same transaction as the temporary recovery grant. */
export function createBreakGlassRecoveryAuditEvent(
  request: BreakGlassRecoveryRequest,
  actorId: string,
  now: string
): IdentityAuditEvent {
  validateBreakGlassRecovery(request, now);
  return redactIdentityAuditEvent({
    occurredAt: now,
    action: 'break_glass.recovery_started',
    subjectId: request.subjectId,
    attributes: {
      organizationId: request.organizationId,
      actorId,
      caseId: request.caseId,
      reason: request.reason,
      expiresAt: request.expiresAt
    }
  });
}

/**
 * Minimal persistence port for a headless organization-admin host. Implement
 * all mutating calls in one database transaction so a deprovisioned subject
 * cannot race a new session or retained membership.
 */
export interface IdentityAdministrationRepository {
  /** Every operation receives the concrete unit of work selected by the adapter. */
  transaction<T>(operation: (unit: IdentityAdministrationRepository) => Promise<T>): Promise<T>;
  findInvitationByTokenHash(tokenHash: string): Promise<OrganizationInvitation | undefined>;
  readGuestReviewPolicy(organizationId: string): Promise<GuestReviewPolicy>;
  acceptInvitation(invitationId: string, acceptedBy: string, acceptedAt: string): Promise<void>;
  upsertMembership(membership: IdentityMembership): Promise<void>;
  recordBreakGlassRecovery(request: BreakGlassRecoveryRequest, actorId: string): Promise<void>;
  revokeMemberships(organizationId: string, subjectId: string, revokedAt: string): Promise<void>;
  revokeSessions(organizationId: string, subjectId: string, revokedAt: string): Promise<void>;
  recordAudit(event: IdentityAuditEvent): Promise<void>;
}

export function createIdentityAdministrationService(
  repository: IdentityAdministrationRepository,
  now: () => string
) {
  return {
    async acceptInvitation(tokenHash: string, acceptance: InvitationAcceptance) {
      const occurredAt = now();
      return repository.transaction(async (unit) => {
        const invitation = await unit.findInvitationByTokenHash(tokenHash);
        if (invitation === undefined)
          return { accepted: false as const, reason: 'NOT_PENDING' as const };
        const guestPolicy = await unit.readGuestReviewPolicy(invitation.organizationId);
        const decision = acceptOrganizationInvitation(
          invitation,
          acceptance,
          guestPolicy,
          occurredAt
        );
        if (!decision.accepted) return decision;
        await unit.upsertMembership(decision.membership);
        await unit.acceptInvitation(invitation.id, acceptance.subjectId, occurredAt);
        await unit.recordAudit(
          redactIdentityAuditEvent({
            occurredAt,
            action: 'login.succeeded',
            subjectId: acceptance.subjectId,
            attributes: { event: 'invitation.accepted', invitationId: invitation.id }
          })
        );
        return decision;
      });
    },
    async deprovision(organizationId: string, subjectId: string) {
      const occurredAt = now();
      return repository.transaction(async (unit) => {
        await unit.revokeMemberships(organizationId, subjectId, occurredAt);
        await unit.revokeSessions(organizationId, subjectId, occurredAt);
        await unit.recordAudit(
          redactIdentityAuditEvent({
            occurredAt,
            action: 'scim.deprovisioned',
            subjectId,
            attributes: { organizationId }
          })
        );
      });
    },
    async recoverBreakGlass(request: BreakGlassRecoveryRequest, actorId: string) {
      const occurredAt = now();
      return repository.transaction(async (unit) => {
        const auditEvent = createBreakGlassRecoveryAuditEvent(request, actorId, occurredAt);
        // This is intentionally not a membership upsert: the temporary grant is
        // evaluated directly from its expiry-bound recovery record.
        await unit.recordBreakGlassRecovery(request, actorId);
        await unit.recordAudit(auditEvent);
      });
    }
  };
}

function normalizeEmail(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at !== normalized.indexOf('@') || at === normalized.length - 1) return undefined;
  return normalized;
}

function emailDomain(value: string): string | undefined {
  const normalized = normalizeEmail(value);
  if (normalized === undefined) return undefined;
  const domain = normalized.slice(normalized.lastIndexOf('@') + 1);
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    domain
  )
    ? domain
    : undefined;
}

function isFuture(value: string, now: string): boolean {
  const time = new Date(value).getTime();
  const current = new Date(now).getTime();
  return Number.isFinite(time) && Number.isFinite(current) && time > current;
}
