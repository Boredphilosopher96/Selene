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
const oidcBffMigration = readFileSync(
  new URL('../migrations/0008_oidc_bff_sessions.sql', import.meta.url),
  'utf8'
);
const organizationIdentityAdministrationMigration = readFileSync(
  new URL('../migrations/0009_organization_identity_administration.sql', import.meta.url),
  'utf8'
);
const identityTenantBindingHardeningMigration = readFileSync(
  new URL('../migrations/0010_identity_tenant_binding_hardening.sql', import.meta.url),
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

  it('persists hashed opaque OIDC BFF identifiers with expiry indexes', () => {
    expect(oidcBffMigration).toContain('CREATE TABLE oidc_bff_transactions');
    expect(oidcBffMigration).toContain('id_hash char(64) PRIMARY KEY');
    expect(oidcBffMigration).toContain('oidc_bff_transactions_expiry_idx');
    expect(oidcBffMigration).toContain('CREATE TABLE oidc_bff_sessions');
    expect(oidcBffMigration).toContain('oidc_bff_sessions_expiry_idx');
  });

  it('persists verified domains, SSO policy, group mappings, invitations, and immediate revocation', () => {
    expect(organizationIdentityAdministrationMigration).toContain(
      'CREATE TABLE organization_verified_domains'
    );
    expect(organizationIdentityAdministrationMigration).toContain(
      'CREATE TABLE organization_sso_policies'
    );
    expect(organizationIdentityAdministrationMigration).toContain(
      'CREATE TABLE identity_group_role_mappings'
    );
    expect(organizationIdentityAdministrationMigration).toContain(
      "role IN ('admin', 'editor', 'commenter', 'viewer', 'guest')"
    );
    expect(organizationIdentityAdministrationMigration).toContain(
      'CREATE TABLE organization_invitations'
    );
    expect(organizationIdentityAdministrationMigration).toContain(
      'token_hash char(64) NOT NULL UNIQUE'
    );
    expect(organizationIdentityAdministrationMigration).toContain('ADD COLUMN access_version');
    expect(organizationIdentityAdministrationMigration).toContain(
      'oidc_bff_sessions_access_binding_check'
    );
    expect(organizationIdentityAdministrationMigration).not.toContain(
      'ALTER TABLE oidc_bff_sessions ADD COLUMN access_version integer NOT NULL DEFAULT 1'
    );
    expect(organizationIdentityAdministrationMigration).toContain(
      'CREATE TABLE break_glass_recoveries'
    );
  });

  it('repairs legacy BFF defaults before enforcing paired tenant binding and same-organization users', () => {
    expect(identityTenantBindingHardeningMigration).toContain(
      'ALTER COLUMN access_version DROP DEFAULT'
    );
    expect(identityTenantBindingHardeningMigration).toContain(
      'ALTER COLUMN access_version DROP NOT NULL'
    );
    expect(identityTenantBindingHardeningMigration).toContain(
      'oidc_bff_sessions_access_binding_check'
    );
    expect(identityTenantBindingHardeningMigration).toContain(
      'users_organization_id_id_key UNIQUE (organization_id, id)'
    );
    expect(identityTenantBindingHardeningMigration).toContain('memberships_organization_user_fkey');
    expect(identityTenantBindingHardeningMigration).toContain(
      'break_glass_recoveries_organization_subject_fkey'
    );
    expect(identityTenantBindingHardeningMigration).toContain(
      'organization_invitations_organization_creator_fkey'
    );
    expect(identityTenantBindingHardeningMigration).toContain(
      'organization_invitations_organization_acceptor_fkey'
    );
    expect(identityTenantBindingHardeningMigration).toContain(
      'audit_events_organization_actor_fkey'
    );
    expect(identityTenantBindingHardeningMigration).toContain(
      'organization_invitations_one_pending_email_idx'
    );
  });
});
