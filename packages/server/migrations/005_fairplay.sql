-- 005: M4b oyun analizi ve M10 adil oyun (doküman 12.4, 14.2–14.5).

CREATE TABLE analysis_jobs (
  game_id       UUID PRIMARY KEY REFERENCES games(id),
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  priority      SMALLINT NOT NULL DEFAULT 0,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  requested_by  TEXT NOT NULL DEFAULT 'system',
  locked_until  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ
);
CREATE INDEX analysis_jobs_queue_idx ON analysis_jobs (priority DESC, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE analysis_results (
  game_id     UUID PRIMARY KEY REFERENCES games(id),
  engine      TEXT NOT NULL,          -- sürüm sabitlenir (doküman 12.5)
  depth       INTEGER NOT NULL,
  multipv     INTEGER NOT NULL,
  summary     JSONB NOT NULL,         -- oyuncu başına özet (doküman 12.4 örnek JSON)
  moves       JSONB NOT NULL,         -- hamle başına ayrıntı
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Katman 2: sekme/pencere odak telemetrisi. Zaman damgası sunucudadır.
CREATE TABLE focus_events (
  id        BIGSERIAL PRIMARY KEY,
  game_id   UUID NOT NULL REFERENCES games(id),
  user_id   UUID NOT NULL REFERENCES users(id),
  hidden    BOOLEAN NOT NULL,
  my_turn   BOOLEAN NOT NULL,
  ply       SMALLINT NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX focus_events_game_idx ON focus_events (game_id, user_id, at);

CREATE TABLE risk_scores (
  game_id        UUID NOT NULL REFERENCES games(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  score          NUMERIC(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  level          TEXT NOT NULL CHECK (level IN ('low', 'medium', 'high', 'critical')),
  components     JSONB NOT NULL,
  reasons        JSONB NOT NULL,
  model_version  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, user_id)
);
CREATE INDEX risk_scores_user_idx ON risk_scores (user_id, created_at DESC);

-- Vaka kuyruğu: algoritma yalnız vaka açar; kalıcı karar insan (ve dört göz) ile verilir (14.4).
CREATE TABLE fair_play_cases (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id),
  tournament_id      UUID REFERENCES tournaments(id),
  status             TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLEARED', 'CONFIRMED')),
  level              TEXT NOT NULL CHECK (level IN ('medium', 'high', 'critical')),
  max_score          NUMERIC(4,3) NOT NULL,
  reasons            JSONB NOT NULL DEFAULT '[]',
  games              UUID[] NOT NULL DEFAULT '{}',
  source             TEXT NOT NULL DEFAULT 'risk_model',
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  proposed_by        UUID REFERENCES users(id),
  proposed_decision  TEXT CHECK (proposed_decision IN ('clear', 'confirm')),
  proposed_note      TEXT,
  proposed_at        TIMESTAMPTZ,
  decided_by         UUID REFERENCES users(id),
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT
);
CREATE UNIQUE INDEX fair_play_cases_one_open ON fair_play_cases (user_id, COALESCE(tournament_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'OPEN';
CREATE INDEX fair_play_cases_status_idx ON fair_play_cases (status, level, opened_at);
