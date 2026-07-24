import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../migrations/0003_design_baselines.sql', import.meta.url),
  'utf8'
);
const ownershipMigration = readFileSync(
  new URL('../migrations/0004_project_ownership_foreign_keys.sql', import.meta.url),
  'utf8'
);
const migrator = readFileSync(
  new URL('../../../apps/collaboration-service/src/migrate.ts', import.meta.url),
  'utf8'
);

describe('generated-design baseline migration', () => {
  it('persists immutable baselines and semantic re-review changes separately from releases', () => {
    expect(migration).toContain('CREATE TABLE design_baselines');
    expect(migration).toContain('CREATE TABLE design_baseline_changes');
    expect(migration).toContain('before_revision_id');
    expect(migration).toContain('current_revision_id');
    expect(migration).toContain('affected jsonb NOT NULL');
    expect(migration).toContain('evidence jsonb NOT NULL');
    expect(migration).toContain('provenance jsonb NOT NULL');
  });

  it('makes ready transitions atomic and locks/derives same-project baselines for changes', () => {
    expect(migration).toContain('CREATE FUNCTION mark_generated_design_ready');
    expect(migration).toContain("currency = 'current', approvals_stale = false");
    expect(migration).toContain('CREATE FUNCTION record_generated_design_change');
    expect(migration).toContain('SELECT baseline_id INTO active_baseline');
    expect(migration).toContain("RAISE EXCEPTION 'baseline must belong to project'");
    expect(migration).toContain("RAISE EXCEPTION 'design change revisions must belong to project'");
    expect(migration).toContain("currency = 'stale', approvals_stale = true");
    expect(migration).toContain('collaboration-only audit events never call this function');
  });

  it('uses composite foreign keys to prevent cross-project baseline and revision references', () => {
    expect(ownershipMigration).toContain(
      'FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, id)'
    );
    expect(ownershipMigration).toContain(
      'FOREIGN KEY (project_id, baseline_id) REFERENCES design_baselines(project_id, id)'
    );
    expect(ownershipMigration).toContain(
      'FOREIGN KEY (project_id, before_revision_id) REFERENCES revisions(project_id, id)'
    );
    expect(ownershipMigration).toContain(
      'FOREIGN KEY (project_id, current_revision_id) REFERENCES revisions(project_id, id)'
    );
  });

  it('runs baseline and ownership migrations after existing collaboration schema migrations', () => {
    expect(migrator).toContain("'0003_design_baselines.sql'");
    expect(migrator).toContain("'0004_project_ownership_foreign_keys.sql'");
  });
});
