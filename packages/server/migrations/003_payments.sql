-- 003: M7 ödeme. Kart verisi bu veritabanına hiç gelmez (PCI kapsamı SAQ A):
-- kart bilgisi yalnız sağlayıcının barındırdığı sayfada girilir; burada yalnız referanslar tutulur.

CREATE TABLE payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  tournament_id    UUID REFERENCES tournaments(id),
  entry_id         UUID REFERENCES entries(id),
  purpose          TEXT NOT NULL DEFAULT 'entry' CHECK (purpose IN ('entry')),
  provider         TEXT NOT NULL,
  provider_ref     TEXT UNIQUE,
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  currency         CHAR(3) NOT NULL,
  fee_cents        BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  status           TEXT NOT NULL DEFAULT 'CREATED'
                   CHECK (status IN ('CREATED', 'SUCCEEDED', 'FAILED', 'REFUNDED', 'DISPUTED', 'CANCELED')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  checkout_url     TEXT,
  failure_reason   TEXT,
  card_last4       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_entry_idx ON payments (entry_id);
CREATE INDEX payments_user_idx ON payments (user_id);

CREATE TABLE refunds (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       UUID NOT NULL REFERENCES payments(id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  -- Para nereden iade ediliyor: turnuva emanetinden mi, koltuğa bağlanmamış geçici hesaptan mı.
  source           TEXT NOT NULL CHECK (source IN ('pool', 'orphan')),
  reason           TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  provider_ref     TEXT UNIQUE,
  idempotency_key  TEXT NOT NULL UNIQUE,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bir ödeme en fazla bir kez iade edilir.
CREATE UNIQUE INDEX refunds_one_per_payment ON refunds (payment_id);

CREATE TABLE webhook_events (
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  PRIMARY KEY (provider, event_id)
);

-- Özellik bayrakları ve "kill switch" (plan M0).
CREATE TABLE feature_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL,
  note        TEXT,
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO feature_flags (key, enabled, note) VALUES ('paid_tournaments', true, 'Ücretli turnuvalar (kapalıyken yeni kayıt ve ödeme alınmaz)');

-- ---- Sandbox ödeme sağlayıcısı (gerçek PSP'nin yerini tutan test servisi) -------------
-- Kendi tablolarında tutulur; uygulama bu tablolara dokunmaz, yalnız API ve webhook üzerinden konuşur.
CREATE TABLE psp_sandbox_intents (
  id               TEXT PRIMARY KEY,
  amount_cents     BIGINT NOT NULL,
  currency         CHAR(3) NOT NULL,
  status           TEXT NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}',
  idempotency_key  TEXT NOT NULL UNIQUE,
  client_secret    TEXT NOT NULL,
  card_last4       TEXT,
  fee_cents        BIGINT NOT NULL DEFAULT 0,
  failure_reason   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE psp_sandbox_refunds (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES psp_sandbox_intents(id),
  amount_cents     BIGINT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE psp_sandbox_disputes (
  id           TEXT PRIMARY KEY,
  intent_id    TEXT NOT NULL UNIQUE REFERENCES psp_sandbox_intents(id),
  amount_cents BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE psp_sandbox_events (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  payload          JSONB NOT NULL,
  delivered_at     TIMESTAMPTZ,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX psp_sandbox_events_due ON psp_sandbox_events (next_attempt_at) WHERE delivered_at IS NULL;
