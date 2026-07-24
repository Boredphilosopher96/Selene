import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../migrations/0001_collaboration.sql', import.meta.url),
  'utf8'
);
const realtimeMigration = readFileSync(
  new URL('../migrations/0002_realtime_events.sql', import.meta.url),
  'utf8'
);
const ownershipMigration = readFileSync(
  new URL('../migrations/0004_project_ownership_foreign_keys.sql', import.meta.url),
  'utf8'
);
const reviewMigration = readFileSync(
  new URL('../migrations/0005_review_aggregates.sql', import.meta.url),
  'utf8'
);
const hardeningMigration = readFileSync(
  new URL('../migrations/0006_public_contract_hardening.sql', import.meta.url),
  'utf8'
);
const undoResultCompatibilityMigration = readFileSync(
  new URL('../migrations/0007_ai_undo_result_compatibility.sql', import.meta.url),
  'utf8'
);

describe('collaboration PostgreSQL migration contract', () => {
  it('contains the immutable revision, tenant, audit, sharing, and idempotency guards', () => {
    expect(migration).toContain('CREATE TABLE organizations');
    expect(migration).toContain('CREATE TABLE memberships');
    expect(migration).toContain('UNIQUE (project_id, sequence)');
    expect(migration).toContain('CREATE TABLE threads');
    expect(migration).toContain('CREATE TABLE comment_reactions');
    expect(migration).toContain('CREATE TABLE approvals');
    expect(migration).toContain('CREATE TABLE share_links');
    expect(migration).toContain('CREATE TABLE audit_events');
    expect(migration).toContain('CREATE TABLE idempotency_keys');
    expect(migration).toContain('CREATE INDEX threads_revision_anchor_idx');
    expect(ownershipMigration).toContain(
      'FOREIGN KEY (project_id, parent_revision_id) REFERENCES revisions(project_id, id)'
    );
    expect(ownershipMigration).toContain(
      'FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, id)'
    );
  });

  it('adds an indexed durable cursor stream for realtime reconnect catch-up', () => {
    expect(realtimeMigration).toContain('CREATE TABLE collaboration_events');
    expect(realtimeMigration).toContain('cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(realtimeMigration).toContain('collaboration_events_project_cursor_idx');
  });

  it('persists versioned review aggregates with project-scoped immutable revisions', () => {
    expect(reviewMigration).toContain('CREATE TABLE review_threads');
    expect(reviewMigration).toContain('CREATE TABLE ai_change_requests');
    expect(reviewMigration).toContain('CREATE TABLE developer_annotations');
    expect(reviewMigration).toContain("lifecycle IN ('open', 'resolved')");
    expect(reviewMigration).toContain(
      'FOREIGN KEY (project_id, revision_id) REFERENCES revisions(project_id, id)'
    );
  });

  it('keeps existing v2 annotation exports compatible while adding auditable undo', () => {
    expect(hardeningMigration).toContain("'undone'");
    expect(hardeningMigration).toContain("jsonb_set(annotation, '{category}'");
  });

  it('preserves legacy undone evidence while adding a compensating undo result', () => {
    expect(undoResultCompatibilityMigration).toContain('UPDATE ai_change_requests');
    expect(undoResultCompatibilityMigration).toContain("'{undoResult}'");
    expect(undoResultCompatibilityMigration).toContain("lifecycle = 'undone'");
  });
});
