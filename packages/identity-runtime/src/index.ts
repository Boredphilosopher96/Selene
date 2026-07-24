import * as oidc from 'openid-client';

/**
 * Hosted OIDC runtime. All PKCE randomness, token validation, signature
 * checks, discovery, and JWKS cache/rotation behaviour are delegated to
 * openid-client; this module never implements cryptography or JWT parsing.
 */
export const hostedIdentityRuntime = 'selene-hosted-identity/v1' as const;

export type HostedIdentityErrorCode =
  | 'INVALID_PROVIDER_CONFIG'
  | 'INVALID_REDIRECT'
  | 'INVALID_RETURN_TO'
  | 'INVALID_CALLBACK'
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
  if (!input.clientId.trim()) invalidProvider('OIDC client ID is required');
  const issuer = trustedHttpsUrl(input.issuer, 'issuer');
  const allowedIssuerHosts = input.allowedIssuerHosts.map((host) => host.toLowerCase());
  if (
    allowedIssuerHosts.length === 0 ||
    allowedIssuerHosts.some((host) => !isPublicHostname(host))
  ) {
    invalidProvider('OIDC issuer host allowlist must contain exact public hostnames');
  }
  if (!allowedIssuerHosts.includes(issuer.hostname.toLowerCase())) {
    invalidProvider('OIDC issuer host is not in the explicit allowlist');
  }
  const redirectUri = validateRedirect(input.redirectUri);
  if (issuer.search || issuer.hash)
    invalidProvider('OIDC issuer must not contain query or fragment');
  if (redirectUri.search || redirectUri.hash)
    invalidProvider('OIDC redirect URI must not contain query or fragment');
  const scopes = [...new Set(input.scopes ?? ['openid', 'profile', 'email'])];
  if (!scopes.includes('openid')) invalidProvider('OIDC scopes must include openid');
  if (scopes.some((scope) => !/^[A-Za-z0-9:._-]{1,128}$/.test(scope))) {
    invalidProvider('OIDC scopes contain an invalid value');
  }
  return {
    issuer,
    allowedIssuerHosts,
    clientId: input.clientId,
    ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
    redirectUri,
    scopes
  };
}

/** Loopback callback targets are for native apps only; hosted BFF redirects must be HTTPS. */
export function validateElectronRedirectUri(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostedIdentityError('INVALID_REDIRECT', 'Electron redirect URI is invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HostedIdentityError(
      'INVALID_REDIRECT',
      'Electron redirect URI has unsafe components'
    );
  }
  const loopback =
    url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if (loopback && !url.port) {
    throw new HostedIdentityError(
      'INVALID_REDIRECT',
      'Electron loopback redirect URI must use an explicit registered port'
    );
  }
  if (!loopback && url.protocol !== 'https:') {
    throw new HostedIdentityError(
      'INVALID_REDIRECT',
      'Electron redirect must be loopback HTTP or claimed HTTPS'
    );
  }
  if (!loopback && isLocalOrIpHostname(url.hostname)) {
    throw new HostedIdentityError(
      'INVALID_REDIRECT',
      'Electron claimed HTTPS redirect must use a public host'
    );
  }
  return url;
}

function trustedHttpsUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidProvider(`OIDC ${label} is invalid`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    isLocalOrIpHostname(url.hostname)
  ) {
    invalidProvider(`OIDC ${label} must be a public HTTPS URL`);
  }
  return url;
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

function invalidProvider(message: string): never {
  throw new HostedIdentityError('INVALID_PROVIDER_CONFIG', message);
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
  begin(input: { readonly redirectUri: URL; readonly scopes: readonly string[] }): Promise<{
    readonly authorizationUrl: URL;
    readonly state: string;
    readonly nonce: string;
    readonly codeVerifier: string;
  }>;
  exchange(input: {
    readonly callback: URL;
    readonly transaction: OidcAuthorizationTransaction;
  }): Promise<OidcTokenSet>;
  revoke(token: string, hint: 'access_token' | 'refresh_token'): Promise<void>;
  endSession(input: {
    readonly idToken?: string;
    readonly postLogoutRedirectUri: URL;
  }): Promise<URL | undefined>;
}

/**
 * Construct the maintained-library adapter. `authorizationCodeGrant` checks
 * callback state, nonce, PKCE, issuer, audience, expiry, signature, and JWKS
 * rotation according to openid-client's current implementation.
 */
export function createOpenIdClientRuntime(input: HostedOidcProviderConfig): OidcRuntime {
  return createOpenIdRuntime(validateHostedOidcProviderConfig(input));
}

export function createElectronOpenIdClientRuntime(input: HostedOidcProviderConfig): OidcRuntime {
  return createOpenIdRuntime(validateElectronOidcProviderConfig(input));
}

