// Para simülasyonu (Bölüm 11, doküman 22.4 Prompt 10): çok sayıda ÜCRETLİ turnuva aynı anda,
// gerçek sunucu + PostgreSQL + sandbox ödeme sağlayıcısı (webhook'ların %50'si iki kez gelir) ile.
// Karışıklık bilerek eklenir:
//   - ödemesi reddedilip başka kartla tekrar deneyen oyuncu,
//   - koltuk ayırıp hiç ödemeyen (rezervasyon süresi dolar, koltuk boşalır),
//   - süresi dolduktan sonra eski sekmeden ödeyen (yetim ödeme → otomatik iade),
//   - ödeyip başlamadan ayrılan (emanetten iade),
//   - yönetici iptali (herkese iade), yeniden başlatma sırasında yoldaki iadeler,
//   - hile vakası (dört göz kararıyla ödül iptali → FAIR_PLAY_RESERVE),
//   - hesaplaşmadan sonra ters ibraz (chargeback).
// Sonunda doğrulanır: defter dengeli; her turnuvada komisyon + ödüller = koltuk × ücret; emanetler
// sıfır; geçici hesap sıfır; her başarılı ödeme ya koltukta ya iade edilmiş; mutabakat farkı 0.
//   node scripts/simulate-money.mjs [4 kişilik sayı] [8 kişilik sayı]
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from './lib/bundle-core.mjs';

const n4 = Number(process.argv[2] ?? 8);
const n8 = Number(process.argv[3] ?? 3);
const { startTestApp, sleep, uniqueName, newPlayer, Client } = await import(join(root, 'packages/server/test/helpers.ts'));
const { ScriptedPlayer } = await import(join(root, 'packages/server/test/scripted-player.ts'));
const { splitGross } = await import(join(root, 'packages/server/src/modules/ledger/prizes.ts'));

