import * as oidc from 'openid-client';

/**
 * Hosted OIDC runtime. All PKCE randomness, token validation, signature
 * checks, discovery, and JWKS cache/rotation behaviour are delegated to
 * openid-client; this module never implements cryptography or JWT parsing.
 */
export const hostedIdentityRuntime = 'selene-hosted-identity/v1' as const;

const MAX_URL_LENGTH = 2_048;
const MAX_CONFIG_STRING_LENGTH = 4_096;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TOKEN_LENGTH = 16_384;
const MAX_SUBJECT_LENGTH = 512;
const MAX_SCOPES = 32;
const MAX_RETURN_TO_LENGTH = 2_048;
const MAX_COOKIE_HEADER_LENGTH = 8_192;
const MAX_COOKIE_AGE_SECONDS = 86_400;
const MAX_TRANSACTION_TTL_MS = 15 * 60_000;
const MAX_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_IN_MEMORY_RECORDS = 10_000;
const MAX_DATA_PROPERTIES = 64;
const MAX_HOSTED_CALL_DURATION_MS = 60_000;

export type HostedIdentityErrorCode =
  | 'INVALID_PROVIDER_CONFIG'
  | 'INVALID_REDIRECT'
  | 'INVALID_RETURN_TO'
  | 'INVALID_CALLBACK'
  | 'INVALID_RUNTIME'
  | 'INVALID_SESSION'
  | 'STORE_FAILURE'
  | 'TRANSACTION_EXPIRED'
  | 'TRANSACTION_REPLAYED'
  | 'SESSION_EXPIRED'
  | 'CSRF';

export class HostedIdentityError extends Error {
  constructor(
    readonly code: HostedIdentityErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HostedIdentityError';
  }
}

/** Structural supervisor context; identity stays independent of host implementation packages. */
export interface HostedIdentityCallContext {
  readonly remainingDurationMs: number;
  readonly cancellation: {
    isCancellationRequested(): boolean;
    subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void): () => void;
  };
}

export interface HostedOidcProviderConfig {
  readonly issuer: string;
  /** Exact public issuer hostnames approved by the deployment administrator. */
  readonly allowedIssuerHosts: readonly string[];
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
}

export interface ValidatedHostedOidcProviderConfig {
  readonly issuer: URL;
  readonly allowedIssuerHosts: readonly string[];
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly redirectUri: URL;
  readonly scopes: readonly string[];
}

/** Provider endpoints are administrator-supplied HTTPS URLs, never renderer or request input. */
export function validateHostedOidcProviderConfig(
  input: HostedOidcProviderConfig
): ValidatedHostedOidcProviderConfig {
  return validateOidcProviderConfig(input, (value) => trustedHttpsUrl(value, 'redirect URI'));
}

/** Native clients may use a fixed loopback callback registered with the provider. */
export function validateElectronOidcProviderConfig(
  input: HostedOidcProviderConfig
): ValidatedHostedOidcProviderConfig {
  return validateOidcProviderConfig(input, validateElectronRedirectUri);
}

function validateOidcProviderConfig(
  input: HostedOidcProviderConfig,
  validateRedirect: (value: string) => URL
): ValidatedHostedOidcProviderConfig {
  const value = plainRecord(input, 'OIDC provider config');
  const clientId = boundedString(value.clientId, 'OIDC client ID', 1, 512, invalidProvider);
  const issuer = trustedHttpsUrl(
    boundedString(value.issuer, 'OIDC issuer', 1, MAX_URL_LENGTH, invalidProvider),
    'issuer'
  );
  if (issuer.search || issuer.hash)
    invalidProvider('OIDC issuer must not contain query or fragment');
  const hosts = boundedStringList(
    value.allowedIssuerHosts,
    'OIDC issuer host allowlist',
    1,
    MAX_SCOPES,
    253,
    invalidProvider
  ).map((host) => host.toLowerCase());
  if (hosts.some((host) => !isPublicHostname(host))) {
    invalidProvider('OIDC issuer host allowlist must contain exact public hostnames');
  }
  const allowedIssuerHosts = uniqueFrozen(hosts);
  if (!allowedIssuerHosts.includes(issuer.hostname.toLowerCase())) {
    invalidProvider('OIDC issuer host is not in the explicit allowlist');
  }
  const redirectUri = validateRedirect(
    boundedString(value.redirectUri, 'OIDC redirect URI', 1, MAX_URL_LENGTH, invalidProvider)
  );
  if (redirectUri.search || redirectUri.hash)
    invalidProvider('OIDC redirect URI must not contain query or fragment');
  const rawScopes = value.scopes === undefined ? ['openid', 'profile', 'email'] : value.scopes;
  const scopes = uniqueFrozen(
    boundedStringList(rawScopes, 'OIDC scopes', 1, MAX_SCOPES, 128, invalidProvider)
  );
  if (
    !scopes.includes('openid') ||
    scopes.some((scope) => !/^[A-Za-z0-9:._-]{1,128}$/.test(scope))
  ) {
    invalidProvider('OIDC scopes must be bounded valid values and include openid');
  }
  const secret = value.clientSecret;
  const clientSecret =
    secret === undefined
      ? undefined
      : boundedString(secret, 'OIDC client secret', 1, MAX_CONFIG_STRING_LENGTH, invalidProvider);
  return Object.freeze({
    issuer: copyUrl(issuer),
    allowedIssuerHosts,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri: copyUrl(redirectUri),
    scopes
  });
}

/** Loopback callback targets are for native apps only; hosted BFF redirects must be HTTPS. */
export function validateElectronRedirectUri(value: string): URL {
  const url = parseUrl(value, 'Electron redirect URI', 'INVALID_REDIRECT');
  if (url.username || url.password || url.search || url.hash) {
    invalidRedirect('Electron redirect URI has unsafe components');
  }
  const loopback =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (loopback && !url.port)
    invalidRedirect('Electron loopback redirect URI must use an explicit registered port');
  if (!loopback && url.protocol !== 'https:')
    invalidRedirect('Electron redirect must be loopback HTTP or claimed HTTPS');
  if (!loopback && isLocalOrIpHostname(url.hostname))
    invalidRedirect('Electron claimed HTTPS redirect must use a public host');
  return copyUrl(url);
}

function trustedHttpsUrl(value: string, label: string): URL {
  const url = parseUrl(value, `OIDC ${label}`, 'INVALID_PROVIDER_CONFIG');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    isLocalOrIpHostname(url.hostname)
  ) {
    invalidProvider(`OIDC ${label} must be a public HTTPS URL`);
  }
  return url;
}

function parseUrl(value: unknown, label: string, code: HostedIdentityErrorCode): URL {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_URL_LENGTH ||
    containsAsciiControl(value)
  ) {
    throw new HostedIdentityError(code, `${label} is invalid`);
  }
  try {
    return new URL(value);
  } catch {
    throw new HostedIdentityError(code, `${label} is invalid`);
  }
}

function copyUrl(value: URL): URL {
  return new URL(value.href);
}

function isLocalOrIpHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(normalized) ||
    normalized.includes(':')
  );
}

function isPublicHostname(hostname: string): boolean {
  return (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      hostname
    ) && !isLocalOrIpHostname(hostname)
  );
}

function validatedIssuerHosts(value: unknown, label: string): readonly string[] {
  const hosts = boundedStringList(value, label, 1, MAX_SCOPES, 253, invalidProvider).map((host) =>
    host.toLowerCase()
  );
  if (hosts.some((host) => !isPublicHostname(host))) invalidProvider(`${label} is invalid`);
  return uniqueFrozen(hosts);
}

function invalidProvider(message: string): never {
  throw new HostedIdentityError('INVALID_PROVIDER_CONFIG', message);
}

function invalidRedirect(message: string): never {
  throw new HostedIdentityError('INVALID_REDIRECT', message);
}

export interface OidcClaims {
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
}

export interface OidcTokenSet {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly idToken?: string;
  readonly claims: OidcClaims;
  /** Issuer-qualified stable subject; prevents collisions across identity providers. */
  readonly subjectKey: string;
  readonly expiresAt: number;
}

