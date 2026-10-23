CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  role          TEXT NOT NULL DEFAULT 'scanner' CHECK (role IN ('admin', 'scanner')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One dispatch = one RTO handover (one POD) being checked.
CREATE TABLE dispatches (
  id           UUID PRIMARY KEY,                       -- generated on the phone so it can be created offline
  name         TEXT NOT NULL,
  courier      TEXT,
  dispatch_ref TEXT,                                   -- courier's Dispatch ID, from the POD
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reconciled', 'closed')),
  notes        TEXT,
  pod_meta     JSONB NOT NULL DEFAULT '[]',
  created_by   INT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at    TIMESTAMPTZ
);
CREATE INDEX dispatches_created_idx ON dispatches (created_at DESC);

-- One row per shipment (each counted once).
CREATE TABLE scans (
  id               UUID PRIMARY KEY,
  dispatch_id      UUID NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  awb              TEXT NOT NULL,
  first_scanned_at TIMESTAMPTZ NOT NULL,
  source           TEXT NOT NULL DEFAULT 'camera',
  scanned_by       INT REFERENCES users(id),
  times_scanned    INT NOT NULL DEFAULT 1,
  UNIQUE (dispatch_id, awb)
);
CREATE INDEX scans_awb_idx ON scans (awb);

-- Every single read, kept as an audit trail. id is created on the phone, so a retried upload never double counts.
CREATE TABLE scan_events (
  id          UUID PRIMARY KEY,
  dispatch_id UUID NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  scan_id     UUID REFERENCES scans(id) ON DELETE SET NULL,
  awb_read    TEXT NOT NULL,
  scanned_at  TIMESTAMPTZ NOT NULL,
  source      TEXT NOT NULL DEFAULT 'camera',
  scanned_by  INT REFERENCES users(id),
  is_repeat   BOOLEAN NOT NULL DEFAULT FALSE,
  removed     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scan_events_dispatch_idx ON scan_events (dispatch_id);

CREATE TABLE pod_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  position    INT NOT NULL,
  no          INT,
  page        INT,
  company     TEXT,
  service     TEXT,
  header      TEXT,
  declared    INT,
  include     BOOLEAN NOT NULL DEFAULT FALSE,
  manual      BOOLEAN NOT NULL DEFAULT FALSE,
  label       TEXT
);
CREATE INDEX pod_sections_dispatch_idx ON pod_sections (dispatch_id);

CREATE TABLE pod_rows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id  UUID NOT NULL REFERENCES pod_sections(id) ON DELETE CASCADE,
  dispatch_id UUID NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  position    INT NOT NULL,
  page        INT,
  serial      INT,
  awb         TEXT NOT NULL DEFAULT '',
  partial     BOOLEAN NOT NULL DEFAULT FALSE,
  mark        TEXT NOT NULL DEFAULT '' CHECK (mark IN ('', 'X', 'D'))
);
CREATE INDEX pod_rows_dispatch_idx ON pod_rows (dispatch_id);
CREATE INDEX pod_rows_awb_idx ON pod_rows (awb);

-- Saved results (a snapshot each time someone presses "Save result").
CREATE TABLE reconciliations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id UUID NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary     JSONB NOT NULL,
  result      JSONB NOT NULL
);
CREATE INDEX reconciliations_dispatch_idx ON reconciliations (dispatch_id, created_at DESC);

INSERT INTO settings (key, value) VALUES
  ('company_name', 'Pokonut'),
  ('company_addr', '1st Floor, #67, Akshaya Gardens Mahaveer Road 1st C Cross, Near Growing Miracle School Akshaynagar, Bangalore, Karnataka, Pincode 560076'),
  ('ignore_prefixes', 'OD'),
  ('gemini_model', 'gemini-3.8-flash');
