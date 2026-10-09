import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { DbError } from '../src/infra/db/pg.ts';
import { ACC } from '../src/modules/ledger/service.ts';
import { DEFAULT_SCHEMES, distribute, holdSecondsFor, schemeFor, splitGross, validateScheme } from '../src/modules/ledger/prizes.ts';
import { newPlayer, startTestApp, type TestEnv } from './helpers.ts';

/** Tohumlu sözde rastgele üreteç (testler tekrarlanabilir). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function ranksFor(capacity: number): Map<string, number> {
  const m = new Map<string, number>();
  const rounds = Math.log2(capacity);
  const ids = Array.from({ length: capacity }, (_, i) => `u${String(i).padStart(2, '0')}`);
  let i = 0;
  m.set(ids[i++] as string, 1);
  for (let r = rounds; r >= 1; r--) {
    const losers = 2 ** (rounds - r);
    for (let k = 0; k < losers; k++) m.set(ids[i++] as string, 2 ** (rounds - r) + 1);
  }
  return m;
}

describe('M8 ödül matematiği', () => {
  it('varsayılan şablonlar %100 eder (doküman 3.9 kontrolü)', () => {
    for (const [cap, s] of Object.entries(DEFAULT_SCHEMES)) validateScheme(s, Number(cap));
  });

  it('K41 örnekleri: sistem %10; 4 kişide birinci %90; 8 ve 16 kişide %70 / %20', () => {
    const s4 = splitGross(500, 4, 1000);
    assert.deepEqual(s4, { grossCents: 2000, rakeCents: 200, poolCents: 1800 });
    assert.deepEqual(distribute(s4.poolCents, schemeFor(4), ranksFor(4)).map((x) => x.cents), [1800]);

    const s8 = splitGross(3000, 8, 1000);
    assert.deepEqual(s8, { grossCents: 24000, rakeCents: 2400, poolCents: 21600 });
    assert.deepEqual(distribute(s8.poolCents, schemeFor(8), ranksFor(8)).map((x) => x.cents), [16800, 4800]);

    const s8b = splitGross(1000, 8, 1000);
    assert.deepEqual(distribute(s8b.poolCents, schemeFor(8), ranksFor(8)).map((x) => x.cents), [5600, 1600], '80$ → 56$ / 16$ / 8$');

    const s16 = splitGross(4000, 16, 1000);
    assert.deepEqual(distribute(s16.poolCents, schemeFor(16), ranksFor(16)).map((x) => x.cents), [44800, 12800]);
  });

  it('ücret tablosundaki her turnuva: birinci ve ikinci tam brütün %70 ve %20si', () => {
    const table: Record<number, number[]> = { 4: [500, 1000, 1500], 8: [1000, 2000, 3000], 16: [2000, 3000, 4000] };
    for (const [cap, fees] of Object.entries(table)) {
      for (const fee of fees) {
        const n = Number(cap);
        const split = splitGross(fee, n, 1000);
        const a = distribute(split.poolCents, schemeFor(n), ranksFor(n)).map((x) => x.cents);
        if (n === 4) assert.deepEqual(a, [fee * n * 0.9]);
        else assert.deepEqual(a, [fee * n * 0.7, fee * n * 0.2], `${n} kişi ${fee}`);
      }
    }
  });

  it('eski baz puanlı özel şablonlar da çalışır', () => {
    const custom = [{ rank: 1, count: 1, bpsEach: 7000 }, { rank: 2, count: 1, bpsEach: 3000 }];
    validateScheme(custom, 4);
    assert.throws(() => validateScheme([{ rank: 1, count: 1, bpsEach: 9000 }], 4));
    assert.throws(() => validateScheme([{ rank: 1, count: 1, share: [7, 9] }], 4));
  });

  it('4/8/16/32 × farklı ücret × farklı komisyon: dağıtılan toplam = havuz, 1 cent bile fark yok', () => {
    let cases = 0;
    for (const cap of [4, 8, 16, 32]) {
      for (const fee of [1, 99, 100, 333, 500, 999, 1000, 2500, 4999, 5000]) {
        for (const bps of [0, 1000, 1200, 1234, 1500, 1800, 3000]) {
          const split = splitGross(fee, cap, bps);
          assert.equal(split.rakeCents + split.poolCents, split.grossCents);
          const awards = distribute(split.poolCents, schemeFor(cap), ranksFor(cap));
          assert.equal(awards.reduce((s, x) => s + x.cents, 0), split.poolCents, `${cap}/${fee}/${bps}`);
          for (const x of awards) assert.ok(Number.isInteger(x.cents) && x.cents >= 0);
          cases++;
        }
      }
    }
    assert.equal(cases, 280);
  });

  it('yuvarlama artığı şampiyona (K4); sahipsiz pay şampiyona (K27)', () => {
    // 8 kişilik: 1001 cent havuz → ikinci floor(1001·2/9)=222, artık şampiyona.
    const a = distribute(1001, schemeFor(8), new Map([['a', 1], ['b', 2]]));
    assert.deepEqual(a.map((x) => [x.userId, x.cents]), [['a', 779], ['b', 222]]);
    // Final oynanmadı (ikinci yok): ikincinin payı şampiyona gider.
    const b = distribute(7200, schemeFor(8), new Map([['c', 1]]));
    assert.deepEqual(b.map((x) => [x.userId, x.cents]), [['c', 7200]]);
  });

  it('bozuk şablon reddedilir', () => {
    assert.throws(() => validateScheme([{ rank: 1, count: 1, bpsEach: 9000 }], 4));
    assert.throws(() => schemeFor(4, [{ rank: 1, count: 1, bpsEach: 6000 }, { rank: 2, count: 1, bpsEach: 3000 }]));
    assert.throws(() => splitGross(1000, 8, 5000));
  });

  it('bekletme süreleri (doküman 5.8)', () => {
    assert.equal(holdSecondsFor(4_999), 12 * 3600);
    assert.equal(holdSecondsFor(5_000), 24 * 3600);
    assert.equal(holdSecondsFor(50_000), 48 * 3600);
  });
});

let env: TestEnv;
before(async () => {
  env = await startTestApp();
});
after(async () => {
  await env.close();
});

describe('M8 defter: veritabanı kuralları', () => {
  it('uygulama dengesiz işlemi yazmaz', async () => {
    await assert.rejects(env.app.ledger.post(env.app.pool, {
      key: randomUUID(), reason: 'ADJUSTMENT', currency: 'USD',
      lines: [{ account: ACC.revenue('USD'), dir: 'D', cents: 100 }, { account: ACC.pspFees('USD'), dir: 'C', cents: 99 }],
    }), /dengesiz/);
  });

  it('uygulamayı atlatıp doğrudan SQL ile dengesiz kayıt da COMMIT anında reddedilir', async () => {
    await assert.rejects(
      env.app.pool.tx(async (tx) => {
        const t = await tx.query<{ id: string }>(`INSERT INTO ledger_transactions (idempotency_key, reason) VALUES ($1, 'ADJUSTMENT') RETURNING id`, [randomUUID()]);
        const a = await tx.query<{ id: string }>(`INSERT INTO ledger_accounts (code, type, currency) VALUES ($1, 'ASSET', 'USD') RETURNING id`, [`TEST:${randomUUID()}`]);
        await tx.query(`INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_cents, currency) VALUES ($1, $2, 'D', 500, 'USD')`, [t.rows[0]?.id, a.rows[0]?.id]);
      }),
      (e: unknown) => e instanceof DbError && /dengesiz/.test(e.message),
    );
  });

  it('defter satırları güncellenemez ve silinemez', async () => {
    const r = await env.app.ledger.post(env.app.pool, {
      key: randomUUID(), reason: 'ADJUSTMENT', currency: 'USD',
      lines: [{ account: ACC.pspClearing('USD'), dir: 'D', cents: 100 }, { account: ACC.revenue('USD'), dir: 'C', cents: 100 }],
    });
    await assert.rejects(env.app.pool.query('UPDATE ledger_entries SET amount_cents = 1 WHERE transaction_id = $1', [r.transactionId]), /değiştirilemez/);
    await assert.rejects(env.app.pool.query('DELETE FROM ledger_entries WHERE transaction_id = $1', [r.transactionId]), /değiştirilemez/);
    await assert.rejects(env.app.pool.query('DELETE FROM ledger_transactions WHERE id = $1', [r.transactionId]), /değiştirilemez/);
    await assert.rejects(env.app.pool.query('TRUNCATE ledger_entries'), /değiştirilemez|truncate/i);
  });

  it('kayıt para birimi hesabınkiyle aynı olmalı; sıfır ve negatif tutar yok', async () => {
    await env.app.ledger.post(env.app.pool, {
      key: randomUUID(), reason: 'ADJUSTMENT', currency: 'EUR',
      lines: [{ account: ACC.pspClearing('EUR'), dir: 'D', cents: 10 }, { account: ACC.revenue('EUR'), dir: 'C', cents: 10 }],
    });
    await assert.rejects(env.app.ledger.post(env.app.pool, {
      key: randomUUID(), reason: 'ADJUSTMENT', currency: 'USD',
      lines: [{ account: ACC.pspClearing('EUR'), dir: 'D', cents: 10 }, { account: ACC.revenue('EUR'), dir: 'C', cents: 10 }],
    }), /para birimi/);
    await assert.rejects(env.app.ledger.post(env.app.pool, {
      key: randomUUID(), reason: 'ADJUSTMENT', currency: 'USD',
      lines: [{ account: ACC.pspClearing('USD'), dir: 'D', cents: -5 }, { account: ACC.revenue('USD'), dir: 'C', cents: -5 }],
    }), /geçersiz/);
  });

  it('aynı idempotency anahtarı ikinci kez hiçbir şey yazmaz (webhook tekrarı)', async () => {
    const key = randomUUID();
    const line = (cents: number) => [{ account: ACC.pspClearing('USD'), dir: 'D' as const, cents }, { account: ACC.revenue('USD'), dir: 'C' as const, cents }];
    const a = await env.app.ledger.post(env.app.pool, { key, reason: 'ADJUSTMENT', currency: 'USD', lines: line(100) });
    const b = await env.app.ledger.post(env.app.pool, { key, reason: 'ADJUSTMENT', currency: 'USD', lines: line(100) });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(a.transactionId, b.transactionId);
    const n = await env.app.pool.query('SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1', [a.transactionId]);
    assert.equal(n.rows[0]?.n, 2);
  });
});

describe('M8 defter: turnuva akışı', () => {
  it('8 ödeme, 1 iade, kapanış, serbest bırakma: emanet sıfırlanır, bakiyeler doğru', async () => {
    const L = env.app.ledger;
    const pool = env.app.pool;
    const tid = randomUUID();
    const players = await Promise.all(Array.from({ length: 9 }, () => newPlayer(env.base)));
    const payments = players.map(() => randomUUID());
    for (let i = 0; i < 9; i++) {
      await L.recordEntryPayment(pool, { paymentId: payments[i] as string, tournamentId: tid, userId: players[i]?.id as string, cents: 1000, feeCents: 59, currency: 'USD' });
    }
    // 9. oyuncu başlamadan ayrıldı: tam iade.
    await L.refundEntry(pool, { paymentId: payments[8] as string, tournamentId: tid, cents: 1000, currency: 'USD' });
    assert.equal(await L.balance(pool, ACC.pool(tid).code), 8000);

    const split = splitGross(1000, 8, 1000);
    const ranks = new Map(players.slice(0, 8).map((p, i) => [p.id, [1, 2, 3, 3, 5, 5, 5, 5][i] as number]));
    const awards = distribute(split.poolCents, schemeFor(8), ranks);
    await L.settleTournament(pool, { tournamentId: tid, currency: 'USD', rakeCents: split.rakeCents, awards });
    assert.equal(await L.balance(pool, ACC.pool(tid).code), 0, 'emanet sıfırlandı');
    const champ = players[0]?.id as string;
    assert.deepEqual(await L.userBalances(champ), [{ currency: 'USD', pendingCents: 5600, availableCents: 0, depositCents: 0, totalCents: 0 }]);
    await L.releasePrize(pool, { tournamentId: tid, userId: champ, cents: 5600, currency: 'USD' });
    await L.releasePrize(pool, { tournamentId: tid, userId: champ, cents: 5600, currency: 'USD' }); // tekrar: etkisiz
    assert.deepEqual(await L.userBalances(champ), [{ currency: 'USD', pendingCents: 0, availableCents: 5600, depositCents: 0, totalCents: 5600 }]);
    const inv = await L.invariants();
    assert.equal(inv.balanced, true);
    assert.equal(inv.negativeUserBalances, 0);
  });

  it('rastgele 300 işlem dizisi: borç = alacak, emanetler negatife düşmez, kapananlar sıfır (property-based)', async () => {
    const L = env.app.ledger;
    const pool = env.app.pool;
    const rand = rng(20261008);
    const tournaments = Array.from({ length: 6 }, () => ({ id: randomUUID(), paid: [] as { pid: string; uid: string }[], settled: false, fee: [100, 500, 1000, 2500][Math.floor(rand() * 4)] as number, rake: [0, 1000, 1200, 1500][Math.floor(rand() * 4)] as number }));
    const users = Array.from({ length: 8 }, () => randomUUID());
    for (const u of users) {
      await pool.query(`INSERT INTO users (id, email, display_name, password_hash, country_code, birth_year, tos_version, tos_accepted_at) VALUES ($1, $2, $3, 'x', 'GB', 1990, 't', now())`, [u, `${u}@x.test`, u.slice(0, 12)]);
    }
    for (let step = 0; step < 300; step++) {
      const t = tournaments[Math.floor(rand() * tournaments.length)] as (typeof tournaments)[number];
      if (t.settled) continue;
      const op = rand();
      if (op < 0.6) {
        const pid = randomUUID();
        const uid = users[Math.floor(rand() * users.length)] as string;
        const fee = Math.round(t.fee * 0.029) + 30;
        await L.recordEntryPayment(pool, { paymentId: pid, tournamentId: t.id, userId: uid, cents: t.fee, feeCents: fee, currency: 'USD' });
        // Webhook tekrarı benzetimi.
        if (rand() < 0.3) await L.recordEntryPayment(pool, { paymentId: pid, tournamentId: t.id, userId: uid, cents: t.fee, feeCents: fee, currency: 'USD' });
        t.paid.push({ pid, uid });
      } else if (op < 0.75 && t.paid.length) {
        const i = Math.floor(rand() * t.paid.length);
        const [p] = t.paid.splice(i, 1);
        await L.refundEntry(pool, { paymentId: p?.pid as string, tournamentId: t.id, cents: t.fee, currency: 'USD' });
      } else if (op < 0.85 && t.paid.length >= 2) {
        const split = splitGross(t.fee, t.paid.length, t.rake);
        const [first, second] = t.paid;
        const awards = first?.uid === second?.uid
          ? [{ userId: first?.uid as string, rank: 1, cents: split.poolCents }]
          : distribute(split.poolCents, schemeFor(4), new Map([[first?.uid as string, 1], [second?.uid as string, 2]]));
        await L.settleTournament(pool, { tournamentId: t.id, currency: 'USD', rakeCents: split.rakeCents, awards });
        t.settled = true;
      }
      if (step % 50 === 0) {
        const inv = await L.invariants();
        assert.equal(inv.balanced, true, `adım ${step}`);
        assert.equal(inv.negativeUserBalances, 0, `adım ${step}`);
      }
    }
    for (const t of tournaments) {
      const bal = await L.balance(pool, ACC.pool(t.id).code);
      if (t.settled) assert.equal(bal, 0);
      else assert.equal(bal, t.paid.length * t.fee);
    }
    const inv = await L.invariants();
    assert.equal(inv.balanced, true);
  });
});
