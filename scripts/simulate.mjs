// Eşzamanlı turnuva simülasyonu (plan M15, madde 1; Faz 0 ölçeği).
// Çok sayıda 4 ve 8 kişilik turnuva aynı anda gerçek sunucu ve veritabanı üzerinde
// oynanır; bazı maçlar bilerek berabere biter (Armageddon). Sonunda doğrulanır:
// her turnuva tamamlandı, tek şampiyon, sıralama doğru, takılı oyun/olay yok, rating tutarlı.
//   node scripts/simulate.mjs [4 kişilik sayı] [8 kişilik sayı]
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { root } from './lib/bundle-core.mjs';

const n4 = Number(process.argv[2] ?? 10);
const n8 = Number(process.argv[3] ?? 4);
const { startTestApp, sleep, uniqueName } = await import(join(root, 'packages/server/test/helpers.ts'));
const { ScriptedPlayer } = await import(join(root, 'packages/server/test/scripted-player.ts'));

const env = await startTestApp({ firstMoveTimeoutMs: 60_000 });
env.app.tournaments.firstGameDelayMs = 0;
const t0 = Date.now();
const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'GEÇTİ ' : 'KALDI '} ${label}`);
  if (!ok) failures.push(label);
};

try {
  const tournaments = [];
  for (const [cap, count] of [[4, n4], [8, n8]]) {
    const code = uniqueName(`sim${cap}`).toLowerCase();
    await env.app.pool.query(
      `INSERT INTO tournament_templates (code, name, kind, capacity, time_control, ready_seconds, break_seconds)
       VALUES ($1, $2, 'free', $3, '180+2', 30, 0)`, [code, `Simülasyon ${cap}`, cap]);
    for (let i = 0; i < count; i++) tournaments.push({ code, cap });
  }

  const players = [];
  const strength = new Map();
  // Oyunun kimliğinden türetilen ortak karar: iki taraf da aynı sonuca varır.
  const drawish = (gameId) => createHash('sha256').update(gameId).digest()[0] % 5 === 0;
  for (const t of tournaments) {
    await env.app.tournaments.ensureOpen();
    const id = (await env.app.pool.query(
      `SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`, [t.code])).rows[0].id;
    t.id = id;
    const group = await Promise.all(Array.from({ length: t.cap }, () => ScriptedPlayer.create(env.base)));
    for (const sp of group) {
      strength.set(sp.id, Math.random());
      sp.strategy = ((p) => (g) => {
        if (g.gameNo <= 2 && drawish(g.gameId)) return 'draw';
        return (strength.get(p.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose';
      })(sp);
      players.push(sp);
    }
    await Promise.all(group.map((p) => p.client.post(`/v1/tournaments/${id}/join`)));
  }
  console.log(`${tournaments.length} turnuva, ${players.length} oyuncu başladı.`);

  const deadline = Date.now() + 240_000;
  for (;;) {
    const r = await env.app.pool.query(`SELECT count(*)::int AS n FROM tournaments WHERE id = ANY($1) AND status <> 'SETTLED'`, [tournaments.map((t) => t.id)]);
    if (r.rows[0].n === 0) break;
    if (Date.now() > deadline) throw new Error(`${r.rows[0].n} turnuva zamanında bitmedi`);
    await sleep(500);
  }
  await env.app.events.settle();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  check(true, `Tüm turnuvalar tamamlandı (${secs} sn)`);

  let armageddons = 0;
  let games = 0;
  for (const t of tournaments) {
    const d = await env.app.tournaments.detail(t.id);
    const ranks = d.entries.map((e) => e.finalRank).sort((a, b) => a - b);
    const expected = t.cap === 4 ? [1, 2, 3, 3] : [1, 2, 3, 3, 5, 5, 5, 5];
    if (JSON.stringify(ranks) !== JSON.stringify(expected)) check(false, `Sıralama hatalı (${t.id}): ${ranks}`);
    for (const m of d.matches) {
      games += m.games.length;
      if (m.decidedBy === 'armageddon') armageddons++;
      if (m.status !== 'DONE') check(false, `Maç kapanmamış: ${m.id} ${m.status}`);
      const winner = m.winnerId === m.a.id ? 'a' : 'b';
      const strongerWins = (strength.get(m.a.id) > strength.get(m.b.id)) === (winner === 'a');
      if (m.decidedBy === 'score' && !strongerWins) check(false, `Güçlü oyuncu kaybetmiş: ${m.id}`);
    }
  }
  check(failures.length === 0, `Her turnuvada tek şampiyon ve doğru sıralama (1, 2, 3, 3[, 5×4])`);
  check(armageddons > 0, `Armageddon'a giden maç sayısı: ${armageddons}`);
  const active = await env.app.pool.query(`SELECT count(*)::int AS n FROM games WHERE status IN ('active', 'scheduled')`);
  check(active.rows[0].n === 0, 'Takılı oyun yok');
  const pending = await env.app.pool.query(
    `SELECT count(*)::int AS n FROM outbox o WHERE o.topic = 'game.ended'
       AND NOT EXISTS (SELECT 1 FROM outbox_consumed c WHERE c.event_id = o.id AND c.consumer = 'tournament')`);
  check(pending.rows[0].n === 0, 'İşlenmemiş oyun sonu olayı yok');
  const rated = await env.app.pool.query(
    `SELECT (SELECT count(*)::int FROM rating_history) AS hist,
            (SELECT count(*)::int FROM games g WHERE g.kind = 'tournament' AND g.rated AND (SELECT count(*) FROM moves mv WHERE mv.game_id = g.id) >= 2) AS ratedGames`);
  check(rated.rows[0].hist === rated.rows[0].ratedgames * 2, `Rating geçmişi tutarlı: ${rated.rows[0].hist} kayıt = 2 × ${rated.rows[0].ratedgames} rated oyun`);
  console.log(`Toplam ${games} oyun oynandı.`);
  for (const p of players) p.close();
} finally {
  await env.close();
}
if (failures.length) {
  console.error(`\n${failures.length} kontrol başarısız.`);
  process.exit(1);
}
console.log('\nSimülasyon başarılı.');
process.exit(0);
