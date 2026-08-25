-- D. SANT enquiry store.
-- Apply with:
--   npx wrangler d1 execute formcut-enquiries --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS enquiries (
  id           TEXT PRIMARY KEY,           -- uuid, generated server-side
  created_at   TEXT NOT NULL,              -- ISO-8601 UTC

  name         TEXT NOT NULL,
  company      TEXT NOT NULL,              -- wholesale only, so never empty
  buyer_type   TEXT,
  gstin        TEXT,
  email        TEXT NOT NULL,
  phone        TEXT NOT NULL,

  product      TEXT,
  quantity     INTEGER,
  branding     TEXT,
  message      TEXT,

  -- Operational context, not marketing data. Kept coarse on purpose:
  -- country, not city; no full IP, no user agent fingerprint.
  country      TEXT,

  -- Delivery outcomes, so a failed notification is visible rather than lost.
  owner_notified     INTEGER NOT NULL DEFAULT 0,
  customer_notified  INTEGER NOT NULL DEFAULT 0,

  -- Why a notification failed, when one did. Otherwise the only way to
  -- diagnose a delivery problem is to be tailing logs as it happens.
  notify_error       TEXT
);

-- Newest first is the only read pattern this table has.
CREATE INDEX IF NOT EXISTS idx_enquiries_created_at
  ON enquiries (created_at DESC);

-- Supports the retention sweep and duplicate lookups by sender.
CREATE INDEX IF NOT EXISTS idx_enquiries_email
  ON enquiries (email);