export interface OidcAuthorizationTransaction {
  readonly id: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly expiresAt: number;
}

export interface OidcRuntime {
  begin(input: {
    readonly redirectUri: URL;
    readonly scopes: readonly string[];
    /** Supervisor-owned lifetime for the complete host request. */
    readonly context?: HostedIdentityCallContext;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly authorizationUrl: URL;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }>;
  exchange(input: {
    readonly callback: URL;
    readonly transaction: OidcAuthorizationTransaction;
    readonly context?: HostedIdentityCallContext;
    readonly signal?: AbortSignal;
  }): Promise<OidcTokenSet>;
  revoke(
    token: string,
    hint: 'access_token' | 'refresh_token',
    context?: HostedIdentityCallContext,
    signal?: AbortSignal
  ): Promise<void>;
  endSession(input: {
    readonly idToken?: string;
    readonly postLogoutRedirectUri: URL;
    readonly context?: HostedIdentityCallContext;
    readonly signal?: AbortSignal;
  }): Promise<URL | undefined>;
}

/** Construct the maintained-library adapter; openid-client owns crypto and JWT verification. */
export interface OpenIdClientRuntimeOptions {
  /**
   * Host-owned HTTPS transport. It receives verified DNS answers and must use
   * one of those exact addresses for the TLS connection while preserving the
   * original hostname for SNI and certificate verification.
   */
  readonly transport: OidcAddressPinnedTransport;
}

export function createOpenIdClientRuntime(
  input: HostedOidcProviderConfig,
  options: OpenIdClientRuntimeOptions
): OidcRuntime {
  return createOpenIdRuntime(validateHostedOidcProviderConfig(input), captureTransport(options));
}

export function createElectronOpenIdClientRuntime(
  input: HostedOidcProviderConfig,
  options: OpenIdClientRuntimeOptions
): OidcRuntime {
  return createOpenIdRuntime(validateElectronOidcProviderConfig(input), captureTransport(options));
}

function createOpenIdRuntime(
  provider: ValidatedHostedOidcProviderConfig,
  transport: OidcAddressPinnedTransport
): OidcRuntime {
  const configuration = (context?: HostedIdentityCallContext, signal?: AbortSignal) =>
    oidc.discovery(
      provider.issuer,
      provider.clientId,
      provider.clientSecret,
      provider.clientSecret ? oidc.ClientSecretBasic(provider.clientSecret) : oidc.None(),
      {
        [oidc.customFetch]: createOidcSsrfSafeFetch(
          provider.allowedIssuerHosts,
          transport,
          context,
          signal
        ) as never
      }
    );
  const runtime: OidcRuntime = {
    async begin({
      redirectUri,
      scopes,
      context,
      signal
    }: {
      readonly redirectUri: URL;
      readonly scopes: readonly string[];
      readonly context?: HostedIdentityCallContext;
      readonly signal?: AbortSignal;
    }) {
      if (!sameUrl(redirectUri, provider.redirectUri) || !sameValues(scopes, provider.scopes)) {
        throw new HostedIdentityError(
          'INVALID_REDIRECT',
          'OIDC redirect URI or scopes are not configured'
        );
      }
      try {
        const codeVerifier = oidc.randomPKCECodeVerifier();
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const authorizationUrl = oidc.buildAuthorizationUrl(await configuration(context, signal), {
          redirect_uri: provider.redirectUri.href,
          response_type: 'code',
          scope: provider.scopes.join(' '),
          code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
          code_challenge_method: 'S256',
          state,
          nonce
        });
        return freezeBeginResult({ authorizationUrl, state, nonce, codeVerifier }, provider);
      } catch {
        throw new HostedIdentityError(
          'INVALID_RUNTIME',
          'OIDC authorization initialization failed'
        );
      }
    },
    async exchange({
      callback,
      transaction,
      context,
      signal
    }: {
      readonly callback: URL;
      readonly transaction: OidcAuthorizationTransaction;
      readonly context?: HostedIdentityCallContext;
      readonly signal?: AbortSignal;
    }) {
      try {
        const tokens = await oidc.authorizationCodeGrant(
          await configuration(context, signal),
          callback,
          {
            pkceCodeVerifier: transaction.codeVerifier,
            expectedState: transaction.state,
            expectedNonce: transaction.nonce,
            idTokenExpected: true
          }
        );
        const claims = tokens.claims();
        const sub = boundedString(
          claims?.sub,
          'OIDC subject',
          1,
          MAX_SUBJECT_LENGTH,
          invalidCallback
        );
        const expiresIn = tokens.expires_in;
        if (
          !isFiniteInteger(expiresIn) ||
          expiresIn < 1 ||
          expiresIn * 1_000 > MAX_TOKEN_LIFETIME_MS
        ) {
          invalidCallback('OIDC token expiry is invalid');
        }
        const now = Date.now();
        return freezeTokenSet(
          {
            ...optionalToken(tokens.access_token, 'access token'),
            ...optionalToken(tokens.refresh_token, 'refresh token'),
            ...optionalToken(tokens.id_token, 'ID token'),
            claims: {
              sub,
              ...optionalClaim(claims?.email, 'email'),
              ...optionalClaim(claims?.name, 'name')
            },
            subjectKey: `${provider.issuer.href}|${sub}`,
            expiresAt: validFutureExpiry(now + expiresIn * 1_000, now, 'OIDC token')
          },
          now,
          provider.allowedIssuerHosts
        );
      } catch {
        throw new HostedIdentityError('INVALID_CALLBACK', 'OIDC token exchange failed');
      }
    },
    async revoke(token: string, hint: 'access_token' | 'refresh_token', context, signal) {
      try {
        await oidc.tokenRevocation(
          await configuration(context, signal),
          boundedToken(token, 'token'),
          {
            token_type_hint: hint
          }
        );
      } catch {
        throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC token revocation failed');
      }
    },
    async endSession({
      idToken,
      postLogoutRedirectUri,
      context,
      signal
    }: {
      readonly idToken?: string;
      readonly postLogoutRedirectUri: URL;
      readonly context?: HostedIdentityCallContext;
      readonly signal?: AbortSignal;
    }) {
      if (!sameUrl(postLogoutRedirectUri, provider.redirectUri)) {
        throw new HostedIdentityError(
          'INVALID_REDIRECT',
          'OIDC post-logout redirect is not configured'
        );
      }
      try {
        const config = await configuration(context, signal);
        const endpoint = config.serverMetadata().end_session_endpoint;
        if (!endpoint) return undefined;
        assertProviderUrl(endpoint, provider.allowedIssuerHosts, 'OIDC end-session endpoint');
        const result = oidc.buildEndSessionUrl(config, {
          ...(idToken ? { id_token_hint: boundedToken(idToken, 'ID token') } : {}),
          post_logout_redirect_uri: provider.redirectUri.href
        });
        assertProviderUrl(result.href, provider.allowedIssuerHosts, 'OIDC end-session URL');
        return copyUrl(result);
      } catch {
        throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC logout initialization failed');
      }
    }
  };
  return Object.freeze(runtime);
}

/** Blocks discovery, JWKS, token, and revocation requests outside configured public provider hosts. */
export function createOidcSsrfSafeFetch(
  allowedIssuerHosts: readonly string[],
  transport: OidcAddressPinnedTransport,
  context?: HostedIdentityCallContext,
  inheritedSignal?: AbortSignal
): OidcFetch {
  const hosts = uniqueFrozen(
    boundedStringList(
      allowedIssuerHosts,
      'OIDC issuer host allowlist',
      1,
      MAX_SCOPES,
      253,
      invalidProvider
    ).map((host) => host.toLowerCase())
  );
  if (hosts.some((host) => !isPublicHostname(host)))
    invalidProvider('OIDC issuer host allowlist is invalid');
  const safeTransport = captureTransport({ transport });
  const allowed = new Set(hosts);
  return async (input, init) => {
    let target: URL;
    try {
      target = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input
      );
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC provider request failed');
    }
    if (
      target.protocol !== 'https:' ||
      target.port ||
      !allowed.has(target.hostname.toLowerCase()) ||
      isLocalOrIpHostname(target.hostname)
    ) {
      throw new HostedIdentityError(
        'INVALID_PROVIDER_CONFIG',
        'OIDC HTTP target violates issuer allowlist policy'
      );
    }
    let rawAddresses: unknown;
    try {
      rawAddresses = await boundedAdapterCall(
        (signal) => safeTransport.resolve(target.hostname, signal),
        context,
        inheritedSignal
      );
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC provider DNS lookup failed');
    }
    const addresses = validatedResolvedAddresses(rawAddresses);
    let request: Request;
    try {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      );
      for (const name of [
        'cookie',
        'proxy-authorization',
        'x-forwarded-for',
        'x-forwarded-host',
        'host',
        'connection',
        'transfer-encoding',
        'upgrade'
      ])
        headers.delete(name);
      request = new Request(input instanceof Request ? input : target.href, {
        ...init,
        headers,
        redirect: 'error'
      });
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC provider request failed');
    }
    try {
      const response = await boundedAdapterCall(
        (signal) => safeTransport.fetch(request, addresses, signal),
        context,
        inheritedSignal
      );
      if (!(response instanceof Response)) throw new Error();
      return response;
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC provider request failed');
    }
  };
}

