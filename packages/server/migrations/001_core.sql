-- 001: Dalga 1 çekirdek şeması (M0, M1, M3, M5, M6).
-- Kural: durumlar CHECK kısıtlı TEXT; para alanları (Dalga 2) BIGINT cent.
-- Tüm zamanlar TIMESTAMPTZ (UTC).

-- ---- M0: olaylar ve denetim ------------------------------------------------

CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL,
  payload      JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Her tüketici her olayı bir kez işler (olay tekrarında yan etki yok).
CREATE TABLE outbox_consumed (
  consumer     TEXT NOT NULL,
  event_id     BIGINT NOT NULL REFERENCES outbox(id),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE outbox_cursor (
  consumer     TEXT PRIMARY KEY,
  last_id      BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_id     UUID,
  action       TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  data         JSONB NOT NULL DEFAULT '{}',
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- M1: kimlik -----------------------------------------------------------

CREATE TABLE users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT NOT NULL,
  display_name       TEXT NOT NULL,
  password_hash      TEXT NOT NULL,
  country_code       CHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  birth_year         SMALLINT NOT NULL CHECK (birth_year BETWEEN 1900 AND 2100),
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'frozen', 'banned', 'self_excluded')),
  roles              TEXT[] NOT NULL DEFAULT '{player}',
  kyc_level          SMALLINT NOT NULL DEFAULT 0 CHECK (kyc_level BETWEEN 0 AND 3),
  email_verified_at  TIMESTAMPTZ,
  tos_version        TEXT NOT NULL,
  tos_accepted_at    TIMESTAMPTZ NOT NULL,
  locale             TEXT NOT NULL DEFAULT 'tr',
  time_zone          TEXT NOT NULL DEFAULT 'UTC',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_display_name_uq ON users (lower(display_name));

CREATE TABLE devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  device_key   TEXT NOT NULL,
  first_ip     TEXT,
  last_ip      TEXT,
  user_agent   TEXT,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_key)
);
CREATE INDEX devices_key_idx ON devices (device_key);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  family_id     UUID NOT NULL,
  refresh_hash  TEXT NOT NULL UNIQUE,
  device_id     UUID REFERENCES devices(id),
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  rotated_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE email_tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  purpose      TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ
);

-- Gerçek e-posta sağlayıcısı bağlanana kadar (M12) giden postalar buraya yazılır.
CREATE TABLE mail_outbox (
  id           BIGSERIAL PRIMARY KEY,
  to_email     TEXT NOT NULL,
  template     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ
);

-- ---- M3: oyunlar ----------------------------------------------------------

CREATE TABLE games (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             TEXT NOT NULL CHECK (kind IN ('casual', 'bot', 'tournament')),
  match_id         UUID,
  game_no          SMALLINT,
  white_id         UUID REFERENCES users(id),
  black_id         UUID REFERENCES users(id),
  bot_level        TEXT,
  bot_color        CHAR(1) CHECK (bot_color IN ('w', 'b')),
  time_control     TEXT NOT NULL,
  white_initial_ms INTEGER NOT NULL,
  black_initial_ms INTEGER NOT NULL,
  increment_ms     INTEGER NOT NULL,
  armageddon       BOOLEAN NOT NULL DEFAULT false,
  rated            BOOLEAN NOT NULL DEFAULT true,
  paid             BOOLEAN NOT NULL DEFAULT false,
  initial_fen      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'active', 'finished', 'aborted')),
  start_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  -- Son hamleden sonraki saat durumu (kurtarma için).
  white_ms         INTEGER NOT NULL,
  black_ms         INTEGER NOT NULL,
  result           TEXT CHECK (result IN ('1-0', '0-1', '1/2-1/2')),
  end_reason       TEXT,
  winner_color     CHAR(1) CHECK (winner_color IN ('w', 'b')),
  pgn              TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (white_id IS NOT NULL OR bot_color = 'w'),
  CHECK (black_id IS NOT NULL OR bot_color = 'b')
);
CREATE INDEX games_status_idx ON games (status, start_at);
CREATE INDEX games_match_idx ON games (match_id);
CREATE INDEX games_white_idx ON games (white_id);
CREATE INDEX games_black_idx ON games (black_id);

CREATE TABLE moves (
  game_id      UUID NOT NULL REFERENCES games(id),
  ply          SMALLINT NOT NULL CHECK (ply >= 1),
  uci          TEXT NOT NULL,
  san          TEXT NOT NULL,
  think_ms     INTEGER NOT NULL CHECK (think_ms >= 0),   -- hile analizi için kritik
  clock_ms     INTEGER NOT NULL CHECK (clock_ms >= 0),   -- hamleyi yapanın kalan süresi (artış dahil)
  lag_comp_ms  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, ply)
);

-- ---- M6: rating -----------------------------------------------------------

