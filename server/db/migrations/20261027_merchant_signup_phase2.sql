-- Pentagon merchant signup phase 2, additive and staging-first.
-- Never alter or assign existing legacy customer credentials or tenant IDs.
CREATE TABLE IF NOT EXISTS public.merchant_signup_requests (
 id BIGSERIAL PRIMARY KEY,
 email TEXT NOT NULL,
 email_fingerprint CHAR(64) UNIQUE NOT NULL,
 company VARCHAR(120) NOT NULL,
 status VARCHAR(20) NOT NULL DEFAULT 'pending',
 consent_at TIMESTAMPTZ NOT NULL,
 source VARCHAR(30) NOT NULL DEFAULT 'landing',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.merchant_signup_requests
 ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS approved_by TEXT,
 ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ;
ALTER TABLE public.merchant_signup_requests DROP CONSTRAINT IF EXISTS merchant_signup_requests_status_check;
ALTER TABLE public.merchant_signup_requests ADD CONSTRAINT merchant_signup_requests_status_check
 CHECK(status IN('pending','reviewing','rejected','invited','active'));
CREATE TABLE IF NOT EXISTS public.merchant_signup_challenges (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES public.merchant_signup_requests(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN('verify_email','set_password')),
 token_hash CHAR(64) NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS merchant_signup_challenges_open_idx
 ON public.merchant_signup_challenges(purpose,request_id,expires_at) WHERE consumed_at IS NULL;
CREATE TABLE IF NOT EXISTS public.merchant_accounts (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id BIGINT NOT NULL UNIQUE REFERENCES public.merchant_signup_requests(id),
 email TEXT NOT NULL UNIQUE,
 tenant TEXT NOT NULL UNIQUE CHECK(tenant ~ '^[a-z][a-z0-9_-]{0,63}$'
  AND tenant !~* '^(demo|test|staging|sandbox|sample)([-_]|$)'),
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'merchant_admin' CHECK(role='merchant_admin'),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','suspended','revoked')),
 email_verified_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_accounts_email_lower_idx ON public.merchant_accounts(lower(email));
CREATE TABLE IF NOT EXISTS public.merchant_signup_rate_limits (
 key_hash CHAR(64) PRIMARY KEY,
 window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 hits INT NOT NULL DEFAULT 1 CHECK(hits>=1),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.merchant_onboarding_jobs (
 id BIGSERIAL PRIMARY KEY,
 account_id UUID NOT NULL REFERENCES public.merchant_accounts(id),
 tenant TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN('telegram_group','merchant_bootstrap')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN('queued','running','retry','done')),
 attempts INT NOT NULL DEFAULT 0,
 next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(account_id,kind)
);
CREATE INDEX IF NOT EXISTS merchant_onboarding_pending_idx ON public.merchant_onboarding_jobs(status,next_run_at);
-- Defense-in-depth: pending applications, hashes and token digests are never
-- accessible from Supabase's anon/authenticated browser roles.
ALTER TABLE public.merchant_signup_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_signup_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_signup_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_onboarding_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.merchant_signup_requests, public.merchant_signup_challenges,
 public.merchant_accounts, public.merchant_signup_rate_limits, public.merchant_onboarding_jobs FROM PUBLIC;
-- Revoke only signup sequences. Existing Pentagon sequences are untouched.
REVOKE ALL ON SEQUENCE public.merchant_signup_requests_id_seq,
 public.merchant_signup_challenges_id_seq,public.merchant_onboarding_jobs_id_seq FROM PUBLIC;
DO $ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
   EXECUTE 'REVOKE ALL ON public.merchant_signup_requests,public.merchant_signup_challenges,public.merchant_accounts,public.merchant_signup_rate_limits,public.merchant_onboarding_jobs FROM anon';
   EXECUTE 'REVOKE ALL ON SEQUENCE public.merchant_signup_requests_id_seq,public.merchant_signup_challenges_id_seq,public.merchant_onboarding_jobs_id_seq FROM anon';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
   EXECUTE 'REVOKE ALL ON public.merchant_signup_requests,public.merchant_signup_challenges,public.merchant_accounts,public.merchant_signup_rate_limits,public.merchant_onboarding_jobs FROM authenticated';
   EXECUTE 'REVOKE ALL ON SEQUENCE public.merchant_signup_requests_id_seq,public.merchant_signup_challenges_id_seq,public.merchant_onboarding_jobs_id_seq FROM authenticated';
 END IF;
END $;
-- No anon or authenticated policies created. Backend uses its own privileged pool.
