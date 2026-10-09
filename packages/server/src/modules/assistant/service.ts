/**
 * Satranç asistanı (K45): tek asistan, iki görev.
 *  - Koç: bitmiş bir oyunda hataları açıklar, oyuncuyu geliştirir (oyun analizini bağlam olarak alır).
 *  - Destek ve şikayet: platform kuralları, cüzdan, para çekme; şikayeti alıp vaka olarak iletir.
 *
 * Kurallar (kodda zorunlu, yalnız istemle değil):
 *  - Canlı oyunu olan ya da süren bir turnuvada oynayan kullanıcı asistanı kullanamaz (hile aracı olmasın).
 *  - Koç yalnız kullanıcının oynadığı ve bitmiş oyunlar için çalışır.
 *  - Günlük mesaj sınırı: ücretsiz kullanıcıya az, son 30 günde ücretli turnuva oynayana daha çok.
 *  - Asistan karar vermez; hile tespitinin nasıl çalıştığını açıklamaz; arkasındaki yapay zekânın ya da
 *    analiz motorunun adını söylemez (platformda yalnız bizim adımız geçer, K44).
 *
 * Yapay zekâ sağlayıcısı bir arayüzdür; üretimde ASSISTANT_API_KEY ile bir mesaj API'si kullanılır.
 * Anahtar yoksa asistan kapalıdır ve arayüz bunu söyler.
 */
import type { Config } from '../../config.ts';
import type { Pool } from '../../infra/db/pg.ts';
import { AppError, forbidden, notFound } from '../../infra/errors.ts';
import { isUuid } from '../../infra/http/validate.ts';
import type { Logger } from '../../infra/log.ts';
import type { FairPlayService } from '../fairplay/service.ts';
import type { GameService } from '../game/service.ts';
import type { ReviewService } from '../review/service.ts';
import { WITHDRAWAL_NOTICE_TR } from '../wallet/service.ts';

// ---- sağlayıcı arayüzü ---------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AssistantProvider {
  complete(req: { system: string; messages: ChatMessage[]; tools: ToolDef[]; maxTokens: number }): Promise<{ content: ContentBlock[]; stopReason: string }>;
}

/** Mesaj API'si bağdaştırıcısı (bağımlılıksız, fetch ile). */
export class MessagesApiProvider implements AssistantProvider {
  private readonly o: { apiKey: string; model: string; apiBase: string };

  constructor(o: { apiKey: string; model: string; apiBase: string }) {
    this.o = o;
  }