function createOpenIdRuntime(provider: ValidatedHostedOidcProviderConfig): OidcRuntime {
  const configuration = oidc.discovery(
    provider.issuer,
    provider.clientId,
    provider.clientSecret,
    provider.clientSecret ? oidc.ClientSecretBasic(provider.clientSecret) : oidc.None(),
    { [oidc.customFetch]: createOidcSsrfSafeFetch(provider.allowedIssuerHosts) as never }
  );
  return {
    async begin({ redirectUri, scopes }) {
      if (redirectUri.href !== provider.redirectUri.href) {
        throw new HostedIdentityError(
          'INVALID_REDIRECT',
          'OIDC redirect URI is not the configured callback'
        );
      }
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const authorizationUrl = oidc.buildAuthorizationUrl(await configuration, {
        redirect_uri: redirectUri.href,
        response_type: 'code',
        scope: scopes.join(' '),
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce
      });
      return { authorizationUrl, state, nonce, codeVerifier };
    },
    async exchange({ callback, transaction }) {
      const tokens = await oidc.authorizationCodeGrant(await configuration, callback, {
        pkceCodeVerifier: transaction.codeVerifier,
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        idTokenExpected: true
      });
      const claims = tokens.claims();
      if (!claims?.sub)
        throw new HostedIdentityError('INVALID_CALLBACK', 'OIDC token has no subject claim');
      return {
        ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
        claims: {
          sub: claims.sub,
          ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
          ...(typeof claims.name === 'string' ? { name: claims.name } : {})
        },
        subjectKey: `${provider.issuer.href}|${claims.sub}`,
        expiresAt:
          typeof tokens.expires_in === 'number'
            ? Date.now() + tokens.expires_in * 1_000
            : Date.now() + 3_600_000
      };
    },
    async revoke(token, hint) {
      await oidc.tokenRevocation(await configuration, token, { token_type_hint: hint });
    },
    async endSession({ idToken, postLogoutRedirectUri }) {
      const config = await configuration;
      if (!config.serverMetadata().end_session_endpoint) return undefined;
      return oidc.buildEndSessionUrl(config, {
        ...(idToken ? { id_token_hint: idToken } : {}),
        post_logout_redirect_uri: postLogoutRedirectUri.href
      });
    }
  };
}

/** Blocks discovery, JWKS, token, and revocation requests outside the configured provider hosts. */
export function createOidcSsrfSafeFetch(
  allowedIssuerHosts: readonly string[],
  fetchImplementation: OidcFetch = nativeFetch
): OidcFetch {
  const allowed = new Set(allowedIssuerHosts.map((host) => host.toLowerCase()));
  return async (input, init) => {
    const target = new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : input
    );
    if (
      target.protocol !== 'https:' ||
      !allowed.has(target.hostname.toLowerCase()) ||
      isLocalOrIpHostname(target.hostname)
    ) {
      throw new HostedIdentityError(
        'INVALID_PROVIDER_CONFIG',
        'OIDC HTTP target violates issuer allowlist policy'
      );
    }
    return fetchImplementation(input, { ...init, redirect: 'error' });
  };
}

export type OidcFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

export interface HostedBffSession {
  readonly id: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly tokens: OidcTokenSet;
}

export interface HostedBffStore {
  createTransaction(transaction: OidcAuthorizationTransaction): Promise<void>;
  consumeTransaction(id: string): Promise<OidcAuthorizationTransaction | undefined>;
  createSession(session: HostedBffSession): Promise<void>;
  readSession(id: string): Promise<HostedBffSession | undefined>;
  revokeSession(id: string): Promise<void>;
}

export function createInMemoryHostedBffStore(): HostedBffStore {
  const transactions = new Map<string, OidcAuthorizationTransaction>();
  const sessions = new Map<string, HostedBffSession>();
  return {
    async createTransaction(transaction) {
      transactions.set(transaction.id, transaction);
    },
    async consumeTransaction(id) {
      const transaction = transactions.get(id);
      transactions.delete(id);
      return transaction;
    },
    async createSession(session) {
      sessions.set(session.id, session);
    },
    async readSession(id) {
      return sessions.get(id);
    },
    async revokeSession(id) {
      sessions.delete(id);
    }
  };
}

export interface HostedOidcBffOptions {
  readonly runtime: OidcRuntime;
  readonly store: HostedBffStore;
  readonly redirectUri: string;
  readonly scopes?: readonly string[];
  readonly transactionTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly now?: () => number;
}

