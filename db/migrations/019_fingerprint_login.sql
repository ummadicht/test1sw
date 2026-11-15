-- PostgreSQL migration for Biometric & Fingerprint Scanner Login
CREATE TABLE IF NOT EXISTS fingerprint_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  scanner_type TEXT NOT NULL,
  scanner_model TEXT NOT NULL,
  finger_label TEXT NOT NULL,
  template_hash TEXT NOT NULL,
  public_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_fingerprint_credentials_user_id ON fingerprint_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_fingerprint_credentials_username ON fingerprint_credentials(username);