  async complete(req: { system: string; messages: ChatMessage[]; tools: ToolDef[]; maxTokens: number }) {
    const res = await fetch(`${this.o.apiBase}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.o.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.o.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages, tools: req.tools }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Asistan servisi hata verdi: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { content: ContentBlock[]; stop_reason: string };
    return { content: body.content, stopReason: body.stop_reason };
  }
}

// ---- platform bilgisi (asistanın bildiği kurallar) --------------------------------------

export const PLATFORM_FACTS = `
Platform kuralları (bunları doğru ve kısa anlat; bilmediğin bir şeyi uydurma, "destek ekibine iletebilirim" de):
- Eleme usulü ücretli turnuvalar: 4, 8 ve 16 kişilik; 3, 5 ve 10 dakikalık oyunlar.
- Giriş ücretleri (3 / 5 / 10 dk): 4 kişi 5/10/15 $, 8 kişi 10/20/30 $, 16 kişi 20/30/40 $.
- Sistem payı her turnuvada %10. 4 kişide birinci havuzun tamamını (toplamın %90'ı) alır. 8 ve 16 kişide birinci toplamın %70'ini, ikinci %20'sini alır.
- Kontenjan dolunca turnuva başlar; oyuncular "Hazırım" demelidir, demeyen hükmen elenir.
- Her tur tek oyundur. Berabere biterse 1'er dakikalık tekrar oyunları oynanır; her seferinde renkler değişir ve biri kazanana kadar sürer.
- Cüzdan: bir kerede 20–1000 $ yüklenir; turnuva ücreti bakiyeden düşülür. Başlamadan ayrılan ya da iptal edilen turnuvada para bakiyeye döner.
- Ödüller hile incelemesi için 12–48 saat bekletilir, sonra çekilebilir bakiyeye geçer.
- Para çekme: en az 20 $; e-cüzdan ya da banka havalesi. Talep incelenir ve elle ödenir. ${WITHDRAWAL_NOTICE_TR}
- Hesabını kapatan, 20 $ altında olsa bile bakiyesinin tamamını çekebilir.
- Hile önlemleri vardır; oyunlar oyun bittikten sonra incelenir. Ayrıntılarını ve eşiklerini asla açıklama.
- Şikayet: oyuncu, oynadığı bitmiş bir oyundaki rakibini şikayet edebilir. Şikayet yönetime vaka olarak gider; kararı insanlar verir.
`;

function systemPrompt(mode: 'coach' | 'support', locale: string, gameContext: string | null): string {
  return [
    'Sen bu satranç turnuva platformunun asistanısın. Adın "Satranç Asistanı".',
    'Kimin tarafından geliştirildiğin ya da hangi yapay zekâ modeli/şirketi olduğun sorulursa: platformun kendi asistanı olduğunu söyle; arkadaki teknoloji sağlayıcısının ya da satranç motorunun adını verme. Yapay zekâ olduğunu gizleme.',
    `Kullanıcının dilinde cevap ver (varsayılan: ${locale === 'en' ? 'İngilizce' : locale === 'ru' ? 'Rusça' : 'Türkçe'}). Kısa, sıcak ve net ol; telefonda okunacak.`,
    'Asla bir oyuncunun hile yapıp yapmadığına karar verme ya da tahmin yürütme. Şikayeti alır, iletirsin; "inceleme ekibi değerlendirecek" dersin.',
    'Canlı oyunlar için yardım etme; yalnız bitmiş oyunları konuşursun. Bir pozisyonda ne oynanacağını soran olursa ve bu bitmiş oyunlarından biri değilse yardım etme.',
    mode === 'coach'
      ? 'Görevin KOÇLUK: aşağıdaki bitmiş oyunu oyuncuyla birlikte değerlendir. En önemli 2–3 anı seç, neden hata olduğunu ve daha iyi hamleyi sade dille anlat, oyuncuya çalışabileceği bir öneri ver. Hamle numaralarını kullan.'
      : 'Görevin DESTEK: platform kurallarını, cüzdanı ve para çekmeyi anlat; şikayet etmek isteyen olursa hangi oyun olduğunu ve neden şikayet ettiğini sor, sonra file_complaint aracıyla ilet. Oyunu bilmiyorsa list_recent_games ile son oyunlarını göster.',
    PLATFORM_FACTS,
    gameContext ? `\nDeğerlendirilecek oyun:\n${gameContext}` : '',
  ].join('\n');
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_recent_games',
    description: 'Kullanıcının son bitmiş oyunlarını listeler (şikayet için oyun seçerken).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'file_complaint',
    description: 'Kullanıcının, oynadığı bitmiş bir oyundaki rakibi hakkındaki şikayetini yönetime iletir. Yalnız kullanıcı açıkça şikayet etmek istediğinde ve gerekçesini söylediğinde çağır.',
    input_schema: {
      type: 'object',
      properties: {
        game_id: { type: 'string', description: 'Oyunun kimliği (list_recent_games çıktısından)' },
        category: { type: 'string', enum: ['cheating', 'abuse', 'other'] },
        description: { type: 'string', description: "Kullanıcının kendi ifadesiyle şikayet gerekçesi" },
      },
      required: ['game_id', 'category', 'description'],
      additionalProperties: false,
    },
  },
];

// ---- servis -------------------------------------------------------------------------------

export class AssistantService {
  private readonly pool: Pool;
  private readonly cfg: Config;
  private readonly logger: Logger;
  private readonly games: GameService;
  private readonly fairplay: FairPlayService;
  private readonly reviews: ReviewService;
  private readonly enqueueAnalysis: (q: import('../../infra/db/pg.ts').Queryable, gameId: string) => Promise<unknown>;
  provider: AssistantProvider | null;

  constructor(deps: {
    pool: Pool; cfg: Config; logger: Logger; games: GameService; fairplay: FairPlayService; reviews: ReviewService;
    enqueueAnalysis: (q: import('../../infra/db/pg.ts').Queryable, gameId: string) => Promise<unknown>;
    provider: AssistantProvider | null;
  }) {
    this.pool = deps.pool;
    this.cfg = deps.cfg;
    this.logger = deps.logger;
    this.games = deps.games;
    this.fairplay = deps.fairplay;
    this.reviews = deps.reviews;
    this.enqueueAnalysis = deps.enqueueAnalysis;
    this.provider = deps.provider;
  }

  /** Canlı oyun ya da süren turnuva varsa asistan kilitlidir. */
  private async lockReason(userId: string): Promise<string | null> {
    if (this.games.liveGamesOf(userId).length) return 'LIVE_GAME';
    const r = await this.pool.query(
      `SELECT 1 FROM entries e JOIN tournaments t ON t.id = e.tournament_id
       WHERE e.user_id = $1 AND e.status = 'CONFIRMED' AND t.status IN ('STARTING', 'RUNNING') LIMIT 1`,
      [userId],
    );
    return r.rowCount ? 'ACTIVE_TOURNAMENT' : null;
  }

  private async dailyLimit(userId: string): Promise<number> {
    const r = await this.pool.query(
      `SELECT 1 FROM entries e JOIN tournaments t ON t.id = e.tournament_id
       WHERE e.user_id = $1 AND (t.template->>'entry_fee_cents')::bigint > 0
         AND e.status IN ('CONFIRMED', 'ELIMINATED', 'WINNER') AND e.joined_at > now() - interval '30 days' LIMIT 1`,
      [userId],
    );
    return r.rowCount ? this.cfg.assistantDailyPaid : this.cfg.assistantDailyFree;
  }

  private async usedToday(userId: string): Promise<number> {
    const r = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM assistant_messages WHERE user_id = $1 AND role = 'user' AND created_at > now() - interval '1 day'`,
      [userId],
    );
    return (r.rows[0] as { n: number }).n;
  }

  async status(userId: string) {
    const limit = await this.dailyLimit(userId);
    const used = await this.usedToday(userId);
    const msgs = await this.pool.query<{ role: string; mode: string; game_id: string | null; content: string; created_at: Date }>(
      `SELECT role, mode, game_id, content, created_at FROM assistant_messages WHERE user_id = $1 ORDER BY id DESC LIMIT 30`,
      [userId],
    );
    return {
      enabled: !!this.provider,
      locked: await this.lockReason(userId),
      limit,
      remainingToday: Math.max(0, limit - used),
      messages: msgs.rows.reverse().map((m) => ({ role: m.role, mode: m.mode, gameId: m.game_id, content: m.content, at: m.created_at })),
    };
  }

  async send(userId: string, input: { text: string; gameId?: string | null; locale?: string }) {
    if (!this.provider) throw new AppError(503, 'ASSISTANT_DISABLED', 'Asistan şu anda kullanılamıyor');
    const text = String(input.text ?? '').trim();
    if (text.length < 1 || text.length > 2000) throw new AppError(400, 'VALIDATION', 'Mesaj 1–2000 karakter olmalı');
    const lock = await this.lockReason(userId);
    if (lock) throw new AppError(409, 'ASSISTANT_LOCKED', 'Oyun ya da turnuva sürerken asistan kapalıdır; bitince tekrar dene');
    const limit = await this.dailyLimit(userId);
    if ((await this.usedToday(userId)) >= limit) throw new AppError(429, 'ASSISTANT_LIMIT', `Bugünkü soru hakkın doldu (${limit})`);

    const gameId = input.gameId && isUuid(input.gameId) ? input.gameId : null;
    const mode: 'coach' | 'support' = gameId ? 'coach' : 'support';
    const context = gameId ? await this.gameContext(userId, gameId) : null;
    const locale = input.locale && ['tr', 'en', 'ru'].includes(input.locale) ? input.locale : 'tr';

    const history = await this.pool.query<{ role: 'user' | 'assistant'; content: string }>(
      `SELECT role, content FROM (
         SELECT id, role, content FROM assistant_messages WHERE user_id = $1 AND mode = $2 AND game_id IS NOT DISTINCT FROM $3::uuid
         ORDER BY id DESC LIMIT 10) x ORDER BY id`,
      [userId, mode, gameId],
    );
    const messages: ChatMessage[] = history.rows.map((h) => ({ role: h.role, content: h.content }));
    // Konuşma kullanıcıyla başlamalı ve roller sırayla gelmeli.
    while (messages[0]?.role === 'assistant') messages.shift();
    messages.push({ role: 'user', content: text });

    await this.pool.query(`INSERT INTO assistant_messages (user_id, role, mode, game_id, content) VALUES ($1, 'user', $2, $3, $4)`, [userId, mode, gameId, text]);
    const system = systemPrompt(mode, locale, context);
    const tools = mode === 'support' ? TOOLS : [];
    let reply = '';
    const actions: { type: string; complaintId?: string }[] = [];
    for (let round = 0; round < 4; round++) {
      let res;
      try {
        res = await this.provider.complete({ system, messages, tools, maxTokens: 900 });
      } catch (e) {
        this.logger.error('Asistan servisi hatası', { error: e });
        throw new AppError(502, 'ASSISTANT_UNAVAILABLE', 'Asistan şu anda cevap veremiyor; biraz sonra tekrar dene');
      }
      const texts = res.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text);
      if (texts.length) reply = texts.join('\n').trim();
      const uses = res.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use');
      if (res.stopReason !== 'tool_use' || !uses.length) break;
      messages.push({ role: 'assistant', content: res.content });
      const results: ContentBlock[] = [];
      for (const u of uses) {
        const out = await this.runTool(userId, u.name, u.input, actions);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: out.content, ...(out.error ? { is_error: true } : {}) });
      }
      messages.push({ role: 'user', content: results });
    }
    if (!reply) reply = 'Üzgünüm, şu anda cevap veremedim. Biraz sonra tekrar dener misin?';
    await this.pool.query(`INSERT INTO assistant_messages (user_id, role, mode, game_id, content) VALUES ($1, 'assistant', $2, $3, $4)`, [userId, mode, gameId, reply]);
    return { reply, mode, actions, remainingToday: Math.max(0, limit - (await this.usedToday(userId))) };
  }

  private async runTool(userId: string, name: string, input: Record<string, unknown>, actions: { type: string; complaintId?: string }[]): Promise<{ content: string; error?: boolean }> {
    try {
      if (name === 'list_recent_games') {
        const r = await this.pool.query<{ id: string; ended_at: Date; result: string; white_id: string | null; black_id: string | null; wn: string | null; bn: string | null; kind: string }>(
          `SELECT g.id, g.ended_at, g.result, g.white_id, g.black_id, g.kind, w.display_name AS wn, b.display_name AS bn
           FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
           WHERE (g.white_id = $1 OR g.black_id = $1) AND g.status = 'finished' AND g.kind <> 'bot'
           ORDER BY g.ended_at DESC NULLS LAST LIMIT 10`,
          [userId],
        );
        if (!r.rows.length) return { content: 'Kullanıcının şikayet edilebilecek bitmiş bir oyunu yok.' };
        return {
          content: r.rows.map((g) => {
            const me = g.white_id === userId ? 'beyaz' : 'siyah';
            const opp = g.white_id === userId ? g.bn : g.wn;
            return `game_id=${g.id} · rakip ${opp ?? '?'} · kullanıcı ${me} · sonuç ${g.result} · ${g.ended_at?.toISOString().slice(0, 16).replace('T', ' ')}`;
          }).join('\n'),
        };
      }
      if (name === 'file_complaint') {
        const gameId = String(input.game_id ?? '');
        if (!isUuid(gameId)) return { content: 'Geçersiz oyun kimliği.', error: true };
        const category = (['cheating', 'abuse', 'other'].includes(String(input.category)) ? String(input.category) : 'other') as 'cheating' | 'abuse' | 'other';
        const r = await this.fairplay.reportPlayer(userId, gameId, { category, text: String(input.description ?? ''), via: 'assistant' }, this.enqueueAnalysis);
        actions.push({ type: 'complaint', complaintId: r.complaintId });
        return { content: 'Şikayet yönetime iletildi. İnceleme ekibi değerlendirecek; karar insanlar tarafından verilir.' };
      }
      return { content: `Bilinmeyen araç: ${name}`, error: true };
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), error: true };
    }
  }

  /** Koç için oyun bağlamı: oyuncular, sonuç, hamleler; analiz hazırsa sınıflar ve daha iyi hamleler. */
  private async gameContext(userId: string, gameId: string): Promise<string> {
    const g = (await this.pool.query<{ id: string; status: string; white_id: string | null; black_id: string | null; result: string | null; end_reason: string | null; time_control: string; wn: string | null; bn: string | null; bot_level: string | null }>(
      `SELECT g.id, g.status, g.white_id, g.black_id, g.result, g.end_reason, g.time_control, g.bot_level, w.display_name AS wn, b.display_name AS bn
       FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id WHERE g.id = $1`,
      [gameId],
    )).rows[0];
    if (!g) throw notFound('GAME_NOT_FOUND', 'Oyun bulunamadı');
    if (g.white_id !== userId && g.black_id !== userId) throw forbidden('NOT_A_PLAYER', 'Yalnız kendi oyunlarını değerlendirebilirsin');
    if (g.status !== 'finished') throw new AppError(409, 'GAME_NOT_FINISHED', 'Koç yalnız bitmiş oyunlarda çalışır');
    const me = g.white_id === userId ? 'beyaz' : 'siyah';
    const lines = [
      `Beyaz: ${g.wn ?? `bot (${g.bot_level})`} · Siyah: ${g.bn ?? `bot (${g.bot_level})`} · Kullanıcı: ${me} · Süre: ${g.time_control} · Sonuç: ${g.result} (${g.end_reason ?? ''})`,
    ];
    const rv = await this.reviews.review(userId, gameId);
    if (rv.status === 'ready') {
      const p = (rv as import('../review/service.ts').Review).players;
      lines.push(`Doğruluk: beyaz %${p.white.accuracy ?? '-'}, siyah %${p.black.accuracy ?? '-'}`);
      const CLS = { best: 'en iyi', good: 'iyi', inaccuracy: 'küçük hata', mistake: 'hata', blunder: 'büyük hata' } as const;
      lines.push('Hamleler (numara, renk, oynanan, sınıf, daha iyisi):');
      for (const m of (rv as import('../review/service.ts').Review).moves) {
        const no = `${Math.ceil(m.ply / 2)}${m.color === 'w' ? '.' : '...'}`;
        lines.push(`${no} ${m.san} — ${CLS[m.class]}${m.bestSan ? ` (daha iyisi: ${m.bestSan})` : ''}`);
      }
    } else {
      const mv = await this.pool.query<{ ply: number; san: string }>('SELECT ply, san FROM moves WHERE game_id = $1 ORDER BY ply', [gameId]);
      lines.push('Ayrıntılı analiz henüz yok (oyuncu oyun sayfasından "Analiz et" diyebilir). Hamleler:');
      lines.push(mv.rows.map((m) => `${m.ply % 2 ? `${Math.ceil(m.ply / 2)}. ` : ''}${m.san}`).join(' '));
    }
    return lines.join('\n');
  }
}
