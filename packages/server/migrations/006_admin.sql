-- 006: M13 yönetim — dört göz onayları (doküman 16: hassas işlemler iki kişiyle).
CREATE TABLE admin_approvals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action        TEXT NOT NULL CHECK (action IN (
                  'fairplay.decide', 'user.ban', 'user.unban', 'user.unfreeze', 'payment.refund', 'flag.enable')),
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}',
  reason        TEXT NOT NULL CHECK (length(reason) >= 3),
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'EXECUTED', 'REJECTED', 'FAILED')),
  requested_by  UUID NOT NULL REFERENCES users(id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by    UUID REFERENCES users(id),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT,
  result        JSONB,
  -- Dört göz: talep eden kendi talebini onaylayamaz (veritabanı da reddeder).
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
-- Aynı hedef için aynı anda tek bekleyen talep.
CREATE UNIQUE INDEX admin_approvals_one_pending ON admin_approvals (action, target_id) WHERE status = 'PENDING';
CREATE INDEX admin_approvals_status_idx ON admin_approvals (status, requested_at DESC);
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target_type, target_id);
