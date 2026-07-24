-- Enterprise organization administration. Provider protocol verification stays
-- in host adapters; these tables persist only verified identity decisions and
-- opaque/hashed browser credentials.
CREATE TABLE organization_verified_domains (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  domain text NOT NULL,
  verified_at timestamptz NOT NULL,
  verified_by uuid REFERENCES users(id),
  PRIMARY KEY (organization_id, domain),
  UNIQUE (domain),
  CHECK (domain = lower(domain)),
  CHECK (domain !~ '[@*]')
);

CREATE TABLE organization_sso_policies (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  enforcement text NOT NULL CHECK (enforcement IN ('optional', 'required')),
  allowed_providers jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_issuers jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

CREATE TABLE identity_group_role_mappings (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  provider text NOT NULL CHECK (provider IN ('oidc', 'saml')),
  issuer text NOT NULL,
  external_group_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'commenter', 'viewer', 'guest')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  UNIQUE (organization_id, provider, issuer, external_group_id)
);
CREATE INDEX identity_group_role_mappings_active_idx
  ON identity_group_role_mappings (organization_id, provider, issuer, external_group_id)
  WHERE revoked_at IS NULL;

CREATE TABLE organization_guest_review_policies (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id),
  allow_invited_guests boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id)
);

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'commenter', 'viewer', 'guest')),
  token_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  CHECK (email = lower(email)),
  CHECK (
    (status = 'accepted') = (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
  )
);
CREATE INDEX organization_invitations_pending_email_idx
  ON organization_invitations (organization_id, email, expires_at)
  WHERE status = 'pending';

-- Versioned access invalidates pre-deprovision BFF sessions without waiting for
-- their expiry. Session IDs are opaque SHA-256 digests as established in 0008.
ALTER TABLE memberships ADD COLUMN access_version integer NOT NULL DEFAULT 1
  CHECK (access_version > 0);
ALTER TABLE oidc_bff_sessions ADD COLUMN organization_id uuid REFERENCES organizations(id);
-- BFF sessions remain unbound until a verified request selects exactly one
-- organization membership. Bind organization and version atomically together.
ALTER TABLE oidc_bff_sessions ADD COLUMN access_version integer
  CHECK (access_version > 0);
ALTER TABLE oidc_bff_sessions ADD COLUMN revoked_at timestamptz;
ALTER TABLE oidc_bff_sessions
  ADD CONSTRAINT oidc_bff_sessions_access_binding_check
  CHECK ((organization_id IS NULL) = (access_version IS NULL));
CREATE INDEX oidc_bff_sessions_subject_access_idx
  ON oidc_bff_sessions (organization_id, subject, access_version)
  WHERE revoked_at IS NULL;

CREATE TABLE break_glass_recoveries (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  subject_id uuid NOT NULL REFERENCES users(id),
  case_id text NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  CHECK (char_length(trim(case_id)) > 0),
  CHECK (char_length(trim(reason)) >= 20)
);
CREATE INDEX break_glass_recoveries_active_idx
  ON break_glass_recoveries (organization_id, subject_id, expires_at)
  WHERE revoked_at IS NULL;
