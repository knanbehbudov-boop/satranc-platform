/**
 * M10 Adil oyun (temel). Katmanlar (doküman 14.2):
 *  - Katman 2: oyun sırasında sekme odak telemetrisi (sunucu zaman damgasıyla).
 *  - Katman 3: oyun sonrası analiz (AnalysisService) → açıklanabilir risk skoru (risk.ts).
 *  - Katman 4: hesap bağlantısı (aynı cihaz), davranış (hesap yaşı), kolüzyon işaretleri.
 *  - Katman 5: vaka kuyruğu. Algoritma kalıcı karar vermez (14.4): yalnız vaka açar,
 *    yüksek riskte ödülü bekletir, kritik riskte hesabı GEÇİCİ dondurur. Ödül iptali ve
 *    kalıcı ban insan kararıdır (yönetim paneli, dört göz — Bölüm 10).
 *
 * Ödül kapısı (gate): turnuvanın ücretli oyunlarının analizi bitmeden ödül serbest kalmaz;
 * yüksek/kritik vakası olan oyuncunun ödülü bekletilir, orta riskte bekletme uzar.
 */
import type { Config } from '../../config.ts';
import type { Connection, Pool, Queryable } from '../../infra/db/pg.ts';
import { AppError, conflict, notFound } from '../../infra/errors.ts';
import { publish, type HandlerHooks, type OutboxEvent } from '../../infra/events/outbox.ts';
import type { Logger } from '../../infra/log.ts';
import type { WsHub } from '../../infra/ws/hub.ts';
import type { GameService } from '../game/service.ts';
import type { IdentityService } from '../identity/service.ts';
import { poolFor, type RatingService } from '../rating/service.ts';
import { computeRisk, MODEL_VERSION, type Level, type RiskResult } from './risk.ts';
import type { PlayerSummary } from './stats.ts';

export interface GateDecision {
  /** Analiz bitmedi: bu turda hiçbir ödül serbest bırakılmaz. */
  wait: boolean;
  /** İnsan incelemesi gerekli (turnuva DISPUTED olur). */
  hold: string[] | 'all';
  /** Bekletmesi uzatılan oyuncular (orta risk). */
  delay: string[];
}

const LEVEL_RANK: Record<Level, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const MAX_FOCUS_EVENTS = 300;

