-- 008: Oyun sonu analizi (oyuncuya), şikayet ve satranç asistanı (K45).

-- Oyuncu şikayeti: bir oyuncu, oynadığı bitmiş bir oyundaki rakibini şikayet eder.
-- Şikayet yönetim panelinde adil oyun vakasına bağlanır (karar her zaman insanda).
CREATE TABLE complaints (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  UUID NOT NULL REFERENCES users(id),
  reported_id  UUID NOT NULL REFERENCES users(id),
  game_id      UUID NOT NULL REFERENCES games(id),
  category     TEXT NOT NULL CHECK (category IN ('cheating', 'abuse', 'other')),
  text         TEXT NOT NULL CHECK (length(text) BETWEEN 3 AND 1000),
  via          TEXT NOT NULL DEFAULT 'form' CHECK (via IN ('form', 'assistant')),
  case_id      UUID REFERENCES fair_play_cases(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reporter_id <> reported_id),
  UNIQUE (reporter_id, game_id)
);
CREATE INDEX complaints_reported_idx ON complaints (reported_id, created_at DESC);
CREATE INDEX complaints_reporter_idx ON complaints (reporter_id, created_at DESC);

-- Asistan konuşmaları (koç ve destek). Günlük kullanım sınırı kullanıcı mesajlarından sayılır.
CREATE TABLE assistant_messages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  mode        TEXT NOT NULL CHECK (mode IN ('coach', 'support')),
  game_id     UUID REFERENCES games(id),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_user_idx ON assistant_messages (user_id, created_at DESC);