export type OidcFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface OidcAddressPinnedTransport {
  resolve(hostname: string, signal?: AbortSignal): Promise<readonly string[]>;
  fetch(request: Request, addresses: readonly string[], signal?: AbortSignal): Promise<Response>;
}

export function assertPublicOidcAddress(address: string): void {
  if (isPrivateAddress(address)) {
    throw new HostedIdentityError(
      'INVALID_PROVIDER_CONFIG',
      'OIDC provider DNS target is not public'
    );
  }
}

function validatedResolvedAddresses(value: unknown): readonly string[] {
  const addresses = boundedStringList(
    value,
    'OIDC provider DNS answers',
    1,
    MAX_SCOPES,
    253,
    invalidProvider
  );
  for (const address of addresses) assertPublicOidcAddress(address);
  return uniqueFrozen(addresses);
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.includes(':')) {
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('::ffff:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8')
    );
  }
  const octets = normalized.split('.').map(Number);
  const first = octets[0] ?? -1;
  const second = octets[1] ?? -1;
  const third = octets[2] ?? -1;
  return (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
    first === 0 ||
    first === 10 ||
    (first === 100 && second >= 64 && second <= 127) ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168 || second === 2)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

export interface HostedBffSession {
  readonly id: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly tokens: OidcTokenSet;
  /** Bound after the host resolves the verified provider subject to a membership. */
  readonly organizationId?: string;
  /** Must equal the active membership version on every authenticated request. */
  readonly accessVersion?: number;
}

export interface HostedBffSessionAccess {
  readonly organizationId: string;
  readonly accessVersion: number;
}

export interface HostedBffStore {
  createTransaction(transaction: OidcAuthorizationTransaction, signal?: AbortSignal): Promise<void>;
  /** Atomically delete-and-return exactly one unexpired transaction. */
  consumeTransaction(
    id: string,
    signal?: AbortSignal
  ): Promise<OidcAuthorizationTransaction | undefined>;
  createSession(session: HostedBffSession, signal?: AbortSignal): Promise<void>;
  /** Return a detached snapshot; never retain or expose caller-owned references. */
  readSession(id: string, signal?: AbortSignal): Promise<HostedBffSession | undefined>;
  /** Atomically revoke-and-return a session so exactly one logout can use its tokens. */
  consumeSession(id: string, signal?: AbortSignal): Promise<HostedBffSession | undefined>;
  /** Atomically bind an unbound, non-revoked session. False means it was already bound or revoked. */
  bindSessionAccess(
    id: string,
    access: HostedBffSessionAccess,
    signal?: AbortSignal
  ): Promise<boolean>;
  /** Atomically revoke so later reads and binds cannot succeed. */
  revokeSession(id: string, signal?: AbortSignal): Promise<void>;
}

export interface InMemoryHostedBffStoreOptions {
  readonly now?: () => number;
  readonly maxRecords?: number;
}

export function createInMemoryHostedBffStore(
  options: InMemoryHostedBffStoreOptions = {}
): HostedBffStore {
  const transactions = new Map<string, OidcAuthorizationTransaction>();
  const sessions = new Map<string, HostedBffSession>();
  const safeOptions = plainRecord(options, 'OIDC in-memory store options', 'STORE_FAILURE');
  const now = captureClock(safeOptions.now);
  const maxRecords = boundedRecordLimit(safeOptions.maxRecords);
  const purgeExpired = (current: number, preserveTransactions = false) => {
    if (!preserveTransactions) {
      for (const [id, transaction] of transactions) {
        if (transaction.expiresAt <= current) transactions.delete(id);
      }
    }
    for (const [id, session] of sessions) {
      if (session.expiresAt <= current) sessions.delete(id);
    }
  };
  const store: HostedBffStore = {
    async createTransaction(transaction: OidcAuthorizationTransaction, signal?: AbortSignal) {
      throwIfAborted(signal);
      const current = now();
      purgeExpired(current);
      const snapshot = freezeTransaction(transaction);
      if (transactions.size >= maxRecords)
        throw new HostedIdentityError('STORE_FAILURE', 'OIDC transaction store is full');
      if (transactions.has(snapshot.id))
        throw new HostedIdentityError('STORE_FAILURE', 'OIDC transaction already exists');
      transactions.set(snapshot.id, snapshot);
    },
    async consumeTransaction(id: string, signal?: AbortSignal) {
      throwIfAborted(signal);
      purgeExpired(now(), true);
      const safeId = boundedIdentifier(id, 'OIDC transaction ID', 'INVALID_CALLBACK');
      const transaction = transactions.get(safeId);
      transactions.delete(safeId);
      return transaction ? copyTransaction(transaction) : undefined;
    },
    async createSession(session: HostedBffSession, signal?: AbortSignal) {
      throwIfAborted(signal);
      const current = now();
      purgeExpired(current);
      const snapshot = freezeSession(session, current);
      if (sessions.size >= maxRecords)
        throw new HostedIdentityError('STORE_FAILURE', 'OIDC session store is full');
      if (sessions.has(snapshot.id))
        throw new HostedIdentityError('STORE_FAILURE', 'OIDC session already exists');
      sessions.set(snapshot.id, snapshot);
    },
    async readSession(id: string, signal?: AbortSignal) {
      throwIfAborted(signal);
      purgeExpired(now());
      const safeId = boundedIdentifier(id, 'OIDC session ID', 'INVALID_SESSION');
      const session = sessions.get(safeId);
      return session ? copySession(session) : undefined;
    },
    async consumeSession(id: string, signal?: AbortSignal) {
      throwIfAborted(signal);
      purgeExpired(now());
      const safeId = boundedIdentifier(id, 'OIDC session ID', 'INVALID_SESSION');
      const session = sessions.get(safeId);
      sessions.delete(safeId);
      return session ? copySession(session) : undefined;
    },
    async bindSessionAccess(id: string, access: HostedBffSessionAccess, signal?: AbortSignal) {
      throwIfAborted(signal);
      const current = now();
      purgeExpired(current);
      const safeId = boundedIdentifier(id, 'OIDC session ID', 'INVALID_SESSION');
      const safeAccess = freezeAccess(access);
      const session = sessions.get(safeId);
      if (!session || session.organizationId !== undefined || session.accessVersion !== undefined)
        return false;
      sessions.set(safeId, freezeSession({ ...session, ...safeAccess }, current));
      return true;
    },
    async revokeSession(id: string, signal?: AbortSignal) {
      throwIfAborted(signal);
      sessions.delete(boundedIdentifier(id, 'OIDC session ID', 'INVALID_SESSION'));
    }
  };
  return Object.freeze(store);
}

export interface HostedOidcBffOptions {
  readonly effects: HostedOidcBffEffects;
  /** Exact configured issuer URL, including any approved path component. */
  readonly issuer: string;
  /** Exact public IdP hosts permitted for authorization, logout, and subject keys. */
  readonly allowedIssuerHosts: readonly string[];
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly transactionTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
}

