/**
 * Outbox deseni (plan M0, doküman 9.3): olay, onu doğuran veri değişikliğiyle
 * AYNI işlemde outbox tablosuna yazılır; ayrı bir dağıtıcı olayları tüketicilere
 * iletir. Böylece "veri yazıldı ama olay kayboldu" durumu olmaz.
 *
 * Her tüketici her olayı en fazla bir kez işler: işleyici, tüketildi kaydıyla
 * aynı işlemde çalışır. İşleyici hata verirse işlem geri alınır ve olay tekrar denenir.
 */
import type { Logger } from '../log.ts';
import type { Connection, Pool, Queryable } from '../db/pg.ts';

export interface OutboxEvent<T = Record<string, unknown>> {
  id: number;
  topic: string;
  payload: T;
  createdAt: Date;
}

export interface HandlerHooks {
  /** İşlem başarıyla tamamlandıktan sonra çalışır (bildirimler, yayınlar). */
  afterCommit(fn: () => void | Promise<void>): void;
}

export type EventHandler = (event: OutboxEvent, tx: Connection, hooks: HandlerHooks) => Promise<void>;

export async function publish(q: Queryable, topic: string, payload: Record<string, unknown>): Promise<number> {
  const r = await q.query<{ id: number }>('INSERT INTO outbox (topic, payload) VALUES ($1, $2) RETURNING id', [topic, payload]);
  return (r.rows[0] as { id: number }).id;
}

interface Consumer {
  name: string;
  topics: string[];
  handler: EventHandler;
  failures: number;
  retryAt: number;
}

/**
 * Düşük su işareti için güvenlik payı: daha küçük kimlikli bir olay, daha uzun
 * süren bir işlemle sonradan görünür hale gelebilir. Bu süreden eski olaylar
 * için imleç ilerletilir; işlemler bu süreden kısa tutulur.
 */
const WATERMARK_LAG_SEC = 30;

export class OutboxDispatcher {
  private readonly consumers: Consumer[] = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private pending = false;
  private readonly pool: Pool;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private idleWaiters: (() => void)[] = [];

  constructor(pool: Pool, logger: Logger, intervalMs = 100) {
    this.pool = pool;
    this.logger = logger;
    this.intervalMs = intervalMs;
  }

  subscribe(name: string, topics: string[], handler: EventHandler): void {
    this.consumers.push({ name, topics, handler, failures: 0, retryAt: 0 });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.nudge(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Yeni olay yayınlandığında beklemeden çalıştırmak için. */
  nudge(): void {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    void this.drain().finally(() => {
      this.running = false;
      if (this.pending) {
        this.pending = false;
        this.nudge();
      } else {
        const w = this.idleWaiters;
        this.idleWaiters = [];
        for (const f of w) f();
      }
    });
  }

  /** Testler için: kuyrukta işlenecek olay kalmayana kadar bekler. */
  async settle(maxRounds = 50): Promise<void> {
    for (let i = 0; i < maxRounds; i++) {
      const progressed = await this.drain();
      if (!progressed) return;
    }
  }

  private async drain(): Promise<boolean> {
    let progressed = false;
    for (const c of this.consumers) {
      if (Date.now() < c.retryAt) continue;
      try {
        progressed = (await this.drainConsumer(c)) || progressed;
        c.failures = 0;
      } catch (e) {
        c.failures++;
        c.retryAt = Date.now() + Math.min(30_000, 200 * 2 ** c.failures);
        this.logger.error('Olay tüketicisi hata verdi; tekrar denenecek', { consumer: c.name, failures: c.failures, error: e });
      }
    }
    return progressed;
  }

  private async drainConsumer(c: Consumer): Promise<boolean> {
    const cur = await this.pool.query<{ last_id: number }>(
      `INSERT INTO outbox_cursor (consumer) VALUES ($1)
       ON CONFLICT (consumer) DO UPDATE SET consumer = EXCLUDED.consumer RETURNING last_id`,
      [c.name],
    );
    const lastId = (cur.rows[0] as { last_id: number }).last_id;
    const events = await this.pool.query<{ id: number; topic: string; payload: Record<string, unknown>; created_at: Date }>(
      `SELECT o.id, o.topic, o.payload, o.created_at FROM outbox o
       WHERE o.id > $1 AND o.topic = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM outbox_consumed x WHERE x.consumer = $3 AND x.event_id = o.id)
       ORDER BY o.id LIMIT 100`,
      [lastId, c.topics, c.name],
    );
    for (const row of events.rows) {
      const after: (() => void | Promise<void>)[] = [];
      await this.pool.tx(async (tx) => {
        const claimed = await tx.query(
          'INSERT INTO outbox_consumed (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id',
          [c.name, row.id],
        );
        if (!claimed.rowCount) return; // başka bir düğüm işledi
        await c.handler({ id: row.id, topic: row.topic, payload: row.payload, createdAt: row.created_at }, tx, {
          afterCommit: (fn) => after.push(fn),
        });
      });
      for (const fn of after) {
        try {
          await fn();
        } catch (e) {
          this.logger.error('İşlem sonrası adım hata verdi', { consumer: c.name, eventId: row.id, error: e });
        }
      }
    }
    // Düşük su işaretini ilerlet: belirli süreden eski ve tümü işlenmiş aralık.
    await this.pool.query(
      `UPDATE outbox_cursor SET last_id = GREATEST(last_id, COALESCE((
         SELECT max(o.id) FROM outbox o
         WHERE o.created_at < now() - make_interval(secs => $2)
           AND o.id < COALESCE((
             SELECT min(u.id) FROM outbox u
             WHERE u.id > $3 AND u.topic = ANY($4)
               AND NOT EXISTS (SELECT 1 FROM outbox_consumed x WHERE x.consumer = $1 AND x.event_id = u.id)), 9223372036854775807)
       ), 0)) WHERE consumer = $1`,
      [c.name, WATERMARK_LAG_SEC, lastId, c.topics],
    );
    return events.rows.length > 0;
  }
}
