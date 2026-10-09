-- 009: Bildirimler (K46): e-posta gönderimi, telefon bildirimi (web push), yeni turnuva duyurusu izni.

-- E-posta kuyruğu gönderim durumu (mail_outbox 001'de vardı; gönderen işçi bu sürümde eklendi).
ALTER TABLE mail_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mail_outbox ADD COLUMN last_error TEXT;
ALTER TABLE mail_outbox ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX mail_outbox_due_idx ON mail_outbox (next_attempt_at) WHERE sent_at IS NULL;

-- Yeni turnuva duyuruları yalnız izin verene (kayıtta kutucuk boş gelir); günde en fazla bir özet.
ALTER TABLE users ADD COLUMN notify_new_tournaments BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN notify_consent_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN last_digest_at TIMESTAMPTZ;

-- Telefon/tarayıcı bildirim abonelikleri (Web Push).
CREATE TABLE push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at  TIMESTAMPTZ,
  failures    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- Sunucunun kendi ürettiği kalıcı anahtarlar (ör. Web Push VAPID anahtarı ortamda verilmezse).
CREATE TABLE app_secrets (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