/** Explicit factory binding each BFF operation to one host-supervised call context. */
export interface HostedOidcBffEffects {
  forContext(context: HostedIdentityCallContext): {
    readonly runtime: OidcRuntime;
    readonly store: HostedBffStore;
  };
}

/** Explicit compatibility adapter for tests and non-hosted embeddings. */
export function createDirectHostedOidcBffEffects(
  runtime: OidcRuntime,
  store: HostedBffStore
): HostedOidcBffEffects {
  return Object.freeze({ forContext: () => Object.freeze({ runtime, store }) });
}

export class HostedOidcBff {
  private readonly effects: HostedOidcBffEffects;
  private readonly issuer: URL;
  private readonly allowedIssuerHosts: readonly string[];
  private readonly redirectUri: URL;
  private readonly scopes: readonly string[];
  private readonly transactionTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private lastTime = -1;

  constructor(input: HostedOidcBffOptions) {
    const options = plainRecord(input, 'OIDC BFF options');
    this.effects = captureEffects(options.effects);
    this.allowedIssuerHosts = validatedIssuerHosts(
      options.allowedIssuerHosts,
      'OIDC BFF issuer host allowlist'
    );
    this.issuer = trustedHttpsUrl(
      boundedString(options.issuer, 'OIDC issuer', 1, MAX_URL_LENGTH, invalidProvider),
      'issuer'
    );
    if (
      this.issuer.search ||
      this.issuer.hash ||
      !this.allowedIssuerHosts.includes(this.issuer.hostname.toLowerCase())
    ) {
      invalidProvider('OIDC issuer is not in the explicit allowlist');
    }
    this.redirectUri = trustedHttpsUrl(
      boundedString(options.redirectUri, 'OIDC redirect URI', 1, MAX_URL_LENGTH, invalidProvider),
      'redirect URI'
    );
    this.scopes = uniqueFrozen(
      boundedStringList(
        options.scopes ?? ['openid', 'profile', 'email'],
        'OIDC scopes',
        1,
        MAX_SCOPES,
        128,
        invalidProvider
      )
    );
    if (
      !this.scopes.includes('openid') ||
      this.scopes.some((scope) => !/^[A-Za-z0-9:._-]{1,128}$/.test(scope))
    )
      invalidProvider('OIDC scopes are invalid');
    this.transactionTtlMs = boundedTtl(
      options.transactionTtlMs,
      5 * 60_000,
      MAX_TRANSACTION_TTL_MS,
      'transaction'
    );
    this.sessionTtlMs = boundedTtl(
      options.sessionTtlMs,
      8 * 60 * 60_000,
      MAX_SESSION_TTL_MS,
      'session'
    );
    if (options.now !== undefined && typeof options.now !== 'function')
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC clock is invalid');
    this.now = (options.now as (() => number) | undefined) ?? Date.now;
    this.currentTime();
  }

  async begin(
    context: HostedIdentityCallContext,
    returnTo?: string
  ): Promise<{ readonly authorizationUrl: URL; readonly transactionId: string }> {
    const safeContext = captureHostedIdentityCallContext(context);
    const { runtime, store } = this.forContext(safeContext);
    const now = this.currentTime();
    const safeReturnTo = validateReturnTo(returnTo);
    const prepared = await this.runtimeCall(safeContext, 'begin', (signal) =>
      runtime.begin({
        redirectUri: copyUrl(this.redirectUri),
        scopes: [...this.scopes],
        context: safeContext,
        signal
      })
    );
    const result = this.runtimeResult('begin result', () =>
      freezeBeginResult(prepared, { allowedIssuerHosts: this.allowedIssuerHosts })
    );
    const transaction = freezeTransaction({
      id: result.state,
      state: result.state,
      nonce: result.nonce,
      codeVerifier: result.codeVerifier,
      redirectUri: this.redirectUri.href,
      returnTo: safeReturnTo,
      expiresAt: validFutureExpiry(now + this.transactionTtlMs, now, 'OIDC transaction')
    });
    await this.storeVoid(safeContext, 'create transaction', (signal) =>
      store.createTransaction(transaction, signal)
    );
    return Object.freeze({
      authorizationUrl: copyUrl(result.authorizationUrl),
      transactionId: transaction.id
    });
  }

  async complete(
    context: HostedIdentityCallContext,
    callback: URL,
    transactionId: string
  ): Promise<{ readonly session: HostedBffSession; readonly returnTo: string }> {
    const safeContext = captureHostedIdentityCallContext(context);
    const { runtime, store } = this.forContext(safeContext);
    const safeId = boundedIdentifier(transactionId, 'OIDC transaction ID', 'INVALID_CALLBACK');
    const transaction = await this.storeCall(safeContext, 'consume transaction', (signal) =>
      store.consumeTransaction(safeId, signal)
    );
    if (!transaction)
      throw new HostedIdentityError(
        'TRANSACTION_REPLAYED',
        'OIDC transaction was already used or unknown'
      );
    const safeCallback = validateCallback(callback, this.redirectUri);
    const safeTransaction = this.storeResult('transaction', () => freezeTransaction(transaction));
    const now = this.currentTime();
    if (
      safeTransaction.id !== safeId ||
      safeTransaction.state !== safeId ||
      !sameUrl(
        parseUrl(safeTransaction.redirectUri, 'OIDC transaction redirect URI', 'INVALID_CALLBACK'),
        this.redirectUri
      )
    ) {
      throw new HostedIdentityError('INVALID_CALLBACK', 'OIDC transaction is invalid');
    }
    if (safeTransaction.expiresAt <= now)
      throw new HostedIdentityError('TRANSACTION_EXPIRED', 'OIDC transaction expired');
    const exchanged = await this.runtimeCall(safeContext, 'exchange', (signal) =>
      runtime.exchange({
        callback: copyUrl(safeCallback),
        transaction: copyTransaction(safeTransaction),
        context: safeContext,
        signal
      })
    );
    const tokens = this.runtimeResult('exchange result', () =>
      freezeTokenSet(exchanged, now, this.allowedIssuerHosts, this.issuer)
    );
    const session = freezeSession(
      {
        // Deliberately independent from transaction ID so a callback cannot fixate a session.
        id: boundedIdentifier(oidc.randomState(), 'OIDC session ID', 'INVALID_RUNTIME'),
        subject: tokens.subjectKey,
        expiresAt: validFutureExpiry(
          Math.min(tokens.expiresAt, now + this.sessionTtlMs),
          now,
          'OIDC session'
        ),
        tokens
      },
      now,
      this.allowedIssuerHosts,
      this.issuer
    );
    await this.storeVoid(safeContext, 'create session', (signal) =>
      store.createSession(session, signal)
    );
    return Object.freeze({ session: copySession(session), returnTo: safeTransaction.returnTo });
  }

  async authenticate(
    context: HostedIdentityCallContext,
    sessionId: string
  ): Promise<HostedBffSession | undefined> {
    const safeContext = captureHostedIdentityCallContext(context);
    const { store } = this.forContext(safeContext);
    const safeId = boundedIdentifier(sessionId, 'OIDC session ID', 'INVALID_SESSION');
    const session = await this.storeCall(safeContext, 'read session', (signal) =>
      store.readSession(safeId, signal)
    );
    if (!session) return undefined;
    const now = this.currentTime();
    const safeSession = this.storeResult('session', () =>
      freezeSession(session, now, this.allowedIssuerHosts, this.issuer)
    );
    if (safeSession.id !== safeId || safeSession.expiresAt <= now) {
      await this.storeVoid(safeContext, 'revoke expired session', (signal) =>
        store.revokeSession(safeId, signal)
      );
      return undefined;
    }
    return copySession(safeSession);
  }