export class FairPlayService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly hub: WsHub;
  private readonly games: GameService;
  private readonly identity: IdentityService;
  private readonly ratings: RatingService;
  private readonly focusCount = new Map<string, number>();

  constructor(deps: { pool: Pool; cfg: Config; logger: Logger; hub: WsHub; games: GameService; identity: IdentityService; ratings: RatingService }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.hub = deps.hub;
    this.games = deps.games;
    this.identity = deps.identity;
    this.ratings = deps.ratings;
    this.registerWs();
  }

  // ---- Katman 2: odak telemetrisi ------------------------------------------------

  private registerWs(): void {
    this.hub.on('game.focus', async (_conn, msg, user) => {
      if (!user) return undefined;
      await this.recordFocus(user.id, String(msg.gameId ?? ''), msg.hidden === true);
      return undefined;
    });
  }

  async recordFocus(userId: string, gameId: string, hidden: boolean): Promise<boolean> {
    const seat = this.games.liveSeat(gameId, userId);
    if (!seat) return false; // yalnız oynadığı canlı oyun için
    const key = `${gameId}:${userId}`;
    const n = (this.focusCount.get(key) ?? 0) + 1;
    if (n > MAX_FOCUS_EVENTS) return false; // kötüye kullanım sınırı
    this.focusCount.set(key, n);
    if (this.focusCount.size > 10_000) this.focusCount.clear();
    await this.pool.query(
      'INSERT INTO focus_events (game_id, user_id, hidden, my_turn, ply) VALUES ($1, $2, $3, $4, $5)',
      [gameId, userId, hidden, seat.myTurn, seat.ply],
    );
    return true;
  }

  /** Kendi sırasındayken sekmeden çıkma sayısı ve süresi (çıkış → dönüş arası, sunucu saati). */
  async focusStats(q: Queryable, gameId: string, userId: string): Promise<{ hiddenOnMyTurn: number; hiddenMsOnMyTurn: number; hiddenTotal: number }> {
    const r = await q.query<{ hidden: boolean; my_turn: boolean; at: Date }>(
      'SELECT hidden, my_turn, at FROM focus_events WHERE game_id = $1 AND user_id = $2 ORDER BY at, id',
      [gameId, userId],
    );
    let hiddenOnMyTurn = 0;
    let hiddenMsOnMyTurn = 0;
    let hiddenTotal = 0;
    let openAt: Date | null = null;
    let openMyTurn = false;
    for (const e of r.rows) {
      if (e.hidden && !openAt) {
        openAt = e.at;
        openMyTurn = e.my_turn;
        hiddenTotal++;
        if (e.my_turn) hiddenOnMyTurn++;
      } else if (!e.hidden && openAt) {
        if (openMyTurn) hiddenMsOnMyTurn += e.at.getTime() - openAt.getTime();
        openAt = null;
      }
    }
    return { hiddenOnMyTurn, hiddenMsOnMyTurn, hiddenTotal };
  }

  // ---- Katman 3–4: risk skoru ------------------------------------------------------

  onAnalysisCompleted = async (event: OutboxEvent, tx: Connection, hooks: HandlerHooks): Promise<void> => {
    const { gameId } = event.payload as { gameId: string };
    const notes: (() => void)[] = [];
    await this.scoreGame(tx, gameId, notes);
    hooks.afterCommit(() => {
      for (const n of notes) n();
    });
  };

  /** Analizi kalıcı başarısız olan ücretli oyun: oyuncular insan incelemesine gider. */
  onAnalysisFailed = async (event: OutboxEvent, tx: Connection): Promise<void> => {
    const { gameId } = event.payload as { gameId: string };
    const g = await this.gameInfo(tx, gameId);
    if (!g?.paid) return;
    for (const uid of [g.white_id, g.black_id]) {
      if (uid) await this.upsertCase(tx, uid, g.tournament_id, 'high', 0, ['oyun analizi tamamlanamadı; elle inceleme gerekli'], gameId, []);
    }
  };

  private async gameInfo(q: Queryable, gameId: string) {
    const r = await q.query<{ id: string; white_id: string | null; black_id: string | null; result: string | null; end_reason: string | null; paid: boolean; time_control: string; tournament_id: string | null; plies: number }>(
      `SELECT g.id, g.white_id, g.black_id, g.result, g.end_reason, g.paid, g.time_control, m.tournament_id,
              (SELECT count(*)::int FROM moves x WHERE x.game_id = g.id) AS plies
       FROM games g LEFT JOIN matches m ON m.id = g.match_id WHERE g.id = $1`,
      [gameId],
    );
    return r.rows[0] ?? null;
  }

  async scoreGame(tx: Connection, gameId: string, notes: (() => void)[] = []): Promise<Record<string, RiskResult>> {
    const g = await this.gameInfo(tx, gameId);
    if (!g) return {};
    const ar = await tx.query<{ summary: { players: { white: PlayerSummary; black: PlayerSummary } } }>('SELECT summary FROM analysis_results WHERE game_id = $1', [gameId]);
    const summaries = ar.rows[0]?.summary.players;
    const out: Record<string, RiskResult> = {};
    const pool = poolFor(g.time_control);
    for (const color of ['w', 'b'] as const) {
      const uid = color === 'w' ? g.white_id : g.black_id;
      const opp = color === 'w' ? g.black_id : g.white_id;
      if (!uid) continue;
      const me = await this.ratings.ratingFor(uid, pool);
      const them = opp ? await this.ratings.ratingFor(opp, pool) : me;
      const score = g.result === '1/2-1/2' ? 0.5 : (g.result === '1-0') === (color === 'w') ? 1 : 0;
      const risk = computeRisk({
        summary: summaries ? (color === 'w' ? summaries.white : summaries.black) : null,
        rating: me.rating,
        opponentRating: them.rating,
        score,
        focus: await this.focusStats(tx, gameId, uid),
        link: await this.linkStats(tx, uid),
        behav: await this.behavStats(tx, uid),
        collusion: {
          shortResign: (g.end_reason === 'resign' || g.end_reason === 'abandon') && g.plies < 10,
          repeatPairings: opp ? await this.repeatPairings(tx, uid, opp) : 0,
        },
      });
      out[uid] = risk;
      await tx.query(
        `INSERT INTO risk_scores (game_id, user_id, score, level, components, reasons, model_version) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (game_id, user_id) DO UPDATE SET score = EXCLUDED.score, level = EXCLUDED.level, components = EXCLUDED.components,
           reasons = EXCLUDED.reasons, model_version = EXCLUDED.model_version, created_at = now()`,
        [gameId, uid, risk.score, risk.level, risk.components, JSON.stringify(risk.reasons), MODEL_VERSION],
      );
      if (risk.level !== 'low' && g.paid) {
        await this.upsertCase(tx, uid, g.tournament_id, risk.level, risk.score, risk.reasons, gameId, notes);
      }
    }
    return out;
  }

  private async linkStats(q: Queryable, userId: string): Promise<{ sharedAccounts: number; restrictedShared: number }> {
    const r = await q.query<{ n: number; restricted: number }>(
      `SELECT count(DISTINCT d2.user_id)::int AS n,
              count(DISTINCT d2.user_id) FILTER (WHERE u.status IN ('banned', 'frozen'))::int AS restricted
       FROM devices d1 JOIN devices d2 ON d2.device_key = d1.device_key AND d2.user_id <> d1.user_id
       JOIN users u ON u.id = d2.user_id WHERE d1.user_id = $1`,
      [userId],
    );
    const x = r.rows[0] as { n: number; restricted: number };
    return { sharedAccounts: x.n, restrictedShared: x.restricted };
  }

  private async behavStats(q: Queryable, userId: string): Promise<{ accountAgeHours: number; paidEntries: number }> {
    const r = await q.query<{ age: number; paid: number }>(
      `SELECT extract(epoch FROM now() - u.created_at) / 3600 AS age,
              (SELECT count(*)::int FROM entries e WHERE e.user_id = u.id AND e.payment_id IS NOT NULL) AS paid
       FROM users u WHERE u.id = $1`,
      [userId],
    );
    const x = r.rows[0] as { age: number; paid: number };
    return { accountAgeHours: Number(x.age), paidEntries: x.paid };
  }

  private async repeatPairings(q: Queryable, a: string, b: string): Promise<number> {
    const r = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM games WHERE paid AND status = 'finished' AND ended_at > now() - interval '7 days'
         AND ((white_id = $1 AND black_id = $2) OR (white_id = $2 AND black_id = $1))`,
      [a, b],
    );
    return (r.rows[0] as { n: number }).n;
  }

  // ---- Katman 5: vaka kuyruğu -------------------------------------------------------

  private async upsertCase(tx: Queryable, userId: string, tournamentId: string | null, level: Exclude<Level, 'low'>, score: number, reasons: string[], gameId: string, notes: (() => void)[]): Promise<string> {
    const ex = await tx.query<{ id: string; level: Level }>(
      `SELECT id, level FROM fair_play_cases WHERE user_id = $1 AND tournament_id IS NOT DISTINCT FROM $2 AND status = 'OPEN' FOR UPDATE`,
      [userId, tournamentId],
    );
    let id: string;
    let escalated = false;
    if (ex.rows[0]) {
      id = ex.rows[0].id;
      escalated = LEVEL_RANK[level] > LEVEL_RANK[ex.rows[0].level];
      await tx.query(
        `UPDATE fair_play_cases SET level = CASE WHEN $2 THEN $3 ELSE level END, max_score = GREATEST(max_score, $4),
           reasons = reasons || $5::jsonb, games = CASE WHEN $6 = ANY(games) THEN games ELSE array_append(games, $6::uuid) END, updated_at = now()
         WHERE id = $1`,
        [id, escalated, level, score, JSON.stringify(reasons.map((r) => ({ gameId, reason: r }))), gameId],
      );
    } else {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO fair_play_cases (user_id, tournament_id, level, max_score, reasons, games) VALUES ($1, $2, $3, $4, $5, ARRAY[$6::uuid]) RETURNING id`,
        [userId, tournamentId, level, score, JSON.stringify(reasons.map((r) => ({ gameId, reason: r }))), gameId],
      );
      id = (r.rows[0] as { id: string }).id;
      escalated = true;
    }
    if (escalated) {
      await tx.query(
        `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES (NULL, 'fairplay.case', 'fair_play_case', $1, $2)`,
        [id, { userId, tournamentId, level, score, gameId }],
      );
      await publish(tx, 'fairplay.case', { caseId: id, userId, tournamentId, level });
      // Kritik: hesap GEÇİCİ dondurulur (14.3); kalıcı karar insanındır.
      if (level === 'critical') await this.identity.setStatus(tx, userId, 'frozen', `fairplay:${id}`, null);
      notes.push(() => this.hub.publish('admin', { type: 'fairplay.case', caseId: id, level }));
    }
    return id;
  }

  /** Ödül kapısı (turnuva modülü çağırır). */
  gate = async (q: Queryable, tournamentId: string): Promise<GateDecision> => {
    const jobs = await q.query<{ status: string; white_id: string | null; black_id: string | null }>(
      `SELECT j.status, g.white_id, g.black_id FROM analysis_jobs j JOIN games g ON g.id = j.game_id JOIN matches m ON m.id = g.match_id
       WHERE m.tournament_id = $1`,
      [tournamentId],
    );
    // Analize girmesi gereken ama henüz kuyruğa düşmemiş oyun (olay tüketilmedi) da beklenir.
    const missing = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM games g JOIN matches m ON m.id = g.match_id
       WHERE m.tournament_id = $1 AND g.paid AND g.status = 'finished'
         AND NOT EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.game_id = g.id)`,
      [tournamentId],
    );
    if ((missing.rows[0] as { n: number }).n > 0 || jobs.rows.some((j) => j.status === 'queued' || j.status === 'running')) {
      return { wait: true, hold: [], delay: [] };
    }
    const cases = await q.query<{ user_id: string; level: Level; opened_at: Date }>(
      `SELECT user_id, level, opened_at FROM fair_play_cases WHERE status = 'OPEN' AND (tournament_id = $1 OR tournament_id IS NULL)`,
      [tournamentId],
    );
    const hold = new Set<string>();
    const delay = new Set<string>();
    for (const c of cases.rows) {
      if (c.level === 'high' || c.level === 'critical') hold.add(c.user_id);
      else if (c.opened_at.getTime() + this.cfg.riskMediumExtraHoldSec * 1000 > Date.now()) delay.add(c.user_id);
    }
    return { wait: false, hold: [...hold], delay: [...delay].filter((u) => !hold.has(u)) };
  };

  // ---- okuma (yönetim paneli) -----------------------------------------------------------

  async listCases(status: 'OPEN' | 'CLEARED' | 'CONFIRMED' | 'ALL' = 'OPEN', limit = 100) {
    const r = await this.pool.query<Record<string, unknown>>(
      `SELECT c.*, u.display_name, u.status AS user_status, t.name AS tournament_name
       FROM fair_play_cases c JOIN users u ON u.id = c.user_id LEFT JOIN tournaments t ON t.id = c.tournament_id
       WHERE ($1 = 'ALL' OR c.status = $1)
       ORDER BY CASE c.level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, c.opened_at DESC LIMIT $2`,
      [status, limit],
    );
    return r.rows;
  }

  async caseDetail(caseId: string) {
    const r = await this.pool.query<Record<string, any>>(
      `SELECT c.*, u.display_name, u.status AS user_status, u.created_at AS user_created_at, t.name AS tournament_name, t.status AS tournament_status
       FROM fair_play_cases c JOIN users u ON u.id = c.user_id LEFT JOIN tournaments t ON t.id = c.tournament_id WHERE c.id = $1`,
      [caseId],
    );
    const c = r.rows[0];
    if (!c) throw notFound('CASE_NOT_FOUND', 'Vaka bulunamadı');
    const scores = await this.pool.query(
      `SELECT game_id, score, level, components, reasons, created_at FROM risk_scores WHERE user_id = $1 AND game_id = ANY($2) ORDER BY created_at`,
      [c.user_id, c.games],
    );
    const analyses = await this.pool.query(
      `SELECT game_id, engine, depth, summary FROM analysis_results WHERE game_id = ANY($1)`,
      [c.games],
    );
    const history = await this.pool.query(
      `SELECT id, status, level, max_score, opened_at, decided_at, decision_note FROM fair_play_cases WHERE user_id = $1 AND id <> $2 ORDER BY opened_at DESC LIMIT 20`,
      [c.user_id, caseId],
    );
    return { case: c, riskScores: scores.rows, analyses: analyses.rows, previousCases: history.rows };
  }

  /** Vakayı kapatır (yönetim paneli dört göz onayından sonra çağırır). */
  async closeCase(tx: Queryable, caseId: string, decision: 'clear' | 'confirm', actorId: string, note: string): Promise<{ userId: string; tournamentId: string | null }> {
    const r = await tx.query<{ user_id: string; tournament_id: string | null; status: string }>(
      'SELECT user_id, tournament_id, status FROM fair_play_cases WHERE id = $1 FOR UPDATE',
      [caseId],
    );
    const c = r.rows[0];
    if (!c) throw notFound('CASE_NOT_FOUND', 'Vaka bulunamadı');
    if (c.status !== 'OPEN') throw conflict('CASE_CLOSED', 'Vaka zaten kapatılmış');
    await tx.query(
      `UPDATE fair_play_cases SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4, updated_at = now() WHERE id = $1`,
      [caseId, decision === 'clear' ? 'CLEARED' : 'CONFIRMED', actorId, note],
    );
    await tx.query(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, $2, 'fair_play_case', $3, $4)`,
      [actorId, `fairplay.${decision}`, caseId, { note, userId: c.user_id, tournamentId: c.tournament_id }],
    );
    await publish(tx, 'fairplay.decided', { caseId, decision, userId: c.user_id, tournamentId: c.tournament_id });
    return { userId: c.user_id, tournamentId: c.tournament_id };
  }

  /** Yönetici: herhangi bir oyunu (ör. şikâyet) elle vaka kuyruğuna alır. */
  /**
   * Oyuncu şikayeti (K45). Yalnız bitmiş bir oyunu oynayan, rakibini şikayet edebilir; aynı oyun için
   * bir kez, günde en fazla 5 şikayet. Şikayet bir adil oyun vakasına bağlanır (açık vaka varsa ona
   * eklenir, yoksa "orta" seviyede yeni vaka açılır) ve oyun analiz edilmediyse analize alınır.
   * Algoritma karar vermez: vaka yönetim panelinde insan tarafından sonuçlandırılır.
   */
  async reportPlayer(
    reporterId: string,
    gameId: string,
    input: { category: 'cheating' | 'abuse' | 'other'; text: string; via?: 'form' | 'assistant' },
    enqueueAnalysis?: (q: Queryable, gameId: string) => Promise<unknown>,
  ): Promise<{ complaintId: string; caseId: string }> {
    const text = String(input.text ?? '').trim();
    if (text.length < 3 || text.length > 1000) throw new AppError(400, 'VALIDATION', 'Açıklama 3–1000 karakter olmalı');
    if (!['cheating', 'abuse', 'other'].includes(input.category)) throw new AppError(400, 'VALIDATION', 'Geçersiz şikayet türü');
    return this.pool.tx(async (tx) => {
      const g = (await tx.query<{ id: string; status: string; white_id: string | null; black_id: string | null; match_id: string | null }>(
        'SELECT id, status, white_id, black_id, match_id FROM games WHERE id = $1', [gameId])).rows[0];
      if (!g) throw notFound('GAME_NOT_FOUND', 'Oyun bulunamadı');
      if (g.white_id !== reporterId && g.black_id !== reporterId) throw new AppError(403, 'NOT_A_PLAYER', 'Yalnız oynadığın oyun için şikayette bulunabilirsin');
      if (g.status !== 'finished') throw conflict('GAME_NOT_FINISHED', 'Şikayet oyun bitince yapılabilir');
      const reported = g.white_id === reporterId ? g.black_id : g.white_id;
      if (!reported) throw new AppError(400, 'NO_OPPONENT', 'Bot oyunlarında şikayet yapılamaz');
      const today = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM complaints WHERE reporter_id = $1 AND created_at > now() - interval '1 day'`, [reporterId]);
      if ((today.rows[0] as { n: number }).n >= 5) throw new AppError(429, 'COMPLAINT_LIMIT', 'Günlük şikayet sınırına ulaştın (5)');
      const t = g.match_id ? (await tx.query<{ tournament_id: string }>('SELECT tournament_id FROM matches WHERE id = $1', [g.match_id])).rows[0]?.tournament_id ?? null : null;
      const label = { cheating: 'hile şüphesi', abuse: 'kötü davranış', other: 'diğer' }[input.category];
      const reason = { reason: `oyuncu şikayeti (${label}): ${text.slice(0, 300)}`, reporter: reporterId, game: gameId };
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM fair_play_cases WHERE user_id = $1 AND COALESCE(tournament_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
           AND status = 'OPEN' FOR UPDATE`,
        [reported, t],
      );
      let caseId: string;
      if (open.rows[0]) {
        caseId = open.rows[0].id;
        await tx.query(
          `UPDATE fair_play_cases SET reasons = reasons || $2::jsonb, games = CASE WHEN $3 = ANY(games) THEN games ELSE array_append(games, $3::uuid) END, updated_at = now() WHERE id = $1`,
          [caseId, JSON.stringify([reason]), gameId],
        );
      } else {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO fair_play_cases (user_id, tournament_id, level, max_score, reasons, games, source) VALUES ($1, $2, 'medium', 0, $3, ARRAY[$4::uuid], 'player_report') RETURNING id`,
          [reported, t, JSON.stringify([reason]), gameId],
        );
        caseId = (r.rows[0] as { id: string }).id;
      }
      let complaintId: string;
      try {
        const c = await tx.query<{ id: string }>(
          `INSERT INTO complaints (reporter_id, reported_id, game_id, category, text, via, case_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [reporterId, reported, gameId, input.category, text, input.via ?? 'form', caseId],
        );
        complaintId = (c.rows[0] as { id: string }).id;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('ALREADY_REPORTED', 'Bu oyun için zaten şikayette bulundun');
        throw e;
      }
      if (enqueueAnalysis) await enqueueAnalysis(tx, gameId);
      await tx.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1, 'complaint.create', 'fair_play_case', $2, $3)`,
        [reporterId, caseId, { complaintId, gameId, reported, category: input.category, via: input.via ?? 'form' }]);
      return { complaintId, caseId };
    });
  }

  async openManualCase(userId: string, tournamentId: string | null, actorId: string, note: string): Promise<string> {
    if (!note.trim()) throw new AppError(400, 'VALIDATION', 'Not gerekli');
    return this.pool.tx(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO fair_play_cases (user_id, tournament_id, level, max_score, reasons, source) VALUES ($1, $2, 'high', 0, $3, 'manual')
         ON CONFLICT DO NOTHING RETURNING id`,
        [userId, tournamentId, JSON.stringify([{ reason: `elle açıldı: ${note}` }])],
      );
      if (!r.rows[0]) throw conflict('CASE_EXISTS', 'Bu oyuncu için açık vaka zaten var');
      await tx.query(`INSERT INTO audit_log (actor_id, action, target_type, target_id, data) VALUES ($1::uuid, 'fairplay.manual', 'fair_play_case', $2, $3)`,
        [actorId, r.rows[0].id, { userId, tournamentId, note }]);
      return r.rows[0].id;
    });
  }
}
