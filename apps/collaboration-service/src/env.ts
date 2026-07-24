export interface ServiceEnvironment {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl?: string;
  readonly store: 'postgres' | 'memory';
  readonly corsOrigins: readonly string[];
  readonly shareSecret: string;
  readonly proxySecret: string;
  readonly bodyLimitBytes: number;
  readonly rateLimitPerMinute: number;
}

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
  const proxySecret = values.COLLABORATION_PROXY_SECRET;
  if (!proxySecret || proxySecret.length < 32) {
    throw new Error('COLLABORATION_PROXY_SECRET must contain at least 32 characters');
  }
  const databaseUrl = values.DATABASE_URL;
  if (store === 'postgres' && !databaseUrl)
    throw new Error('DATABASE_URL is required for PostgreSQL storage');
  const corsOrigins = (values.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    host: values.HOST ?? '0.0.0.0',
    port: integer(values.PORT, 'PORT', 8787),
    store,
    ...(databaseUrl ? { databaseUrl } : {}),
    corsOrigins,
    shareSecret,
    proxySecret,
    bodyLimitBytes: integer(values.MAX_BODY_BYTES, 'MAX_BODY_BYTES', 1_048_576),
    rateLimitPerMinute: integer(values.RATE_LIMIT_PER_MINUTE, 'RATE_LIMIT_PER_MINUTE', 120)
  };
}