CREATE TABLE user_ratings (
  user_id      UUID NOT NULL REFERENCES users(id),
  pool         TEXT NOT NULL CHECK (pool IN ('bullet', 'blitz', 'rapid', 'classical', 'bot')),
  rating       DOUBLE PRECISION NOT NULL,
  rd           DOUBLE PRECISION NOT NULL,
  volatility   DOUBLE PRECISION NOT NULL,
  games        INTEGER NOT NULL DEFAULT 0,
  peak         DOUBLE PRECISION NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, pool)
);

CREATE TABLE rating_history (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id),
  pool         TEXT NOT NULL,
  game_id      UUID NOT NULL REFERENCES games(id),
  rating_before DOUBLE PRECISION NOT NULL,
  rating_after  DOUBLE PRECISION NOT NULL,
  rd_after      DOUBLE PRECISION NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, game_id)
);

-- ---- M5: turnuvalar -------------------------------------------------------

CREATE TABLE tournament_templates (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('sng', 'scheduled', 'private', 'free')),
  capacity             SMALLINT NOT NULL CHECK (capacity IN (4, 8, 16, 32)),
  entry_fee_cents      BIGINT NOT NULL DEFAULT 0 CHECK (entry_fee_cents >= 0),
  currency             CHAR(3) NOT NULL DEFAULT 'USD',
  rake_bps             INTEGER NOT NULL DEFAULT 0 CHECK (rake_bps BETWEEN 0 AND 3000),
  time_control         TEXT NOT NULL,
  prize_scheme         JSONB NOT NULL DEFAULT '{}',
  rating_min           SMALLINT,
  rating_max           SMALLINT,
  allowed_countries    TEXT[] NOT NULL DEFAULT '{}',
  ready_seconds        INTEGER NOT NULL DEFAULT 90 CHECK (ready_seconds BETWEEN 5 AND 600),
  break_seconds        INTEGER NOT NULL DEFAULT 60 CHECK (break_seconds BETWEEN 0 AND 600),
  active               BOOLEAN NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tournaments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   UUID NOT NULL REFERENCES tournament_templates(id),
  -- Şablon turnuva açıldığı anda dondurulur; sonradan değişiklik bu turnuvayı etkilemez.
  template      JSONB NOT NULL,
  name          TEXT NOT NULL,
  capacity      SMALLINT NOT NULL CHECK (capacity IN (4, 8, 16, 32)),
  status        TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                  'DRAFT', 'OPEN', 'FULL', 'STARTING', 'RUNNING', 'FINISHED',
                  'SETTLING', 'SETTLED', 'DISPUTED', 'CANCELLED', 'ABORTED')),
  starts_at     TIMESTAMPTZ,
  ready_deadline TIMESTAMPTZ,
  seed_hash     TEXT NOT NULL,
  -- Seed başlangıçta açıklanır (commit-reveal). O ana kadar gizli kalır.
  seed_secret   TEXT NOT NULL,
  seed_revealed BOOLEAN NOT NULL DEFAULT false,
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX tournaments_status_idx ON tournaments (status);
-- Bir SNG şablonundan aynı anda tek açık turnuva.
CREATE UNIQUE INDEX tournaments_one_open_per_template ON tournaments (template_id) WHERE status = 'OPEN';

CREATE TABLE tournament_events (
  id             BIGSERIAL PRIMARY KEY,
  tournament_id  UUID NOT NULL REFERENCES tournaments(id),
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  reason         TEXT NOT NULL,
  actor          TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  UUID NOT NULL REFERENCES tournaments(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL CHECK (status IN (
                   'RESERVED', 'CONFIRMED', 'WITHDRAWN', 'REFUNDED', 'ELIMINATED', 'DISQUALIFIED', 'WINNER')),
  seed           SMALLINT,
  final_rank     SMALLINT,
  ready_at       TIMESTAMPTZ,
  device_key     TEXT,
  ip             TEXT,
  payment_id     UUID,
  expires_at     TIMESTAMPTZ,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, user_id)
);
CREATE INDEX entries_user_idx ON entries (user_id);

CREATE TABLE matches (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id  UUID NOT NULL REFERENCES tournaments(id),
  round_no       SMALLINT NOT NULL CHECK (round_no >= 1),
  slot_no        SMALLINT NOT NULL CHECK (slot_no >= 1),
  player_a       UUID REFERENCES users(id),
  player_b       UUID REFERENCES users(id),
  score_a        NUMERIC(3,1) NOT NULL DEFAULT 0,
  score_b        NUMERIC(3,1) NOT NULL DEFAULT 0,
  winner_id      UUID REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING', 'PLAYING', 'DONE', 'WALKOVER', 'VOID')),
  next_match_id  UUID REFERENCES matches(id),
  next_side      CHAR(1) CHECK (next_side IN ('a', 'b')),
  decided_by     TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, round_no, slot_no)
);

ALTER TABLE games ADD CONSTRAINT games_match_fk FOREIGN KEY (match_id) REFERENCES matches(id);