export class HostedOidcBff {
  private readonly redirectUri: URL;
  private readonly scopes: readonly string[];
  private readonly transactionTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: HostedOidcBffOptions) {
    this.redirectUri = trustedHttpsUrl(options.redirectUri, 'redirect URI');
    this.scopes = options.scopes ?? ['openid', 'profile', 'email'];
    this.transactionTtlMs = options.transactionTtlMs ?? 5 * 60_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async begin(
    returnTo?: string
  ): Promise<{ readonly authorizationUrl: URL; readonly transactionId: string }> {
    const safeReturnTo = validateReturnTo(returnTo);
    const prepared = await this.options.runtime.begin({
      redirectUri: this.redirectUri,
      scopes: this.scopes
    });
    const transaction: OidcAuthorizationTransaction = {
      id: prepared.state,
      state: prepared.state,
      nonce: prepared.nonce,
      codeVerifier: prepared.codeVerifier,
      redirectUri: this.redirectUri.href,
      returnTo: safeReturnTo,
      expiresAt: this.now() + this.transactionTtlMs
    };
    await this.options.store.createTransaction(transaction);
    return { authorizationUrl: prepared.authorizationUrl, transactionId: transaction.id };
  }

  async complete(
    callback: URL,
    transactionId: string
  ): Promise<{ readonly session: HostedBffSession; readonly returnTo: string }> {
    if (
      callback.origin !== this.redirectUri.origin ||
      callback.pathname !== this.redirectUri.pathname
    ) {
      throw new HostedIdentityError(
        'INVALID_REDIRECT',
        'OIDC callback did not use the configured redirect URI'
      );
    }
    const transaction = await this.options.store.consumeTransaction(transactionId);
    if (!transaction)
      throw new HostedIdentityError(
        'TRANSACTION_REPLAYED',
        'OIDC transaction was already used or unknown'
      );
    if (transaction.expiresAt <= this.now())
      throw new HostedIdentityError('TRANSACTION_EXPIRED', 'OIDC transaction expired');
    const tokens = await this.options.runtime.exchange({ callback, transaction });
    const session: HostedBffSession = {
      // Deliberately independent from transaction ID so a callback cannot fixate a session.
      id: oidc.randomState(),
      subject: tokens.subjectKey,
      expiresAt: Math.min(tokens.expiresAt, this.now() + this.sessionTtlMs),
      tokens
    };
    await this.options.store.createSession(session);
    return { session, returnTo: transaction.returnTo };
  }

  async authenticate(sessionId: string): Promise<HostedBffSession | undefined> {
    const session = await this.options.store.readSession(sessionId);
    if (!session) return undefined;
    if (session.expiresAt <= this.now()) {
      await this.options.store.revokeSession(sessionId);
      return undefined;
    }
    return session;
  }

  async logout(sessionId: string): Promise<URL | undefined> {
    const session = await this.options.store.readSession(sessionId);
    await this.options.store.revokeSession(sessionId);
    if (!session) return undefined;
    await Promise.allSettled([
      ...(session.tokens.refreshToken
        ? [this.options.runtime.revoke(session.tokens.refreshToken, 'refresh_token')]
        : []),
      ...(session.tokens.accessToken
        ? [this.options.runtime.revoke(session.tokens.accessToken, 'access_token')]
        : [])
    ]);
    return this.options.runtime.endSession({
      ...(session.tokens.idToken ? { idToken: session.tokens.idToken } : {}),
      postLogoutRedirectUri: this.redirectUri
    });
  }
}

export function validateReturnTo(value: string | undefined): string {
  if (value === undefined || value === '') return '/';
  if (
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
  const parsed = new URL(value, 'https://selene.invalid');
  if (parsed.origin !== 'https://selene.invalid') {
    throw new HostedIdentityError('INVALID_RETURN_TO', 'Return target must be same-origin');
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function serializeBffCookie(
  name: '__Host-selene_session' | '__Host-selene_oidc_tx',
  value: string,
  maxAgeSeconds: number
): string {
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(value)) {
    throw new HostedIdentityError('INVALID_CALLBACK', 'BFF cookie identifier is malformed');
  }
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function parseBffCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  const values = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{20,512}$/.test(value) ? value : undefined;
}

/** Logout is a state-changing browser request and therefore requires same-origin POST. */
export function assertSameOriginPost(request: Request, applicationOrigin: string): void {
  if (request.method !== 'POST' || request.headers.get('origin') !== applicationOrigin) {
    throw new HostedIdentityError('CSRF', 'State-changing BFF requests require a same-origin POST');
  }
}

/** Test-only fixture adapter: production token checks occur inside openid-client. */
export function applyFixtureExchange(
  callback: URL,
  transaction: OidcAuthorizationTransaction,
  failure?: string
): void {
  if (callback.searchParams.get('state') !== transaction.state) throw new Error('state');
  if (failure) throw new Error(failure);
}

function containsAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point < 32 || point === 127);
  });
}
