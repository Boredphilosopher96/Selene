import { readServiceEnvironment } from './env.js';

const environment = readServiceEnvironment();
if (!environment.databaseUrl) throw new Error('Migration requires DATABASE_URL');
const sql = new Bun.SQL(environment.databaseUrl);
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const migrations = [
    '0001_collaboration.sql',
    '0002_realtime_events.sql',
    '0003_design_baselines.sql',
    '0004_project_ownership_foreign_keys.sql',
    '0005_review_aggregates.sql',
    '0006_public_contract_hardening.sql',
    '0007_ai_undo_result_compatibility.sql',
    '0008_oidc_bff_sessions.sql',
    '0009_organization_identity_administration.sql',
    '0010_identity_tenant_binding_hardening.sql',
    '0011_review_thread_reopen_attribution.sql',
    '0012_review_thread_cas.sql'
  ];
  for (const fileName of migrations) {
    const name = fileName.replace(/\.sql$/, '');
    // Migrations are intentionally applied in filename order.
    // eslint-disable-next-line no-await-in-loop
    const alreadyApplied = await sql<
      { name: string }[]
    >`SELECT name FROM schema_migrations WHERE name = ${name}`;
    if (alreadyApplied.length > 0) {
      console.info(JSON.stringify({ level: 'info', event: 'migration.skipped', name }));
      continue;
    }
    // Reading and applying each migration sequentially preserves schema dependencies.
    // eslint-disable-next-line no-await-in-loop
    const migration = await Bun.file(
      new URL(`../../../packages/collaboration/migrations/${fileName}`, import.meta.url)
    ).text();
    // eslint-disable-next-line no-await-in-loop
    await sql.transaction(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    console.info(JSON.stringify({ level: 'info', event: 'migration.applied', name }));
  }
} finally {
  await sql.close();
}
