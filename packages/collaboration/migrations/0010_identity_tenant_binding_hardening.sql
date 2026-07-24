-- Forward-only repair for 0009. Existing unbound BFF sessions received the
-- legacy default access_version=1; clear that synthetic value so a verified
-- first request can bind both fields atomically. A partial bound record cannot
-- be trusted, so revoke and clear it before enforcing the paired invariant.
UPDATE oidc_bff_sessions
SET access_version = NULL
WHERE organization_id IS NULL AND access_version IS NOT NULL;

UPDATE oidc_bff_sessions
SET revoked_at = COALESCE(revoked_at, now()), organization_id = NULL, access_version = NULL
WHERE organization_id IS NOT NULL AND access_version IS NULL;

ALTER TABLE oidc_bff_sessions ALTER COLUMN access_version DROP DEFAULT;
ALTER TABLE oidc_bff_sessions ALTER COLUMN access_version DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'oidc_bff_sessions_access_binding_check'
  ) THEN
    ALTER TABLE oidc_bff_sessions
      ADD CONSTRAINT oidc_bff_sessions_access_binding_check
      CHECK ((organization_id IS NULL) = (access_version IS NULL));
  END IF;
END $$;

-- Selene users are organization-scoped. Repair impossible historical joins
-- before adding composite foreign keys that prevent cross-tenant grants.
DELETE FROM memberships m
USING users u
WHERE m.user_id = u.id AND m.organization_id <> u.organization_id;

DELETE FROM break_glass_recoveries r
USING users u
WHERE r.subject_id = u.id AND r.organization_id <> u.organization_id;

UPDATE organization_verified_domains d
SET verified_by = NULL
FROM users u
WHERE d.verified_by = u.id AND d.organization_id <> u.organization_id;

UPDATE organization_sso_policies p
SET updated_by = NULL
FROM users u
WHERE p.updated_by = u.id AND p.organization_id <> u.organization_id;

UPDATE organization_guest_review_policies p
SET updated_by = NULL
FROM users u
WHERE p.updated_by = u.id AND p.organization_id <> u.organization_id;

UPDATE identity_group_role_mappings m
SET created_by = NULL
FROM users u
WHERE m.created_by = u.id AND m.organization_id <> u.organization_id;

-- Invitations with a foreign creator or acceptor are unsafe credentials; do
-- not preserve a reusable token when repairing an existing deployment.
DELETE FROM organization_invitations i
USING users u
WHERE (i.created_by = u.id AND i.organization_id <> u.organization_id)
   OR (i.accepted_by = u.id AND i.organization_id <> u.organization_id);

UPDATE break_glass_recoveries r
SET created_by = NULL
FROM users u
WHERE r.created_by = u.id AND r.organization_id <> u.organization_id;

UPDATE audit_events a
SET actor_id = NULL
FROM users u
WHERE a.actor_id = u.id AND a.organization_id <> u.organization_id;

ALTER TABLE users ADD CONSTRAINT users_organization_id_id_key UNIQUE (organization_id, id);
ALTER TABLE memberships
  ADD CONSTRAINT memberships_organization_user_fkey
  FOREIGN KEY (organization_id, user_id) REFERENCES users(organization_id, id);
ALTER TABLE break_glass_recoveries
  ADD CONSTRAINT break_glass_recoveries_organization_subject_fkey
  FOREIGN KEY (organization_id, subject_id) REFERENCES users(organization_id, id);
ALTER TABLE organization_verified_domains
  ADD CONSTRAINT organization_verified_domains_organization_verifier_fkey
  FOREIGN KEY (organization_id, verified_by) REFERENCES users(organization_id, id);
ALTER TABLE organization_sso_policies
  ADD CONSTRAINT organization_sso_policies_organization_updater_fkey
  FOREIGN KEY (organization_id, updated_by) REFERENCES users(organization_id, id);
ALTER TABLE organization_guest_review_policies
  ADD CONSTRAINT organization_guest_review_policies_organization_updater_fkey
  FOREIGN KEY (organization_id, updated_by) REFERENCES users(organization_id, id);
ALTER TABLE identity_group_role_mappings
  ADD CONSTRAINT identity_group_role_mappings_organization_creator_fkey
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id);
ALTER TABLE organization_invitations
  ADD CONSTRAINT organization_invitations_organization_creator_fkey
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id);
ALTER TABLE organization_invitations
  ADD CONSTRAINT organization_invitations_organization_acceptor_fkey
  FOREIGN KEY (organization_id, accepted_by) REFERENCES users(organization_id, id);
ALTER TABLE break_glass_recoveries
  ADD CONSTRAINT break_glass_recoveries_organization_creator_fkey
  FOREIGN KEY (organization_id, created_by) REFERENCES users(organization_id, id);
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_organization_actor_fkey
  FOREIGN KEY (organization_id, actor_id) REFERENCES users(organization_id, id);

-- One live invite per organization/email prevents an older privileged token
-- from remaining usable after a replacement invitation is issued.
CREATE UNIQUE INDEX organization_invitations_one_pending_email_idx
  ON organization_invitations (organization_id, email)
  WHERE status = 'pending';
