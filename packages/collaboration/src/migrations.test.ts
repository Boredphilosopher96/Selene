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
  });

  it('adds an indexed durable cursor stream for realtime reconnect catch-up', () => {
    expect(realtimeMigration).toContain('CREATE TABLE collaboration_events');
    expect(realtimeMigration).toContain('cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY');
    expect(realtimeMigration).toContain('collaboration_events_project_cursor_idx');
  });
});
