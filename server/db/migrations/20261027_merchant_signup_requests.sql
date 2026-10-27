-- Intake only. Never grants application roles or creates merchant tenants.
CREATE TABLE IF NOT EXISTS merchant_signup_requests (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  email_fingerprint CHAR(64) NOT NULL UNIQUE,
  company VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','reviewing','rejected','invited')),
  consent_at TIMESTAMPTZ NOT NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'landing',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE ALL ON merchant_signup_requests FROM PUBLIC;
CREATE INDEX IF NOT EXISTS merchant_signup_requests_status_created_idx
 ON merchant_signup_requests(status, created_at DESC);
