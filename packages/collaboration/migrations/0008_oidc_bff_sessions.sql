-- OIDC BFF state is durable across service restarts and shared by every
-- instance. Opaque browser values are SHA-256 digests; raw IDs never persist.
CREATE TABLE oidc_bff_transactions (
  id_hash char(64) PRIMARY KEY,
  nonce text NOT NULL,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  return_to text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oidc_bff_transactions_expiry_idx ON oidc_bff_transactions (expires_at);

CREATE TABLE oidc_bff_sessions (
  id_hash char(64) PRIMARY KEY,
  subject text NOT NULL,
  tokens jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX oidc_bff_sessions_expiry_idx ON oidc_bff_sessions (expires_at);
