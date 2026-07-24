import { createMemoryApplication, createCollaborationApplication } from './app.js';
import { createBffIdentityProvider, createOidcBffHttpHandler } from './oidc-bff.js';
import { readServiceEnvironment } from './env.js';
import { BunPostgresBffStore } from './postgres-bff-store.js';
import { BunPostgresCollaborationRepository } from './postgres-repository.js';
import { HostedOidcBff, createOpenIdClientRuntime } from '@selene/identity-runtime';
import { createAddressPinnedOidcTransport } from '@selene/identity-runtime/node';
import { createSupervisedOidcBffEffects } from './oidc-effect-ports.js';
import { createOidcEffectRunner } from './oidc-effects.js';

const environment = readServiceEnvironment();
const sql = environment.store === 'memory' ? undefined : new Bun.SQL(environment.databaseUrl);
const repository = sql ? new BunPostgresCollaborationRepository(sql) : undefined;
if (environment.authMode === 'oidc' && !repository) {
  throw new Error('COLLABORATION_AUTH_MODE=oidc requires PostgreSQL storage and provisioned users');
}
const oidcEffects = environment.authMode === 'oidc' ? createOidcEffectRunner() : undefined;
const oidcBff =
  environment.authMode === 'oidc' && environment.oidc && repository && sql && oidcEffects
    ? new HostedOidcBff({
        effects: createSupervisedOidcBffEffects(
          createOpenIdClientRuntime(environment.oidc, {
            transport: createAddressPinnedOidcTransport()
          }),
          new BunPostgresBffStore(sql),
          oidcEffects
        ),
        issuer: environment.oidc.issuer,
        allowedIssuerHosts: environment.oidc.allowedIssuerHosts,
        redirectUri: environment.oidc.redirectUri
      })
    : undefined;
// One shared pool for this trusted BFF host; each wrapped runtime/store/identity
// port owns a stable process-lifetime supervisor owner object.
const application = repository
  ? createCollaborationApplication(
      environment,
      repository,
      repository,
      repository,
      oidcBff
        ? createBffIdentityProvider(
            oidcBff,
            {
              resolveExternalSubject: (session) => repository.resolveBffIdentity(session)
            },
            oidcEffects
          )
        : undefined,
      oidcBff
        ? createOidcBffHttpHandler(
            oidcBff,
            new URL(environment.oidc?.redirectUri ?? '').origin,
            oidcEffects
          )
        : undefined
    )
  : createMemoryApplication(environment);

await application.ready();
const server = Bun.serve({
  hostname: environment.host,
  port: environment.port,
  maxRequestBodySize: environment.bodyLimitBytes,
  fetch: application.fetch
});
console.info(
  JSON.stringify({
    level: 'info',
    event: 'service.started',
    host: environment.host,
    port: server.port,
    store: environment.store
  })
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.info(JSON.stringify({ level: 'info', event: 'service.stopping', signal }));
  // Stop accepting new connections and let Bun drain in-flight requests before
  // closing the PostgreSQL pool. The orchestrator supplies the SIGTERM grace period.
  server.stop();
  if (repository) await repository.close();
  console.info(JSON.stringify({ level: 'info', event: 'service.stopped' }));
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