  /** Persist the organization membership selected by the host before using it on later requests. */
  async bindSessionAccess(
    context: HostedIdentityCallContext,
    sessionId: string,
    access: HostedBffSessionAccess
  ): Promise<boolean> {
    const safeContext = captureHostedIdentityCallContext(context);
    const { store } = this.forContext(safeContext);
    return this.storeBoolean(safeContext, 'bind session access', (signal) =>
      store.bindSessionAccess(
        boundedIdentifier(sessionId, 'OIDC session ID', 'INVALID_SESSION'),
        freezeAccess(access),
        signal
      )
    );
  }

  /** Denies a stale or ambiguous binding without requiring an IdP logout round trip. */
  async revokeSession(context: HostedIdentityCallContext, sessionId: string): Promise<void> {
    const safeContext = captureHostedIdentityCallContext(context);
    const { store } = this.forContext(safeContext);
    await this.storeVoid(safeContext, 'revoke session', (signal) =>
      store.revokeSession(
        boundedIdentifier(sessionId, 'OIDC session ID', 'INVALID_SESSION'),
        signal
      )
    );
  }

  async logout(context: HostedIdentityCallContext, sessionId: string): Promise<URL | undefined> {
    const safeContext = captureHostedIdentityCallContext(context);
    const { runtime, store } = this.forContext(safeContext);
    const safeId = boundedIdentifier(sessionId, 'OIDC session ID', 'INVALID_SESSION');
    const session = await this.storeCall(safeContext, 'consume session', (signal) =>
      store.consumeSession(safeId, signal)
    );
    if (!session) return undefined;
    const now = this.currentTime();
    const safeSession = this.storeResult('logout session', () =>
      freezeSession(session, now, this.allowedIssuerHosts, this.issuer)
    );
    if (safeSession.expiresAt <= now) return undefined;
    await Promise.allSettled([
      ...(safeSession.tokens.refreshToken
        ? [
            this.runtimeCall(safeContext, 'revoke refresh token', (signal) =>
              runtime.revoke(safeSession.tokens.refreshToken!, 'refresh_token', safeContext, signal)
            )
          ]
        : []),
      ...(safeSession.tokens.accessToken
        ? [
            this.runtimeCall(safeContext, 'revoke access token', (signal) =>
              runtime.revoke(safeSession.tokens.accessToken!, 'access_token', safeContext, signal)
            )
          ]
        : [])
    ]);
    const result = await this.runtimeCall(safeContext, 'end session', (signal) =>
      runtime.endSession({
        ...(safeSession.tokens.idToken ? { idToken: safeSession.tokens.idToken } : {}),
        postLogoutRedirectUri: copyUrl(this.redirectUri),
        context: safeContext,
        signal
      })
    );
    return result === undefined
      ? undefined
      : copyUrl(
          this.runtimeResult('end-session result', () =>
            validateProviderRuntimeUrl(result, 'OIDC end-session URL', this.allowedIssuerHosts)
          )
        );
  }

  cookieMaxAgeSeconds(session: HostedBffSession): number {
    const now = this.currentTime();
    const snapshot = freezeSession(session, now, this.allowedIssuerHosts, this.issuer);
    return Math.max(
      1,
      Math.min(MAX_COOKIE_AGE_SECONDS, Math.floor((snapshot.expiresAt - now) / 1_000))
    );
  }

  transactionCookieMaxAgeSeconds(): number {
    return Math.max(1, Math.min(MAX_COOKIE_AGE_SECONDS, Math.floor(this.transactionTtlMs / 1_000)));
  }

  private forContext(context: HostedIdentityCallContext): {
    readonly runtime: OidcRuntime;
    readonly store: HostedBffStore;
  } {
    try {
      return captureEffectsResult(this.effects.forContext(context));
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC host effects are invalid');
    }
  }

  private currentTime(): number {
    let value: unknown;
    try {
      value = this.now();
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC clock failed');
    }
    if (!isFiniteInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC clock is invalid');
    }
    if (value < this.lastTime)
      throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC clock moved backwards');
    this.lastTime = value;
    return value;
  }

  private async runtimeCall<T>(
    context: HostedIdentityCallContext | undefined,
    operation: string,
    action: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    try {
      return await boundedAdapterCall(action, context);
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', `OIDC runtime ${operation} failed`);
    }
  }

  private async storeCall<T>(
    context: HostedIdentityCallContext | undefined,
    operation: string,
    action: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    try {
      return await boundedAdapterCall(action, context);
    } catch {
      throw new HostedIdentityError('STORE_FAILURE', `OIDC store ${operation} failed`);
    }
  }

  private async storeVoid(
    context: HostedIdentityCallContext | undefined,
    operation: string,
    action: (signal: AbortSignal) => Promise<unknown>
  ): Promise<void> {
    const result = await this.storeCall(context, operation, action);
    this.storeResult(`${operation} result`, () => {
      if (result !== undefined) throw new Error();
    });
  }

  private async storeBoolean(
    context: HostedIdentityCallContext | undefined,
    operation: string,
    action: (signal: AbortSignal) => Promise<unknown>
  ): Promise<boolean> {
    const result = await this.storeCall(context, operation, action);
    return this.storeResult(`${operation} result`, () => {
      if (typeof result !== 'boolean') throw new Error();
      return result;
    });
  }

  private runtimeResult<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch {
      throw new HostedIdentityError('INVALID_RUNTIME', `OIDC runtime ${operation} is invalid`);
    }
  }

  private storeResult<T>(operation: string, action: () => T): T {
    try {
      return action();
    } catch {
      throw new HostedIdentityError('STORE_FAILURE', `OIDC store ${operation} is invalid`);
    }
  }
}

export function validateReturnTo(value: string | undefined): string {
  if (value === undefined || value === '') return '/';
  if (
    typeof value !== 'string' ||
    value.length > MAX_RETURN_TO_LENGTH ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    containsAsciiControl(value)
  ) {
    throw new HostedIdentityError(
      'INVALID_RETURN_TO',
      'Return target must be a safe relative path'
    );
  }
  if (/%(?:2f|5c)/i.test(value)) {
    throw new HostedIdentityError(
      'INVALID_RETURN_TO',
      'Return target must not contain encoded separators'
    );
  }
  // `new URL` needs a base for relative routes; avoid accepting a URL-like value above.
  const normalized = new URL(value, 'https://selene.invalid');
  if (normalized.origin !== 'https://selene.invalid')
    throw new HostedIdentityError('INVALID_RETURN_TO', 'Return target must be same-origin');
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
}

