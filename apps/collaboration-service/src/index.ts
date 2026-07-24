import { createMemoryApplication, createCollaborationApplication } from './app.js';
import { readServiceEnvironment } from './env.js';
import { BunPostgresCollaborationRepository } from './postgres-repository.js';

const environment = readServiceEnvironment();
const repository =
  environment.store === 'memory'
    ? undefined
    : new BunPostgresCollaborationRepository(new Bun.SQL(environment.databaseUrl));
const application = repository
  ? createCollaborationApplication(environment, repository, repository, repository)
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
