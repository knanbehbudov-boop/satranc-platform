-- 010: Seviye belirleme (Elo yerleştirme), dil tercihi ve bölge engeli (K47, K48, K49).

-- K47: yeni oyuncu bota karşı birkaç oyunla seviyesini belirler; sonuç geçici başlangıç rating'i olur.
CREATE TABLE user_placement (
  user_id        UUID PRIMARY KEY REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
  step           SMALLINT NOT NULL DEFAULT 0,
  level_idx      SMALLINT NOT NULL,
  current_game   UUID REFERENCES games(id),
  results        JSONB NOT NULL DEFAULT '[]',
  estimate       INTEGER,
  jump_flagged   BOOLEAN NOT NULL DEFAULT false,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX user_placement_game ON user_placement (current_game) WHERE current_game IS NOT NULL;

-- K48: dil (users.locale 001'de vardı; yalnız desteklenen diller).
UPDATE users SET locale = 'tr' WHERE locale NOT IN ('tr', 'en', 'ru');
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('tr', 'en', 'ru'));

-- K49: bölge engeli için IP aralıkları (resmî bölgesel kayıt verisinden günlük yenilenir).
-- IPv4: adresin tamamı (32 bit); IPv6: ilk 48 bit (tahsisler /48'den büyüktür).
CREATE TABLE geo_ip_ranges (
  family    SMALLINT NOT NULL CHECK (family IN (4, 6)),
  start_ip  BIGINT NOT NULL,
  end_ip    BIGINT NOT NULL,
  country   CHAR(2) NOT NULL,
  PRIMARY KEY (family, start_ip)
);

-- K49: kart ülkesi (sağlayıcının bildirdiği, kartı çıkaran bankanın ülkesi).
ALTER TABLE payments ADD COLUMN card_country CHAR(2);
