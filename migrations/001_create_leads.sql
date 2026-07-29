CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  business_name TEXT,
  time_in_business TEXT,
  budget TEXT,
  marketing_struggle TEXT,
  state TEXT,
  email TEXT NOT NULL,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'submitted'
  notified BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_leads_status_notified ON leads (status, notified, created_at);
