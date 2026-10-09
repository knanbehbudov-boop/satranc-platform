import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client, newPlayer, sleep, startTestApp, type TestEnv, uniqueName } from './helpers.ts';
import { ScriptedPlayer } from './scripted-player.ts';

let env: TestEnv;
before(async () => {
  env = await startTestApp({ firstMoveTimeoutMs: 20_000 });
  env.app.tournaments.firstGameDelayMs = 0;
});
after(async () => {
  await env.close();
});

/** Hızlı test şablonu: hazır olma 5 sn, oyunlar arası mola yok. */
async function openTournament(capacity = 4, ready = 5): Promise<string> {
  const code = uniqueName('test').toLowerCase();
  await env.app.pool.query(
    `INSERT INTO tournament_templates (code, name, kind, capacity, time_control, ready_seconds, break_seconds)
     VALUES ($1, $2, 'free', $3, '180+2', $4, 0)`,
    [code, `Test ${code}`, capacity, ready],
  );
  await env.app.tournaments.ensureOpen();
  const r = await env.app.pool.query<{ id: string }>(
    `SELECT t.id FROM tournaments t JOIN tournament_templates p ON p.id = t.template_id WHERE p.code = $1 AND t.status = 'OPEN'`,
    [code],
  );
  return r.rows[0]?.id as string;
}

async function waitStatus(id: string, statuses: string[], timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await env.app.events.settle();
    const d = await env.app.tournaments.detail(id);
    if (statuses.includes(d.status)) return d;
    if (Date.now() > deadline) throw new Error(`Turnuva ${statuses.join('/')} durumuna gelmedi; şu an ${d.status}: ${JSON.stringify(d.matches.map((m: any) => [m.round, m.status, m.games.length]))}`);
    await sleep(100);
  }
}

