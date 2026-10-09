-- 007: Cüzdan ve para çekme (K43).
--  * Bakiye yükleme: ödeme amacı 'deposit'; para USER_WALLET:<uid>:<cur> hesabına geçer.
--  * Bakiyeden katılım: koltuk ücreti cüzdandan doğrudan turnuva emanetine.
--  * Para çekme: talep → PAYOUTS_PENDING emaneti → yönetici ödeyip işaretler (ya da iade eder).

ALTER TABLE payments DROP CONSTRAINT payments_purpose_check;
ALTER TABLE payments ADD CONSTRAINT payments_purpose_check CHECK (purpose IN ('entry', 'deposit'));

ALTER TABLE ledger_transactions DROP CONSTRAINT ledger_transactions_reason_check;
ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_transactions_reason_check CHECK (reason IN (
  'ENTRY_PAID', 'ENTRY_REFUND', 'PAYMENT_ORPHAN_REFUND', 'PSP_FEE', 'TOURNAMENT_SETTLE',
  'PRIZE_RELEASE', 'PRIZE_VOID', 'CHARGEBACK', 'PAYOUT', 'PAYOUT_REVERSAL', 'ADJUSTMENT',
  'DEPOSIT', 'WALLET_ENTRY', 'WALLET_REFUND', 'PAYOUT_REQUEST'));

-- Koltuğun nasıl ödendiği: kartla (payment_id) ya da cüzdandan (wallet_*).
ALTER TABLE entries ADD COLUMN paid_from TEXT CHECK (paid_from IN ('card', 'wallet'));
ALTER TABLE entries ADD COLUMN wallet_deposit_cents BIGINT NOT NULL DEFAULT 0 CHECK (wallet_deposit_cents >= 0);
ALTER TABLE entries ADD COLUMN wallet_winnings_cents BIGINT NOT NULL DEFAULT 0 CHECK (wallet_winnings_cents >= 0);

-- Hesap kapatma: talep edilince yeni katılım ve yükleme durur; son çekim ödenince hesap kapanır.
ALTER TABLE users ADD COLUMN closing_requested_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN closed_at TIMESTAMPTZ;

CREATE TABLE withdrawals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  amount_cents     BIGINT NOT NULL CHECK (amount_cents > 0),
  -- Tahmini banka/sağlayıcı komisyonu (çekilen tutardan düşülür; platforma ait değildir).
  fee_cents        BIGINT NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  currency         CHAR(3) NOT NULL,
  method           TEXT NOT NULL CHECK (method IN ('ewallet', 'bank')),
  destination      TEXT NOT NULL CHECK (length(destination) BETWEEN 3 AND 120),
  holder_name      TEXT NOT NULL CHECK (length(holder_name) BETWEEN 2 AND 80),
  -- Bakiyenin hangi kısmından alındı (iade edilirse aynı yere döner).
  from_winnings_cents BIGINT NOT NULL DEFAULT 0 CHECK (from_winnings_cents >= 0),
  from_deposit_cents  BIGINT NOT NULL DEFAULT 0 CHECK (from_deposit_cents >= 0),
  account_closure  BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'PAID', 'REJECTED', 'CANCELED')),
  payout_ref       TEXT,
  note             TEXT,
  decided_by       UUID REFERENCES users(id),
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_winnings_cents + from_deposit_cents = amount_cents)
);
CREATE INDEX withdrawals_user_idx ON withdrawals (user_id, created_at DESC);
CREATE INDEX withdrawals_open_idx ON withdrawals (created_at) WHERE status = 'REQUESTED';
-- Bir kullanıcının aynı anda tek açık çekim talebi olur.
CREATE UNIQUE INDEX withdrawals_one_open ON withdrawals (user_id) WHERE status = 'REQUESTED';
