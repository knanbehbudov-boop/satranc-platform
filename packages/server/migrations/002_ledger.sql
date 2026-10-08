-- 002: M8 çift taraflı defter (doküman 5.6, 9.2, 9.3).
-- Kurallar veritabanında uygulanır; uygulama kodu hata yapsa bile:
--   * her işlemde (ve her para biriminde) borç toplamı = alacak toplamı,
--   * kayıt para birimi = hesap para birimi,
--   * defter satırları güncellenemez ve silinemez (yalnız INSERT),
--   * tutarlar en küçük birimde (cent) pozitif tamsayı.

CREATE TABLE ledger_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,               -- 'TOURNAMENT_POOL:<id>', 'PSP_CLEARING:USD' ...
  type        TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE')),
  currency    CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  owner_user  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT NOT NULL UNIQUE,          -- aynı dış olay iki kez işlenmez
  reason           TEXT NOT NULL CHECK (reason IN (
                     'ENTRY_PAID', 'ENTRY_REFUND', 'PAYMENT_ORPHAN_REFUND', 'PSP_FEE', 'TOURNAMENT_SETTLE',
                     'PRIZE_RELEASE', 'PRIZE_VOID', 'CHARGEBACK', 'PAYOUT', 'PAYOUT_REVERSAL', 'ADJUSTMENT')),
  ref_type         TEXT,
  ref_id           TEXT,
  memo             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_tx_ref_idx ON ledger_transactions (ref_type, ref_id);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES ledger_transactions(id),
  account_id      UUID NOT NULL REFERENCES ledger_accounts(id),
  direction       CHAR(1) NOT NULL CHECK (direction IN ('D', 'C')),
  amount_cents    BIGINT NOT NULL CHECK (amount_cents > 0),
  currency        CHAR(3) NOT NULL
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id);
CREATE INDEX ledger_entries_tx_idx ON ledger_entries (transaction_id);

-- Kayıt para birimi hesabınkiyle aynı olmalı.
CREATE FUNCTION ledger_entry_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency <> (SELECT currency FROM ledger_accounts WHERE id = NEW.account_id) THEN
    RAISE EXCEPTION 'Defter: kayıt para birimi hesapla uyuşmuyor' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_entry_currency BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_currency();

-- İşlem sonunda (COMMIT anında) denge kontrolü.
CREATE FUNCTION ledger_check_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bad RECORD;
BEGIN
  SELECT currency,
         sum(CASE WHEN direction = 'D' THEN amount_cents ELSE 0 END) AS d,
         sum(CASE WHEN direction = 'C' THEN amount_cents ELSE 0 END) AS c
    INTO bad
    FROM ledger_entries WHERE transaction_id = NEW.transaction_id
    GROUP BY currency
    HAVING sum(CASE WHEN direction = 'D' THEN amount_cents ELSE 0 END)
        <> sum(CASE WHEN direction = 'C' THEN amount_cents ELSE 0 END)
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Defter dengesiz: işlem %, % borç % / alacak %', NEW.transaction_id, bad.currency, bad.d, bad.c
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balance AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balance();

-- Kaydı olmayan işlem bırakılamaz.
CREATE FUNCTION ledger_tx_has_entries() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ledger_entries WHERE transaction_id = NEW.id) THEN
    RAISE EXCEPTION 'Defter: kaydı olmayan işlem %', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_tx_entries AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_tx_has_entries();

-- Silme yok, düzeltme var: hatalar ters kayıtla düzeltilir.
CREATE FUNCTION ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Defter kayıtları değiştirilemez ve silinemez (%)', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_tx_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_immutable();
CREATE TRIGGER ledger_tx_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_immutable();

-- Hesap bakiyeleri: varlık/gider için borç−alacak, yükümlülük/gelir için alacak−borç.
CREATE VIEW ledger_balances AS
SELECT a.id, a.code, a.type, a.currency, a.owner_user,
       COALESCE(sum(CASE WHEN e.direction = 'D' THEN e.amount_cents END), 0)::bigint AS debit_cents,
       COALESCE(sum(CASE WHEN e.direction = 'C' THEN e.amount_cents END), 0)::bigint AS credit_cents,
       (CASE WHEN a.type IN ('ASSET', 'EXPENSE')
             THEN COALESCE(sum(CASE WHEN e.direction = 'D' THEN e.amount_cents ELSE -e.amount_cents END), 0)
             ELSE COALESCE(sum(CASE WHEN e.direction = 'C' THEN e.amount_cents ELSE -e.amount_cents END), 0) END)::bigint AS balance_cents
FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
GROUP BY a.id;

-- Günlük mutabakat sonuçları (doküman 5.6).
CREATE TABLE reconciliation_reports (
  id              BIGSERIAL PRIMARY KEY,
  currency        CHAR(3) NOT NULL,
  ledger_cents    BIGINT NOT NULL,
  provider_cents  BIGINT NOT NULL,
  diff_cents      BIGINT NOT NULL,
  unbalanced_tx   INTEGER NOT NULL,
  details         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Turnuva para alanları.
ALTER TABLE tournaments
  ADD COLUMN gross_cents      BIGINT,
  ADD COLUMN rake_cents       BIGINT,
  ADD COLUMN prize_pool_cents BIGINT,
  ADD COLUMN hold_until       TIMESTAMPTZ,
  ADD COLUMN settled_at       TIMESTAMPTZ;

ALTER TABLE entries ADD COLUMN exit_reason TEXT;
