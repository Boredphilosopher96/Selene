interface ServiceEnvironmentBase {
  readonly host: string;
  readonly port: number;
  readonly corsOrigins: readonly string[];
  readonly shareSecret: string;
  readonly proxySecret: string;
  readonly authMode: 'proxy' | 'local';
  readonly localUserId: string;
  readonly bodyLimitBytes: number;
  readonly rateLimitPerMinute: number;
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
  if (authMode !== 'proxy' && authMode !== 'local') {
    throw new Error('COLLABORATION_AUTH_MODE must be proxy or local');
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
  const common: ServiceEnvironmentBase = {
    host: values.HOST ?? (authMode === 'local' ? '127.0.0.1' : '0.0.0.0'),
    port: integer(values.PORT, 'PORT', 8787),
    corsOrigins,
    shareSecret,
    proxySecret,
    authMode,
    localUserId: values.COLLABORATION_LOCAL_USER_ID ?? 'local-user',
    bodyLimitBytes: integer(values.MAX_BODY_BYTES, 'MAX_BODY_BYTES', 1_048_576),
    rateLimitPerMinute: integer(values.RATE_LIMIT_PER_MINUTE, 'RATE_LIMIT_PER_MINUTE', 120)
  };
  if (store === 'postgres') {
    if (!databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL storage');
    return { ...common, store, databaseUrl };
  }
  return { ...common, store };
}