export function serializeBffCookie(
  name: '__Host-selene_session' | '__Host-selene_oidc_tx',
  value: string,
  maxAgeSeconds: number
): string {
  if (name !== '__Host-selene_session' && name !== '__Host-selene_oidc_tx')
    throw new HostedIdentityError('INVALID_CALLBACK', 'BFF cookie name is invalid');
  const identifier = boundedIdentifier(value, 'BFF cookie identifier', 'INVALID_CALLBACK');
  if (
    !Number.isFinite(maxAgeSeconds) ||
    !Number.isInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > MAX_COOKIE_AGE_SECONDS
  ) {
    throw new HostedIdentityError('INVALID_CALLBACK', 'BFF cookie lifetime is invalid');
  }
  return `${name}=${identifier}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function parseBffCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  if (
    (name !== '__Host-selene_session' && name !== '__Host-selene_oidc_tx') ||
    typeof header !== 'string' ||
    header.length > MAX_COOKIE_HEADER_LENGTH ||
    containsAsciiControl(header)
  )
    return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]?.slice(name.length + 1);
  try {
    return value
      ? boundedIdentifier(value, 'BFF cookie identifier', 'INVALID_CALLBACK')
      : undefined;
  } catch {
    return undefined;
  }
}

/** Logout is a state-changing browser request and therefore requires exact same-origin POST. */
export function assertSameOriginPost(request: Request, applicationOrigin: string): void {
  try {
    const origin = trustedHttpsUrl(applicationOrigin, 'application origin');
    if (
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      request.method !== 'POST' ||
      request.headers.get('origin') !== origin.origin
    ) {
      throw new Error();
    }
  } catch {
    throw new HostedIdentityError('CSRF', 'State-changing BFF requests require a same-origin POST');
  }
}

function plainRecord(
  value: unknown,
  label: string,
  code: HostedIdentityErrorCode = 'INVALID_PROVIDER_CONFIG'
): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object') throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_DATA_PROPERTIES || keys.some((key) => typeof key !== 'string'))
      throw new Error();
    const descriptors = Object.fromEntries(
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(value, key)!])
    ) as PropertyDescriptorMap;
    if (
      Object.prototype.hasOwnProperty.call(descriptors, 'length') ||
      Object.prototype.hasOwnProperty.call(descriptors, 'constructor')
    )
      throw new Error();
    if (Object.values(descriptors).some((descriptor) => 'get' in descriptor || 'set' in descriptor))
      throw new Error();
    return Object.freeze(
      Object.fromEntries(
        Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
      )
    );
  } catch {
    throw new HostedIdentityError(code, `${label} must be a plain data object`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  min: number,
  max: number,
  fail: (message: string) => never
): string {
  if (
    typeof value !== 'string' ||
    value.length < min ||
    value.length > max ||
    containsAsciiControl(value)
  )
    fail(`${label} is invalid`);
  return value;
}

function boundedStringList(
  value: unknown,
  label: string,
  min: number,
  max: number,
  itemMax: number,
  fail: (message: string) => never
): string[] {
  try {
    if (!Array.isArray(value)) fail(`${label} is invalid`);
    if (Object.getPrototypeOf(value) !== Array.prototype) fail(`${label} is invalid`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length =
      lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (!isFiniteInteger(length) || length < min || length > max) fail(`${label} is invalid`);
    const output: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) fail(`${label} is invalid`);
      output.push(boundedString(descriptor.value, label, 1, itemMax, fail));
    }
    const keys = Reflect.ownKeys(value);
    const expected = new Set(['length', ...output.map((_, index) => String(index))]);
    if (
      keys.length !== expected.size ||
      keys.some((key) => typeof key !== 'string' || !expected.has(key))
    )
      fail(`${label} is invalid`);
    if (new Set(output).size !== output.length) fail(`${label} must not contain duplicates`);
    return output;
  } catch {
    fail(`${label} is invalid`);
  }
}

function uniqueFrozen(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function boundedIdentifier(value: unknown, label: string, code: HostedIdentityErrorCode): string {
  if (
    typeof value !== 'string' ||
    value.length < 20 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  )
    throw new HostedIdentityError(code, `${label} is malformed`);
  return value;
}

function boundedToken(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_TOKEN_LENGTH ||
    containsAsciiControl(value)
  )
    throw new HostedIdentityError('INVALID_CALLBACK', `${label} is invalid`);
  return value;
}

function optionalToken(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  const token = boundedToken(value, label);
  return label === 'access token'
    ? { accessToken: token }
    : label === 'refresh token'
      ? { refreshToken: token }
      : { idToken: token };
}

function optionalClaim(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  return { [label]: boundedString(value, `OIDC ${label}`, 1, MAX_SUBJECT_LENGTH, invalidCallback) };
}

function invalidCallback(message: string): never {
  throw new HostedIdentityError('INVALID_CALLBACK', message);
}

function boundedTtl(value: unknown, fallback: number, max: number, label: string): number {
  const ttl = value === undefined ? fallback : value;
  if (!isFiniteInteger(ttl) || ttl < 1 || ttl > max)
    throw new HostedIdentityError('INVALID_PROVIDER_CONFIG', `OIDC ${label} TTL is invalid`);
  return ttl;
}

function captureClock(value: unknown): () => number {
  const target = { now: value === undefined ? Date.now : value };
  const descriptor = Object.getOwnPropertyDescriptor(target, 'now');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')
    throw new HostedIdentityError('STORE_FAILURE', 'OIDC store clock is invalid');
  const method = descriptor.value as () => unknown;
  let previous = -1;
  return () => {
    let current: unknown;
    try {
      current = Reflect.apply(method, target, []);
    } catch {
      throw new HostedIdentityError('STORE_FAILURE', 'OIDC store clock failed');
    }
    if (!isFiniteInteger(current) || current < 0 || current > 8_640_000_000_000_000)
      throw new HostedIdentityError('STORE_FAILURE', 'OIDC store clock is invalid');
    if (current < previous)
      throw new HostedIdentityError('STORE_FAILURE', 'OIDC store clock moved backwards');
    previous = current;
    return current;
  };
}

function boundedRecordLimit(value: unknown): number {
  const limit = value === undefined ? MAX_IN_MEMORY_RECORDS : value;
  if (!isFiniteInteger(limit) || limit < 1 || limit > MAX_IN_MEMORY_RECORDS) {
    throw new HostedIdentityError('STORE_FAILURE', 'OIDC store record limit is invalid');
  }
  return limit;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('OIDC adapter aborted');
}

function validFutureExpiry(value: unknown, now: number, label: string): number {
  if (!isFiniteInteger(value) || value <= now || value - now > MAX_TOKEN_LIFETIME_MS)
    throw new HostedIdentityError('INVALID_CALLBACK', `${label} expiry is invalid`);
  return value;
}

function freezeBeginResult(
  value: unknown,
  provider?: Pick<ValidatedHostedOidcProviderConfig, 'allowedIssuerHosts'>
): {
  readonly authorizationUrl: URL;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
} {
  const result = plainRecord(value, 'OIDC runtime result');
  const authorizationUrl = validateProviderRuntimeUrl(
    result.authorizationUrl,
    'OIDC authorization URL',
    provider?.allowedIssuerHosts
  );
  return Object.freeze({
    authorizationUrl,
    state: boundedIdentifier(result.state, 'OIDC state', 'INVALID_RUNTIME'),
    nonce: boundedIdentifier(result.nonce, 'OIDC nonce', 'INVALID_RUNTIME'),
    codeVerifier: boundedIdentifier(result.codeVerifier, 'OIDC code verifier', 'INVALID_RUNTIME')
  });
}

function validateProviderRuntimeUrl(value: unknown, label: string, hosts?: readonly string[]): URL {
  const url = value instanceof URL ? copyUrl(value) : parseUrl(value, label, 'INVALID_RUNTIME');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    isLocalOrIpHostname(url.hostname)
  )
    throw new HostedIdentityError('INVALID_RUNTIME', `${label} is invalid`);
  if (hosts && !hosts.includes(url.hostname.toLowerCase()))
    throw new HostedIdentityError('INVALID_RUNTIME', `${label} is not allowlisted`);
  return url;
}

function assertProviderUrl(value: unknown, hosts: readonly string[], label: string): void {
  validateProviderRuntimeUrl(value, label, hosts);
}

function sameUrl(left: URL, right: URL): boolean {
  return left.href === right.href;
}
function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateCallback(value: unknown, redirectUri: URL): URL {
  const callback =
    value instanceof URL ? copyUrl(value) : parseUrl(value, 'OIDC callback', 'INVALID_CALLBACK');
  if (
    callback.origin !== redirectUri.origin ||
    callback.pathname !== redirectUri.pathname ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.href.length > MAX_URL_LENGTH
  ) {
    throw new HostedIdentityError(
      'INVALID_REDIRECT',
      'OIDC callback did not use the configured redirect URI'
    );
  }
  return callback;
}

function freezeTransaction(value: unknown): OidcAuthorizationTransaction {
  const transaction = plainRecord(value, 'OIDC transaction');
  return Object.freeze({
    id: boundedIdentifier(transaction.id, 'OIDC transaction ID', 'INVALID_CALLBACK'),
    state: boundedIdentifier(transaction.state, 'OIDC transaction state', 'INVALID_CALLBACK'),
    nonce: boundedIdentifier(transaction.nonce, 'OIDC nonce', 'INVALID_CALLBACK'),
    codeVerifier: boundedIdentifier(
      transaction.codeVerifier,
      'OIDC code verifier',
      'INVALID_CALLBACK'
    ),
    redirectUri: parseUrl(
      transaction.redirectUri,
      'OIDC transaction redirect URI',
      'INVALID_CALLBACK'
    ).href,
    returnTo: validateReturnTo(transaction.returnTo as string),
    expiresAt: finiteTimestamp(transaction.expiresAt, 'OIDC transaction expiry', 'INVALID_CALLBACK')
  });
}

function copyTransaction(value: OidcAuthorizationTransaction): OidcAuthorizationTransaction {
  return freezeTransaction({ ...value });
}

function freezeTokenSet(
  value: unknown,
  now = Date.now(),
  allowedIssuerHosts?: readonly string[],
  expectedIssuer?: URL
): OidcTokenSet {
  const tokens = plainRecord(value, 'OIDC token set', 'INVALID_CALLBACK');
  const claims = plainRecord(tokens.claims, 'OIDC claims', 'INVALID_CALLBACK');
  const sub = boundedString(claims.sub, 'OIDC subject', 1, MAX_SUBJECT_LENGTH, invalidCallback);
  if (sub.includes('|')) invalidCallback('OIDC subject is invalid');
  const subjectKey = boundedString(
    tokens.subjectKey,
    'OIDC subject key',
    3,
    MAX_CONFIG_STRING_LENGTH,
    invalidCallback
  );
  if (!subjectKey.endsWith(`|${sub}`) || subjectKey.includes('\u0000'))
    invalidCallback('OIDC subject key is invalid');
  if (allowedIssuerHosts) validateSubjectIssuer(subjectKey, allowedIssuerHosts, expectedIssuer);
  return Object.freeze({
    ...(tokens.accessToken === undefined
      ? {}
      : { accessToken: boundedToken(tokens.accessToken, 'access token') }),
    ...(tokens.refreshToken === undefined
      ? {}
      : { refreshToken: boundedToken(tokens.refreshToken, 'refresh token') }),
    ...(tokens.idToken === undefined ? {} : { idToken: boundedToken(tokens.idToken, 'ID token') }),
    claims: Object.freeze({
      sub,
      ...(claims.email === undefined
        ? {}
        : {
            email: boundedString(claims.email, 'OIDC email', 1, MAX_SUBJECT_LENGTH, invalidCallback)
          }),
      ...(claims.name === undefined
        ? {}
        : { name: boundedString(claims.name, 'OIDC name', 1, MAX_SUBJECT_LENGTH, invalidCallback) })
    }),
    subjectKey,
    expiresAt: validFutureExpiry(tokens.expiresAt, now, 'OIDC token')
  });
}

function freezeSession(
  value: unknown,
  now = Date.now(),
  allowedIssuerHosts?: readonly string[],
  expectedIssuer?: URL
): HostedBffSession {
  const session = plainRecord(value, 'OIDC session', 'INVALID_SESSION');
  const accessVersion = session.accessVersion;
  const organizationId = session.organizationId;
  if ((organizationId === undefined) !== (accessVersion === undefined))
    throw new HostedIdentityError('INVALID_SESSION', 'OIDC session access binding is incomplete');
  const safeOrganizationId =
    organizationId === undefined
      ? undefined
      : boundedString(
          organizationId,
          'OIDC organization ID',
          1,
          MAX_IDENTIFIER_LENGTH,
          invalidSession
        );
  if (accessVersion !== undefined && (!isSafeInteger(accessVersion) || accessVersion < 1))
    invalidSession('OIDC access version is invalid');
  const tokens = freezeTokenSet(session.tokens, now, allowedIssuerHosts, expectedIssuer);
  const subject = boundedString(
    session.subject,
    'OIDC session subject',
    3,
    MAX_CONFIG_STRING_LENGTH,
    invalidSession
  );
  if (subject !== tokens.subjectKey) invalidSession('OIDC session subject is invalid');
  const expiresAt = validFutureExpiry(session.expiresAt, now, 'OIDC session');
  if (expiresAt > tokens.expiresAt) invalidSession('OIDC session expiry exceeds token expiry');
  return Object.freeze({
    id: boundedIdentifier(session.id, 'OIDC session ID', 'INVALID_SESSION'),
    subject,
    expiresAt,
    tokens,
    ...(safeOrganizationId !== undefined ? { organizationId: safeOrganizationId } : {}),
    ...(accessVersion !== undefined ? { accessVersion } : {})
  });
}

function copySession(value: HostedBffSession): HostedBffSession {
  // The source was validated before storage; clone without reinterpreting its
  // expiry against a different clock, then freeze every nested object.
  return Object.freeze({
    ...value,
    tokens: Object.freeze({ ...value.tokens, claims: Object.freeze({ ...value.tokens.claims }) })
  });
}

function validateSubjectIssuer(
  subjectKey: string,
  allowedIssuerHosts: readonly string[],
  expectedIssuer?: URL
): void {
  const separator = subjectKey.lastIndexOf('|');
  if (separator < 1) invalidCallback('OIDC subject key is invalid');
  const issuer = parseUrl(
    subjectKey.slice(0, separator),
    'OIDC subject issuer',
    'INVALID_CALLBACK'
  );
  if (
    issuer.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    !allowedIssuerHosts.includes(issuer.hostname.toLowerCase())
  ) {
    invalidCallback('OIDC subject issuer is not allowlisted');
  }
  if (expectedIssuer && issuer.href !== expectedIssuer.href)
    invalidCallback('OIDC subject issuer does not match the configured issuer');
}

function freezeAccess(value: unknown): HostedBffSessionAccess {
  const access = plainRecord(value, 'OIDC session access');
  const organizationId = boundedString(
    access.organizationId,
    'OIDC organization ID',
    1,
    MAX_IDENTIFIER_LENGTH,
    invalidSession
  );
  if (!isSafeInteger(access.accessVersion) || access.accessVersion < 1)
    invalidSession('OIDC access version is invalid');
  return Object.freeze({ organizationId, accessVersion: access.accessVersion });
}

function finiteTimestamp(value: unknown, label: string, code: HostedIdentityErrorCode): number {
  if (!isFiniteInteger(value) || value < 0 || value > 8_640_000_000_000_000)
    throw new HostedIdentityError(code, `${label} is invalid`);
  return value;
}

function invalidSession(message: string): never {
  throw new HostedIdentityError('INVALID_SESSION', message);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function captureRuntime(value: unknown): OidcRuntime {
  const methods = captureMethods(
    value,
    ['begin', 'exchange', 'revoke', 'endSession'],
    'OIDC runtime'
  );
  return Object.freeze({
    begin: ((...arguments_: Parameters<OidcRuntime['begin']>) =>
      invokeCaptured(methods, 'begin', arguments_) as ReturnType<
        OidcRuntime['begin']
      >) as OidcRuntime['begin'],
    exchange: ((...arguments_: Parameters<OidcRuntime['exchange']>) =>
      invokeCaptured(methods, 'exchange', arguments_) as ReturnType<
        OidcRuntime['exchange']
      >) as OidcRuntime['exchange'],
    revoke: ((...arguments_: Parameters<OidcRuntime['revoke']>) =>
      invokeCaptured(methods, 'revoke', arguments_) as ReturnType<
        OidcRuntime['revoke']
      >) as OidcRuntime['revoke'],
    endSession: ((...arguments_: Parameters<OidcRuntime['endSession']>) =>
      invokeCaptured(methods, 'endSession', arguments_) as ReturnType<
        OidcRuntime['endSession']
      >) as OidcRuntime['endSession']
  });
}

function captureEffects(value: unknown): HostedOidcBffEffects {
  const methods = captureMethods(value, ['forContext'], 'OIDC host effects');
  return Object.freeze({
    forContext: ((...arguments_: Parameters<HostedOidcBffEffects['forContext']>) =>
      invokeCaptured(methods, 'forContext', arguments_) as ReturnType<
        HostedOidcBffEffects['forContext']
      >) as HostedOidcBffEffects['forContext']
  });
}

function captureEffectsResult(value: unknown): {
  readonly runtime: OidcRuntime;
  readonly store: HostedBffStore;
} {
  const result = plainRecord(value, 'OIDC host effects result', 'INVALID_RUNTIME');
  return Object.freeze({
    runtime: captureRuntime(result.runtime),
    store: captureStore(result.store)
  });
}

function captureTransport(value: unknown): OidcAddressPinnedTransport {
  const options = plainRecord(value, 'OIDC transport options');
  const methods = captureMethods(
    options.transport,
    ['resolve', 'fetch'],
    'OIDC address-pinned transport'
  );
  return Object.freeze({
    resolve: ((...arguments_: Parameters<OidcAddressPinnedTransport['resolve']>) =>
      invokeCaptured(methods, 'resolve', arguments_) as ReturnType<
        OidcAddressPinnedTransport['resolve']
      >) as OidcAddressPinnedTransport['resolve'],
    fetch: ((...arguments_: Parameters<OidcAddressPinnedTransport['fetch']>) =>
      invokeCaptured(methods, 'fetch', arguments_) as ReturnType<
        OidcAddressPinnedTransport['fetch']
      >) as OidcAddressPinnedTransport['fetch']
  });
}

function captureStore(value: unknown): HostedBffStore {
  const methods = captureMethods(
    value,
    [
      'createTransaction',
      'consumeTransaction',
      'createSession',
      'readSession',
      'consumeSession',
      'bindSessionAccess',
      'revokeSession'
    ],
    'OIDC store'
  );
  return Object.freeze({
    createTransaction: ((...arguments_: Parameters<HostedBffStore['createTransaction']>) =>
      invokeCaptured(methods, 'createTransaction', arguments_) as ReturnType<
        HostedBffStore['createTransaction']
      >) as HostedBffStore['createTransaction'],
    consumeTransaction: ((...arguments_: Parameters<HostedBffStore['consumeTransaction']>) =>
      invokeCaptured(methods, 'consumeTransaction', arguments_) as ReturnType<
        HostedBffStore['consumeTransaction']
      >) as HostedBffStore['consumeTransaction'],
    createSession: ((...arguments_: Parameters<HostedBffStore['createSession']>) =>
      invokeCaptured(methods, 'createSession', arguments_) as ReturnType<
        HostedBffStore['createSession']
      >) as HostedBffStore['createSession'],
    readSession: ((...arguments_: Parameters<HostedBffStore['readSession']>) =>
      invokeCaptured(methods, 'readSession', arguments_) as ReturnType<
        HostedBffStore['readSession']
      >) as HostedBffStore['readSession'],
    consumeSession: ((...arguments_: Parameters<HostedBffStore['consumeSession']>) =>
      invokeCaptured(methods, 'consumeSession', arguments_) as ReturnType<
        HostedBffStore['consumeSession']
      >) as HostedBffStore['consumeSession'],
    bindSessionAccess: ((...arguments_: Parameters<HostedBffStore['bindSessionAccess']>) =>
      invokeCaptured(methods, 'bindSessionAccess', arguments_) as ReturnType<
        HostedBffStore['bindSessionAccess']
      >) as HostedBffStore['bindSessionAccess'],
    revokeSession: ((...arguments_: Parameters<HostedBffStore['revokeSession']>) =>
      invokeCaptured(methods, 'revokeSession', arguments_) as ReturnType<
        HostedBffStore['revokeSession']
      >) as HostedBffStore['revokeSession']
  });
}

function captureMethods(
  value: unknown,
  names: readonly string[],
  label: string
): Readonly<{ target: object; methods: Readonly<Record<string, (...args: never[]) => unknown>> }> {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) throw new Error();
    const target = value as object;
    const captured = captureMethodMap(target, names);
    return Object.freeze({ target, methods: Object.freeze(captured) });
  } catch {
    throw new HostedIdentityError('INVALID_RUNTIME', `${label} methods are invalid`);
  }
}

function captureMethodMap(
  target: object,
  names: readonly string[]
): Record<string, (...args: never[]) => unknown> {
  const pending = new Set(names);
  const captured: Record<string, (...args: never[]) => unknown> = {};
  let cursor: object | null = target;
  const seen = new Set<object>();
  let reads = 0;
  for (let depth = 0; cursor && depth < 8 && pending.size > 0; depth += 1) {
    if (seen.has(cursor)) throw new Error();
    seen.add(cursor);
    for (const name of [...pending]) {
      if (++reads > 128) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
      if (descriptor === undefined) continue;
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error();
      captured[name] = descriptor.value as (...args: never[]) => unknown;
      pending.delete(name);
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  if (pending.size > 0) throw new Error();
  return captured;
}

function invokeCaptured(
  captured: Readonly<{
    target: object;
    methods: Readonly<Record<string, (...args: never[]) => unknown>>;
  }>,
  name: string,
  arguments_: readonly unknown[]
): unknown {
  return Reflect.apply(captured.methods[name]!, captured.target, arguments_ as never[]);
}

/** Thin bridge from a host-owned context to adapters that require AbortSignal. */
function boundedAdapterCall<T>(
  action: (signal: AbortSignal) => Promise<T>,
  context?: HostedIdentityCallContext,
  inheritedSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  let unsubscribe: (() => void) | undefined;
  let inheritedAttached = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (deadline !== undefined) clearTimeout(deadline);
    try {
      unsubscribe?.();
    } catch {}
    if (inheritedAttached) {
      try {
        inheritedSignal?.removeEventListener('abort', abort);
      } catch {}
    }
  };
  return Promise.resolve()
    .then(() => {
      if (context?.cancellation.isCancellationRequested()) abort();
      unsubscribe = context?.cancellation.subscribe(abort);
      inheritedAttached = inheritedSignal !== undefined;
      inheritedSignal?.addEventListener('abort', abort, { once: true });
      if (inheritedSignal?.aborted) abort();
      if (context?.remainingDurationMs === 0) abort();
      const deadlinePromise = context
        ? new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(() => {
              abort();
              reject(new Error('OIDC call deadline exceeded'));
            }, context.remainingDurationMs);
          })
        : undefined;
      return Promise.race([
        Promise.resolve().then(() => {
          if (context?.remainingDurationMs === 0) throw new Error('OIDC call deadline exceeded');
          return action(controller.signal);
        }),
        ...(deadlinePromise ? [deadlinePromise] : [])
      ]);
    })
    .finally(cleanup);
}

/** Snapshots the portable public context once before any runtime or store effect. */
function captureHostedIdentityCallContext(
  value: HostedIdentityCallContext
): HostedIdentityCallContext {
  try {
    if (!value || typeof value !== 'object') throw new Error();
    const durationDescriptor = Object.getOwnPropertyDescriptor(value, 'remainingDurationMs');
    const cancellationDescriptor = Object.getOwnPropertyDescriptor(value, 'cancellation');
    if (
      !durationDescriptor ||
      !cancellationDescriptor ||
      !('value' in durationDescriptor) ||
      !('value' in cancellationDescriptor)
    )
      throw new Error();
    const duration = durationDescriptor.value;
    const cancellation = cancellationDescriptor.value;
    if (
      !Number.isSafeInteger(duration) ||
      (duration as number) < 0 ||
      (duration as number) > MAX_HOSTED_CALL_DURATION_MS
    )
      throw new Error();
    const captured = captureMethods(
      cancellation,
      ['isCancellationRequested', 'subscribe'],
      'OIDC cancellation'
    );
    return Object.freeze({
      remainingDurationMs: duration as number,
      cancellation: Object.freeze({
        isCancellationRequested(): boolean {
          const result = Reflect.apply(
            captured.methods.isCancellationRequested!,
            captured.target,
            []
          );
          if (typeof result !== 'boolean') throw new Error();
          return result;
        },
        subscribe(listener: (reason: 'caller-aborted' | 'deadline-exceeded') => void): () => void {
          const unsubscribe = Reflect.apply(captured.methods.subscribe!, captured.target, [
            listener
          ]);
          if (typeof unsubscribe !== 'function') throw new Error();
          let released = false;
          return () => {
            if (released) return;
            released = true;
            try {
              Reflect.apply(unsubscribe, undefined, []);
            } catch {}
          };
        }
      })
    });
  } catch {
    throw new HostedIdentityError('INVALID_RUNTIME', 'OIDC call context is invalid');
  }
}

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || point === 127);
  });
}