describe('M5 tam turnuva akışı', () => {
  it('4 kişilik: güçlü olan her maçı tek oyunda kazanır; sıralama, olaylar ve commit-reveal doğru', async () => {
    const id = await openTournament(4);
    const before = await env.app.tournaments.detail(id);
    assert.equal(before.status, 'OPEN');
    assert.equal(before.seed, null, 'seed başlangıçtan önce gizli');
    const seedHash = before.seedHash;

    const strength = new Map<string, number>();
    const players: ScriptedPlayer[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await ScriptedPlayer.create(env.base, (g) => ((strength.get(p.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose'));
      strength.set(p.id, i);
      players.push(p);
    }
    for (const p of players) {
      const r = await p.client.post(`/v1/tournaments/${id}/join`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const done = await waitStatus(id, ['SETTLED']);

    const ranks = new Map(done.entries.map((e: any) => [e.id, e.finalRank]));
    assert.equal(ranks.get(players[3]?.id), 1, 'en güçlü şampiyon');
    assert.equal(ranks.get(players[2]?.id) === 2 || ranks.get(players[2]?.id) === 3, true);
    assert.deepEqual([...ranks.values()].sort(), [1, 2, 3, 3], 'K8: 1, 2, 3, 3');
    for (const m of done.matches) {
      assert.equal(m.status, 'DONE');
      assert.equal(m.games.length, 1, 'her tur tek oyun');
      assert.deepEqual([Number(m.scoreA) + Number(m.scoreB)], [1]);
      assert.equal(m.decidedBy, 'game');
    }

    const events = await env.app.pool.query<{ to_status: string }>('SELECT to_status FROM tournament_events WHERE tournament_id = $1 ORDER BY id', [id]);
    assert.deepEqual(events.rows.map((e) => e.to_status), ['DRAFT', 'OPEN', 'FULL', 'STARTING', 'RUNNING', 'FINISHED', 'SETTLING', 'SETTLED']);

    assert.equal(done.seedHash, seedHash);
    assert.equal(createHash('sha256').update(done.seed).digest('hex'), seedHash, 'açıklanan seed taahhütle eşleşir');
    const v = await new Client(env.base).get(`/v1/tournaments/${id}/verify`);
    assert.equal(v.body.hashMatches, true);
    assert.equal(v.body.orderMatches, true);

    // Turnuva dolunca aynı şablondan yeni bir açık turnuva açıldı.
    const list = await new Client(env.base).get('/v1/tournaments');
    assert.ok(list.body.tournaments.some((t: any) => t.id !== id && t.status === 'OPEN' && t.name === done.name));

    // Turnuva oyunları rating'e işlendi (blitz havuzu).
    const champ = await env.app.ratings.ratingFor(players[3]?.id as string, 'blitz');
    assert.equal(champ.games, 2, 'şampiyon: 2 maç × 1 oyun');
    assert.ok(champ.rating > 1500);
    for (const p of players) p.close();
  });

  it('beraberlik: 1 dakikalık tekrar oyunları renk değişerek biri kazanana kadar sürer', async () => {
    const id = await openTournament(4);
    // İlk oyun ve ilk iki tekrar oyunu berabere; dördüncü oyunu beyaz kazanır.
    const players = await Promise.all(Array.from({ length: 4 }, () => ScriptedPlayer.create(env.base, (g) => (g.gameNo <= 3 ? 'draw' : g.myColor === 'w' ? 'win' : 'lose'))));
    for (const p of players) await p.client.post(`/v1/tournaments/${id}/join`);
    const done = await waitStatus(id, ['SETTLED']);
    for (const m of done.matches) {
      assert.equal(m.decidedBy, 'tiebreak');
      assert.equal(m.games.length, 4);
      const games = [...m.games].sort((x: any, y: any) => x.gameNo - y.gameNo);
      for (let i = 1; i < games.length; i++) {
        assert.equal(games[i].tiebreak, true);
        assert.notEqual(games[i].whiteId, games[i - 1].whiteId, 'her tekrar oyununda renk değişir');
      }
      assert.equal(m.winnerId, games[3].whiteId, 'son oyunu kazanan tur atlar');
      assert.deepEqual([Number(m.scoreA) + Number(m.scoreB)], [4]);
    }
    const g = await env.app.pool.query('SELECT time_control, white_initial_ms, increment_ms, rated FROM games WHERE match_id = $1 AND game_no = 2', [done.matches[0].id]);
    assert.deepEqual(g.rows[0], { time_control: '60+0', white_initial_ms: 60_000, increment_ms: 0, rated: false });
    for (const p of players) p.close();
  });
});

describe('M5 hazır olma (K1, K2)', () => {
  it('yalnız bir oyuncu hazır: rakibi elenir, diğer maç boş kalır, hazır oyuncu oynamadan şampiyon', async () => {
    const id = await openTournament(4, 5);
    const players = await Promise.all(Array.from({ length: 4 }, () => ScriptedPlayer.create(env.base)));
    for (const p of players.slice(1)) p.autoReady = false;
    for (const p of players) await p.client.post(`/v1/tournaments/${id}/join`);
    const done = await waitStatus(id, ['SETTLED'], 20_000);
    const champion = done.entries.find((e: any) => e.finalRank === 1);
    assert.equal(champion.id, players[0]?.id);
    const statuses = done.matches.map((m: any) => m.status).sort();
    assert.deepEqual(statuses, ['VOID', 'WALKOVER', 'WALKOVER'], 'ilk tur: 1 hükmen + 1 boş; final: hükmen');
    assert.ok(done.matches.every((m: any) => m.games.length === 0));
    for (const p of players) p.close();
  });

  it('kimse hazır değilse turnuva iptal edilir', async () => {
    const id = await openTournament(4, 5);
    const players = await Promise.all(Array.from({ length: 4 }, () => ScriptedPlayer.create(env.base)));
    for (const p of players) p.autoReady = false;
    for (const p of players) await p.client.post(`/v1/tournaments/${id}/join`);
    const done = await waitStatus(id, ['CANCELLED'], 20_000);
    assert.equal(done.matches.length, 0);
    for (const p of players) p.close();
  });
});

describe('M5 katılım kuralları', () => {
  it('son koltuğa eşzamanlı 12 istek: yalnız 4 kişi girer', async () => {
    const id = await openTournament(4, 60);
    const players = await Promise.all(Array.from({ length: 12 }, () => newPlayer(env.base)));
    const results = await Promise.all(players.map((p) => p.client.post(`/v1/tournaments/${id}/join`)));
    const ok = results.filter((r) => r.status === 200);
    assert.equal(ok.length, 4);
    for (const r of results.filter((x) => x.status !== 200)) assert.ok(['TOURNAMENT_FULL', 'TOURNAMENT_NOT_OPEN'].includes(r.body.code), r.body.code);
    const n = await env.app.pool.query(`SELECT count(*)::int AS n FROM entries WHERE tournament_id = $1 AND status = 'CONFIRMED'`, [id]);
    assert.equal(n.rows[0]?.n, 4);
  });

  it('doğrulanmamış e-posta, çift katılım, ikinci aktif turnuva, ayrılıp dönme', async () => {
    const a = await openTournament(4, 60);
    const b = await openTournament(4, 60);
    const unverified = new Client(env.base);
    const name = uniqueName();
    await unverified.post('/v1/auth/register', { email: `${name}@ornek.test`, password: 'Kale-Fil-At-2026!', displayName: name, birthDate: '1990-01-01', countryCode: 'DE', acceptTos: true });
    const login = await unverified.post('/v1/auth/login', { email: `${name}@ornek.test`, password: 'Kale-Fil-At-2026!' });
    unverified.token = login.body.accessToken;
    assert.equal((await unverified.post(`/v1/tournaments/${a}/join`)).body.code, 'EMAIL_NOT_VERIFIED');

    const p = await newPlayer(env.base);
    assert.equal((await p.client.post(`/v1/tournaments/${a}/join`)).status, 200);
    assert.equal((await p.client.post(`/v1/tournaments/${a}/join`)).body.code, 'ALREADY_JOINED');
    assert.equal((await p.client.post(`/v1/tournaments/${b}/join`)).body.code, 'ALREADY_IN_TOURNAMENT');
    assert.equal((await p.client.post(`/v1/tournaments/${a}/leave`)).status, 200);
    assert.equal((await p.client.post(`/v1/tournaments/${b}/join`)).status, 200, 'ayrıldıktan sonra başka turnuvaya girebilir');
    assert.equal((await p.client.post(`/v1/tournaments/${b}/leave`)).status, 200);
    assert.equal((await p.client.post(`/v1/tournaments/${a}/join`)).status, 200, 'aynı turnuvaya geri dönebilir');
  });

  it('başladıktan sonra ayrılınamaz', async () => {
    const id = await openTournament(4, 60);
    const ps = await Promise.all(Array.from({ length: 4 }, () => newPlayer(env.base)));
    for (const p of ps) await p.client.post(`/v1/tournaments/${id}/join`);
    const r = await ps[0]?.client.post(`/v1/tournaments/${id}/leave`);
    assert.equal(r?.body.code, 'CANNOT_LEAVE');
  });

  it('çoklu hesap koruması açıkken aynı cihazdan ikinci hesap giremez', async () => {
    env.app.cfg.antiMultiAccount = true;
    try {
      const id = await openTournament(4, 60);
      const p1 = await newPlayer(env.base);
      const p2 = await newPlayer(env.base);
      p2.client.deviceId = p1.client.deviceId;
      assert.equal((await p1.client.post(`/v1/tournaments/${id}/join`)).status, 200);
      const r = await p2.client.post(`/v1/tournaments/${id}/join`);
      assert.equal(r.body.code, 'MULTI_ACCOUNT_BLOCKED');
    } finally {
      env.app.cfg.antiMultiAccount = false;
    }
  });
});

describe('M5 dayanıklılık', () => {
  it('turnuva ortasında sunucu yeniden başlar; turnuva kaldığı yerden tamamlanır', async () => {
    const id = await openTournament(4);
    const strength = new Map<string, number>();
    const players: ScriptedPlayer[] = [];
    let restarted = false;
    for (let i = 0; i < 4; i++) {
      const p = await ScriptedPlayer.create(env.base, (g) => {
        // İlk oyunlarda beklemede kal (sunucu yeniden başlatılırken oyun sürsün), sonra normal oyna.
        if (!restarted) return 'idle';
        return (strength.get(p.id) ?? 0) > (strength.get(g.opponentId) ?? 0) ? 'win' : 'lose';
      });
      strength.set(p.id, i);
      players.push(p);
    }
    for (const p of players) await p.client.post(`/v1/tournaments/${id}/join`);
    await waitStatus(id, ['RUNNING']);
    await sleep(500);
    const live = await env.app.pool.query(`SELECT count(*)::int AS n FROM games g JOIN matches m ON m.id = g.match_id WHERE m.tournament_id = $1 AND g.status = 'active'`, [id]);
    assert.equal(live.rows[0]?.n, 2, 'ilk tur oyunları sürüyor');

    for (const p of players) p.close();
    await env.restart({}, 300);
    env.app.tournaments.firstGameDelayMs = 0;
    restarted = true;
    for (const p of players) await p.connect();
    const done = await waitStatus(id, ['SETTLED'], 40_000);
    assert.equal(done.entries.find((e: any) => e.finalRank === 1)?.id, players[3]?.id);
    for (const p of players) p.close();
  });
});
