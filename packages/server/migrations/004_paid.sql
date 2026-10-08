-- 004: Ücretli turnuva — ödüller ve bekletme (doküman 3.9, 5.7, 5.8).

CREATE TABLE prize_awards (
  tournament_id  UUID NOT NULL REFERENCES tournaments(id),
  user_id        UUID NOT NULL REFERENCES users(id),
  rank           SMALLINT NOT NULL,
  cents          BIGINT NOT NULL CHECK (cents > 0),
  currency       CHAR(3) NOT NULL,
  -- PENDING: bekletmede; RELEASED: çekilebilir bakiyeye geçti; VOID: hile kararıyla iptal (K29).
  status         TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RELEASED', 'VOID')),
  hold_until     TIMESTAMPTZ NOT NULL,
  released_at    TIMESTAMPTZ,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX prize_awards_user_idx ON prize_awards (user_id);
CREATE INDEX prize_awards_due_idx ON prize_awards (hold_until) WHERE status = 'PENDING';

CREATE INDEX entries_reserved_idx ON entries (expires_at) WHERE status = 'RESERVED';
CREATE INDEX entries_payment_idx ON entries (payment_id);
