import { readServiceEnvironment } from './env.js';

const environment = readServiceEnvironment();
if (!environment.databaseUrl) throw new Error('Migration requires DATABASE_URL');
const sql = new Bun.SQL(environment.databaseUrl);
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const migrations = ['0001_collaboration.sql', '0002_realtime_events.sql'];
  for (const fileName of migrations) {
    const name = fileName.replace(/\.sql$/, '');
    const alreadyApplied = await sql<
      { name: string }[]
    >`SELECT name FROM schema_migrations WHERE name = ${name}`;
    if (alreadyApplied.length > 0) {
      console.info(JSON.stringify({ level: 'info', event: 'migration.skipped', name }));
      continue;
    }
    const migration = await Bun.file(
      new URL(`../../../packages/collaboration/migrations/${fileName}`, import.meta.url)
    ).text();
    await sql.transaction(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    console.info(JSON.stringify({ level: 'info', event: 'migration.applied', name }));
  }
} finally {
  await sql.close();
}