const env = await startTestApp({
  firstMoveTimeoutMs: 60_000,
  paidMinRatedGames: 0,
  prizeHoldSec: 2,
  seatReservationSec: 3,
  sandboxDeliveryDelayMs: 100,
  sandboxDuplicateRate: 0.5,
  analysisDepth: 2,
  riskMediumExtraHoldSec: 2,
});
env.app.tournaments.firstGameDelayMs = 0;
const app = () => env.app;
const q = async (sql, params = []) => (await app().pool.query(sql, params)).rows;
const t0 = Date.now();
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${label}`);
  if (!ok) failures.push(label);
};
const stats = { declined: 0, abandoned: 0, latePaid: 0, leftAfterPay: 0, cancelled: 0, disputes: 0, voided: 0 };

const FEES = [[500, 1200], [1000, 1500], [333, 1234], [999, 1300], [2500, 1200]];

async function pay(checkoutUrl, card = '4242424242424242') {
  const u = new URL(checkoutUrl, env.base);
  return new Client(env.base).post(`/sandbox-psp/v1/checkout/${u.pathname.split('/').pop()}/pay`, { secret: u.searchParams.get('secret'), card, exp: '12/39', cvc: '123' });
}

async function joinPay(client, tid, opts = {}) {
  for (let i = 0; i < 200; i++) {
    const j = await client.post(`/v1/tournaments/${tid}/join`);
    if (j.status === 200) {
      if (opts.decline) {
        const d = await pay(j.body.checkoutUrl, '4000000000000002');
        if (d.body.status !== 'failed') throw new Error('red bekleniyordu');
        stats.declined++;
      }
      const p = await pay(j.body.checkoutUrl);
      if (p.body.status !== 'succeeded') throw new Error(`ödeme başarısız: ${JSON.stringify(p.body)}`);
      return j.body;
    }
    if (j.body?.code === 'TOURNAMENT_FULL') { await sleep(700); continue; } // rezervasyon süresinin dolmasını bekle
    if (j.body?.code === 'RATE_LIMITED') { await sleep((j.body.details?.retryAfterSec ?? 1) * 1000); continue; }
    throw new Error(`katılım: ${JSON.stringify(j.body)}`);
  }
  throw new Error('koltuk açılmadı');
}

async function quiesce(maxMs = 60_000) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await app().sandbox.deliver();
    await app().payments.processRefunds();
    await app().events.settle();
    const [{ ev }] = await q(`SELECT count(*)::int AS ev FROM psp_sandbox_events WHERE delivered_at IS NULL`);
    const [{ rf }] = await q(`SELECT count(*)::int AS rf FROM refunds WHERE status = 'PENDING'`);
    const [{ aj }] = await q(`SELECT count(*)::int AS aj FROM analysis_jobs WHERE status IN ('queued', 'running')`);
    if (!ev && !rf && !aj) return;
    await sleep(200);
  }
  throw new Error('sistem sakinleşmedi');
}

try {
  // ---- kurulum ----
  const admins = [await newPlayer(env.base), await newPlayer(env.base)];
  await q(`UPDATE users SET roles = '{player,admin}' WHERE id = ANY($1)`, [admins.map((a) => a.id)]);
  const tournaments = [];
  let k = 0;
  for (const [cap, count] of [[4, n4], [8, n8]]) {
    for (let i = 0; i < count; i++) {
      const [fee, rake] = FEES[k++ % FEES.length];
      const code = uniqueName(`para${cap}`).toLowerCase();
      await q(`INSERT INTO tournament_templates (code, name, kind, capacity, entry_fee_cents, currency, rake_bps, time_control, ready_seconds, break_seconds)
               VALUES ($1, $2, 'sng', $3, $4, 'USD', $5, '180+2', 30, 0)`, [code, `Para ${cap}·${fee}`, cap, fee, rake]);
      tournaments.push({ code, cap, fee, rake });
    }
  }
  await app().tournaments.ensureOpen();
  for (const t of tournaments) {
    t.id = (await q(`SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`, [t.code]))[0].id;
  }

  // ---- oyuncular ve karışıklık ----
  const drawish = (gameId) => createHash('sha256').update(gameId).digest()[0] % 5 === 0;
  const strength = new Map();
  const players = [];
  const flagged = tournaments[1];
  const work = tournaments.map(async (t, idx) => {
    const group = await Promise.all(Array.from({ length: t.cap }, () => ScriptedPlayer.create(env.base)));
    group.forEach((sp, i) => {
      strength.set(sp.id, i + Math.random() * 0.5);
      sp.strategy = (g) => (g.gameNo <= 2 && drawish(g.gameId) ? 'draw' : (strength.get(sp.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose');
      players.push(sp);
    });
    t.players = group;
    t.champion = group[group.length - 1];
    if (t === flagged) {
      // Şikâyet üzerine açılmış hile vakası: şampiyonun ödülü insan kararına kalacak.
      t.caseId = await app().fairplay.openManualCase(t.champion.id, t.id, admins[0].id, 'simülasyon: oyuncu şikâyeti');
    }
    const extra = [];
    if (idx % 4 === 0) {
      // Koltuk ayırıp ödemeyen + süresi dolunca eski sekmeden ödeyen.
      const ghost = await newPlayer(env.base);
      const late = await newPlayer(env.base);
      const g = await ghost.client.post(`/v1/tournaments/${t.id}/join`);
      const l = await late.client.post(`/v1/tournaments/${t.id}/join`);
      stats.abandoned++;
      extra.push((async () => {
        await sleep(4000);
        await pay(l.body.checkoutUrl);
        stats.latePaid++;
      })());
      if (g.status !== 200) throw new Error('rezervasyon başarısız');
    }
    if (idx % 4 === 1) {
      // Ödeyip başlamadan ayrılan.
      const leaver = await newPlayer(env.base);
      await joinPay(leaver.client, t.id);
      for (let i = 0; i < 50; i++) {
        const st = await q(`SELECT status FROM entries WHERE tournament_id = $1 AND user_id = $2`, [t.id, leaver.id]);
        if (st[0]?.status === 'CONFIRMED') break;
        await sleep(100);
      }
      const r = await leaver.client.post(`/v1/tournaments/${t.id}/leave`);
      if (!r.body.refund) throw new Error('ayrılan oyuncuya iade yok');
      stats.leftAfterPay++;
    }
    await Promise.all(group.map((p, i) => joinPay(p.client, t.id, { decline: idx % 4 === 2 && i === 0 })));
    await Promise.all(extra);
  });

  // Ayrıca: iki kişi ödedikten sonra yönetici tarafından iptal edilen turnuva.
  const cancelCode = uniqueName('iptal').toLowerCase();
  await q(`INSERT INTO tournament_templates (code, name, kind, capacity, entry_fee_cents, currency, rake_bps, time_control, ready_seconds, break_seconds)
           VALUES ($1, 'İptal edilecek', 'sng', 4, 700, 'USD', 1200, '180+2', 30, 0)`, [cancelCode]);
  await app().tournaments.ensureOpen();
  const cancelId = (await q(`SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`, [cancelCode]))[0].id;
  const c1 = await newPlayer(env.base);
  const c2 = await newPlayer(env.base);
  await joinPay(c1.client, cancelId);
  await joinPay(c2.client, cancelId);

  await Promise.all(work);
  console.log(`${tournaments.length} ücretli turnuva, ${players.length} oyuncu kayıt oldu ve ödedi (${((Date.now() - t0) / 1000).toFixed(1)} sn).`);

  const cancel = await admins[0].client.post(`/v1/admin/tournaments/${cancelId}/cancel`, { reason: 'simülasyon iptali' });
  if (cancel.body.refunds !== 2) throw new Error(`iptal iadesi: ${JSON.stringify(cancel.body)}`);
  stats.cancelled++;

  // ---- turnuvalar biter ----
  const deadline = Date.now() + 300_000;
  for (;;) {
    const r = await q(`SELECT count(*)::int AS n FROM tournaments WHERE id = ANY($1) AND status NOT IN ('SETTLED', 'DISPUTED')`, [tournaments.map((t) => t.id)]);
    if (r[0].n === 0) break;
    if (Date.now() > deadline) throw new Error(`${r[0].n} turnuva zamanında bitmedi`);
    await sleep(500);
  }
  check(true, `Tüm ücretli turnuvalar oynandı ve hesaplaştı (${((Date.now() - t0) / 1000).toFixed(1)} sn)`);

  // ---- hile vakası: dört göz kararıyla ödül iptali ----
  const disputed = await app().tournaments.detail(flagged.id);
  check(disputed.status === 'DISPUTED', `Hile vakası olan turnuva incelemeye alındı (${disputed.status})`);
  const others = disputed.awards.filter((a) => a.id !== flagged.champion.id);
  check(others.every((a) => a.status === 'RELEASED'), 'Aynı turnuvadaki temiz oyuncuların ödülü beklemedi');
  const prop = await admins[0].client.post(`/v1/admin/cases/${flagged.caseId}/propose`, { decision: 'confirm', ban: true, reason: 'simülasyon: ihlal doğrulandı' });
  const self = await admins[0].client.post(`/v1/admin/approvals/${prop.body.approvalId}/approve`, {});
  check(self.body.code === 'FOUR_EYES', 'Öneren yönetici kendi kararını onaylayamadı');
  const ok = await admins[1].client.post(`/v1/admin/approvals/${prop.body.approvalId}/approve`, { note: 'ikinci göz' });
  check(ok.body.status === 'EXECUTED' && ok.body.result.prize === 'voided', 'İkinci yönetici onayladı: ödül iptal, hesap kapatıldı');
  stats.voided++;

  // ---- ters ibraz: iki şampiyonun giriş ödemesi ----
  for (const t of tournaments.filter((x) => x !== flagged).slice(0, 2)) {
    const p = (await q(`SELECT p.provider_ref FROM payments p JOIN entries e ON e.payment_id = p.id WHERE e.tournament_id = $1 AND e.user_id = $2`, [t.id, t.champion.id]))[0];
    await new Client(env.base).post('/sandbox-psp/v1/test/disputes', { intentId: p.provider_ref });
    stats.disputes++;
  }

  // ---- iadeler yoldayken yeniden başlatma ----
  await app().sandbox.deliver();
  await env.restart();
  await quiesce(90_000);
  check(true, 'Sunucu yeniden başlatıldı; yoldaki webhook ve iadeler kaldığı yerden tamamlandı');

  // ---- doğrulama ----
  const inv = await app().ledger.invariants();
  check(inv.balanced, `Defter dengeli (${inv.byCurrency.map((c) => `${c.currency}: borç ${c.debit} = alacak ${c.credit}`).join(', ')})`);
  check(inv.negativeUserBalances === 0, 'Hiçbir yükümlülük hesabı negatif değil');

  let ok2 = true;
  let totalRake = 0;
  for (const t of tournaments) {
    const [row] = await q(`SELECT status, gross_cents, rake_cents, prize_pool_cents FROM tournaments WHERE id = $1`, [t.id]);
    const [{ seated }] = await q(`SELECT count(*)::int AS seated FROM entries WHERE tournament_id = $1 AND seed IS NOT NULL`, [t.id]);
    const split = splitGross(t.fee, seated, t.rake);
    const [{ awarded }] = await q(`SELECT COALESCE(sum(cents), 0)::bigint AS awarded FROM prize_awards WHERE tournament_id = $1`, [t.id]);
    const pool = await app().ledger.balance(app().pool, `TOURNAMENT_POOL:${t.id}`);
    const good = row.status === 'SETTLED' && seated === t.cap && row.gross_cents === split.grossCents && row.rake_cents === split.rakeCents
      && row.rake_cents + awarded === row.gross_cents && pool === 0;
    totalRake += row.rake_cents;
    if (!good) { ok2 = false; console.log('  sorunlu turnuva', t.id, row, { seated, awarded, pool, split }); }
  }
  check(ok2, 'Her turnuvada: koltuk × ücret = brüt; komisyon + ödüller = brüt (1 cent bile fark yok); emanet 0');
  check(await app().ledger.balance(app().pool, `TOURNAMENT_POOL:${cancelId}`) === 0, 'İptal edilen turnuvanın emaneti iade edildi');
  check(await app().ledger.balance(app().pool, 'PLATFORM_REVENUE:USD') === totalRake, `Platform geliri = komisyonların toplamı (${(totalRake / 100).toFixed(2)} USD)`);
  check(await app().ledger.balance(app().pool, 'USER_PAYMENT_IN:USD') === 0, 'Geçici tahsilat hesabı sıfır: her yetim ödeme iade edildi');

  const [pc] = await q(`
    SELECT count(*) FILTER (WHERE status IN ('SUCCEEDED', 'REFUNDED', 'DISPUTED'))::int AS captured,
           count(*) FILTER (WHERE status IN ('SUCCEEDED', 'REFUNDED', 'DISPUTED')
             AND (EXISTS (SELECT 1 FROM ledger_transactions l WHERE l.idempotency_key = 'payment:' || p.id || ':to-pool'))
                 = (EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = p.id AND r.source = 'orphan')))::int AS bad
    FROM payments p`);
  check(pc.bad === 0, `Her başarılı ödeme (${pc.captured}) ya bir koltukta ya yetim iadesinde — ikisi birden ya da hiçbiri değil`);
  const [{ fees }] = await q(`SELECT COALESCE(sum(fee_cents), 0)::bigint AS fees FROM payments WHERE status IN ('SUCCEEDED', 'REFUNDED', 'DISPUTED')`);
  check(await app().ledger.balance(app().pool, 'PSP_FEES:USD') === fees, `Ödeme sağlayıcı ücretleri defterde (${(fees / 100).toFixed(2)} USD)`);
  const [{ voided }] = await q(`SELECT COALESCE(sum(cents), 0)::bigint AS voided FROM prize_awards WHERE status = 'VOID'`);
  check(voided > 0 && await app().ledger.balance(app().pool, 'FAIR_PLAY_RESERVE:USD') === voided, 'İptal edilen ödül FAIR_PLAY_RESERVE hesabında (K29)');
  const [{ cb }] = await q(`SELECT COALESCE(sum(amount_cents), 0)::bigint AS cb FROM payments WHERE status = 'DISPUTED'`);
  check(cb > 0 && await app().ledger.balance(app().pool, 'CHARGEBACKS:USD') === cb, 'Ters ibrazlar gider olarak kaydedildi');
  const [{ wh, dup }] = await q(`SELECT count(*)::int AS wh, (SELECT count(*)::int FROM psp_sandbox_events) AS dup FROM webhook_events`);
  check(wh === dup, `Her sağlayıcı olayı tam bir kez işlendi (${wh} olay; teslimlerin ~%50'si yinelenmişti)`);
  const rep = await app().payments.reconcile('USD');
  check(rep.ok && rep.diffCents === 0, `Mutabakat: defter ${(rep.ledgerCents / 100).toFixed(2)} = sağlayıcı ${(rep.providerCents / 100).toFixed(2)} USD, fark 0`);
  const [{ stuckR }] = await q(`SELECT count(*)::int AS "stuckR" FROM refunds WHERE status <> 'SUCCEEDED'`);
  check(stuckR === 0, 'Takılı iade yok');
  const [{ stuckT }] = await q(`SELECT count(*)::int AS "stuckT" FROM tournaments WHERE status IN ('FULL', 'STARTING', 'RUNNING', 'FINISHED', 'SETTLING', 'DISPUTED') AND id = ANY($1)`, [tournaments.map((t) => t.id)]);
  check(stuckT === 0, 'Takılı turnuva yok');
  const [{ jobs, done }] = await q(`SELECT count(*)::int AS jobs, count(*) FILTER (WHERE status = 'done')::int AS done FROM analysis_jobs`);
  check(jobs > 0 && jobs === done, `Ücretli oyunların hepsi analiz edildi (${done}/${jobs})`);
  console.log('Karışıklık:', JSON.stringify(stats));
  for (const p of players) p.close();
} finally {
  await env.close();
}
if (failures.length) {
  console.error(`\n${failures.length} kontrol başarısız.`);
  process.exit(1);
}
console.log('\nPara simülasyonu başarılı.');
process.exit(0);
