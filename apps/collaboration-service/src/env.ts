import {
  validateHostedOidcProviderConfig,
  type HostedOidcProviderConfig
} from '@selene/identity-runtime';

interface ServiceEnvironmentBase {
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly shareSecret: string;
  readonly proxySecret: string;
  readonly authMode: 'proxy' | 'local' | 'oidc';
  readonly localUserId: string;
  readonly oidc?: HostedOidcProviderConfig;
  readonly bodyLimitBytes: number;
  readonly rateLimitPerMinute: number;
  readonly hostedReview?: HostedReviewDeploymentConfig;
}

export interface HostedReviewDeploymentConfig {
  readonly projectId: string;
  readonly artifactId: string;
  readonly revisionId: string;
  readonly baselineId: string;
  readonly version: number;
}

export type ServiceEnvironment =
  | (ServiceEnvironmentBase & { readonly store: 'postgres'; readonly databaseUrl: string })
  | (ServiceEnvironmentBase & { readonly store: 'memory'; readonly databaseUrl?: never });

function integer(value: string | undefined, name: string, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function readServiceEnvironment(
  values: Record<string, string | undefined> = process.env
): ServiceEnvironment {
  const store = values.COLLABORATION_STORE ?? 'postgres';
  if (store !== 'postgres' && store !== 'memory') {
    throw new Error('COLLABORATION_STORE must be postgres or memory');
  }
  const shareSecret = values.COLLABORATION_SHARE_SECRET;
  if (!shareSecret || shareSecret.length < 32) {
    throw new Error('COLLABORATION_SHARE_SECRET must contain at least 32 characters');
  }
  const authMode = values.COLLABORATION_AUTH_MODE ?? 'proxy';
  if (authMode !== 'proxy' && authMode !== 'local' && authMode !== 'oidc') {
    throw new Error('COLLABORATION_AUTH_MODE must be proxy, local, or oidc');
  }
  const configuredProxySecret = values.COLLABORATION_PROXY_SECRET;
  if (authMode === 'proxy' && (!configuredProxySecret || configuredProxySecret.length < 32)) {
    throw new Error('COLLABORATION_PROXY_SECRET must contain at least 32 characters');
  }
  // Local mode never constructs the header provider; retain a non-secret
  // placeholder so the environment shape stays uniform for host composition.
  const proxySecret = configuredProxySecret ?? 'local-mode-not-used';
  const databaseUrl = values.DATABASE_URL;
  if (store === 'postgres' && !databaseUrl)
    throw new Error('DATABASE_URL is required for PostgreSQL storage');
  const corsOrigins = (values.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (authMode === 'local' && store !== 'memory') {
    throw new Error('COLLABORATION_AUTH_MODE=local requires COLLABORATION_STORE=memory');
  }
  const oidc = authMode === 'oidc' ? readHostedOidcProviderConfig(values) : undefined;
  const hostedReview = readHostedReviewDeploymentConfig(values);
  const common: ServiceEnvironmentBase = {
    host: values.HOST ?? (authMode === 'local' ? '127.0.0.1' : '0.0.0.0'),
    port: integer(values.PORT, 'PORT', 8787),
    corsOrigins,
    shareSecret,
    proxySecret,
    authMode,
    localUserId: values.COLLABORATION_LOCAL_USER_ID ?? 'local-user',
    ...(oidc ? { oidc } : {}),
    ...(hostedReview ? { hostedReview } : {}),
    bodyLimitBytes: integer(values.MAX_BODY_BYTES, 'MAX_BODY_BYTES', 1_048_576),
    rateLimitPerMinute: integer(values.RATE_LIMIT_PER_MINUTE, 'RATE_LIMIT_PER_MINUTE', 120)
  };
  if (store === 'postgres') {
    if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL storage');
    return { ...common, store, databaseUrl };
  }
  return { ...common, store };
}

function readHostedReviewDeploymentConfig(
  values: Record<string, string | undefined>
): HostedReviewDeploymentConfig | undefined {
  const entries = {
    projectId: values.HOSTED_REVIEW_PROJECT_ID,
    artifactId: values.HOSTED_REVIEW_ARTIFACT_ID,
    revisionId: values.HOSTED_REVIEW_REVISION_ID,
    baselineId: values.HOSTED_REVIEW_BASELINE_ID,
    version: values.HOSTED_REVIEW_CONTRACT_VERSION
  };
  const configured = Object.values(entries).filter(
    (value): value is string => value !== undefined && value.length > 0
  );
  if (configured.length === 0) return undefined;
  if (configured.length !== Object.keys(entries).length)
    throw new Error(
      'Hosted review configuration requires project, artifact, revision, baseline, and version'
    );
  const version = Number(entries.version);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error('HOSTED_REVIEW_CONTRACT_VERSION must be a positive integer');
  return {
    projectId: entries.projectId!,
    artifactId: entries.artifactId!,
    revisionId: entries.revisionId!,
    baselineId: entries.baselineId!,
    version
  };
}

function readHostedOidcProviderConfig(
  values: Record<string, string | undefined>
): HostedOidcProviderConfig {
  const issuer = values.COLLABORATION_OIDC_ISSUER;
  const clientId = values.COLLABORATION_OIDC_CLIENT_ID;
  const redirectUri = values.COLLABORATION_OIDC_REDIRECT_URI;
  if (!issuer || !clientId || !redirectUri) {
    throw new Error('OIDC mode requires COLLABORATION_OIDC_ISSUER, _CLIENT_ID, and _REDIRECT_URI');
  }
  const provider = {
    issuer,
    allowedIssuerHosts: (values.COLLABORATION_OIDC_ALLOWED_ISSUER_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    clientId,
    ...(values.COLLABORATION_OIDC_CLIENT_SECRET
      ? { clientSecret: values.COLLABORATION_OIDC_CLIENT_SECRET }
      : {}),
    redirectUri,
    scopes: (values.COLLABORATION_OIDC_SCOPES ?? 'openid,profile,email')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean)
  };
  validateHostedOidcProviderConfig(provider);
  return provider;
}
