import type { DB, RequestRow } from './db.js';
import { renderBackInStockEmail } from './email.js';
import { log, maskEmail } from './log.js';
import type { ResendClient, SendResult } from './resend.js';
import { StockApiError, type StockClient, type StockInfo } from './stock.js';

export interface NotifierOptions {
  emailFrom: string;
  shopUrl: string;
  sweepIntervalMs: number;
  staleSendingMs: number;
  retryBaseMs: number;
  maxAttempts: number;
  stockFreshMs: number;
  /** How many SKUs to work on at once. Sends within a SKU are sequential. */
  concurrency?: number;
  /** Test seam: called after the provider accepted, before we record it. Throw to simulate a crash. */
  afterProviderAccepted?: (row: RequestRow) => void;
}

export const idempotencyKey = (requestId: string) => `back-in-stock/${requestId}`;

const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Background worker that turns pending requests into exactly one email each.
 *
 *  claim (pending -> sending, atomic UPDATE)  ->  send with Idempotency-Key
 *    2xx           -> notified
 *    5xx/timeout   -> pending + backoff (same key next time)
 *    4xx           -> failed
 *
 * Nothing in here holds state that matters across a restart: the database
 * is the queue, timers are only hints, and the sweeper rebuilds everything.
 */
export class Notifier {
  private readonly queue = new Set<string>();
  private readonly active = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | undefined;
  private readonly concurrency: number;

  constructor(
    private readonly db: DB,
    private readonly stock: StockClient,
    private readonly resend: ResendClient,
    private readonly opts: NotifierOptions,
  ) {
    this.concurrency = opts.concurrency ?? 4;
  }

  /** Recover orphaned claims, run a first sweep, then sweep on an interval. */
  start(): void {
    this.stopping = false;
    this.recoverOrphanedClaims();
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), this.opts.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  /** Stop taking new work and wait for in-flight sends to finish. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.queue.clear();
    await this.whenIdle();
  }

  /** Resolves when nothing is queued or running. */
  whenIdle(): Promise<void> {
    return this.active.size === 0 && this.queue.size === 0 ? Promise.resolve() : this.idle;
  }

  /**
   * On boot this is the only process, so every `sending` row belongs to a
   * process that died mid-send. Put them back; the retry reuses the same
   * idempotency key, so the provider drops it if the first one got through.
   */
  recoverOrphanedClaims(olderThanMs = 0): number {
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE requests SET status = 'pending', next_attempt_at = ?, last_error = COALESCE(last_error, 'recovered after restart')
         WHERE status = 'sending' AND claimed_at <= ?`,
      )
      .run(now, now - olderThanMs);
    if (res.changes > 0) log.warn('recovered_orphaned_claims', { count: res.changes });
    return res.changes;
  }

  /**
   * Safety net for missed/failed webhooks and due retries. One stock call per
   * distinct SKU with due work, never one per request.
   */
  async sweep(): Promise<void> {
    if (this.stopping) return;
    try {
      this.recoverOrphanedClaims(this.opts.staleSendingMs);
      const skus = this.db
        .prepare(`SELECT DISTINCT sku FROM requests WHERE status = 'pending' AND next_attempt_at <= ?`)
        .all(Date.now())
        .map((r) => (r as { sku: string }).sku);
      for (const sku of skus) this.enqueue(sku);
    } catch (err) {
      log.error('sweep_failed', { error: String(err) });
    }
  }

  /** Ask the worker to look at a SKU now (or after delayMs). Cheap and idempotent. */
  enqueue(sku: string, delayMs = 0): void {
    if (this.stopping) return;
    if (delayMs > 0) {
      const t = setTimeout(() => {
        this.timers.delete(t);
        this.enqueue(sku);
      }, delayMs);
      t.unref();
      this.timers.add(t);
      return;
    }
    if (this.queue.size === 0 && this.active.size === 0) {
      this.idle = new Promise((r) => (this.resolveIdle = r));
    }
    this.queue.add(sku);
    this.pump();
  }

  private pump(): void {
    for (const sku of this.queue) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(sku)) continue; // it will be re-run after the current pass
      this.queue.delete(sku);
      this.active.add(sku);
      this.processSku(sku)
        .catch((err) => log.error('process_sku_failed', { sku, error: String(err) }))
        .finally(() => {
          this.active.delete(sku);
          if (this.stopping) this.queue.clear();
          if (this.queue.size === 0 && this.active.size === 0) this.resolveIdle?.();
          else this.pump();
        });
    }
  }

  private dueRequests(sku: string, limit: number): RequestRow[] {
    return this.db
      .prepare(
        `SELECT * FROM requests WHERE sku = ? AND status = 'pending' AND next_attempt_at <= ?
         ORDER BY created_at LIMIT ?`,
      )
      .all(sku, Date.now(), limit) as RequestRow[];
  }

  private async processSku(sku: string): Promise<void> {
    if (this.dueRequests(sku, 1).length === 0) return;

    // Re-check right before sending: once per SKU per batch, reusing a check
    // made in the last few seconds (e.g. by the webhook that triggered this).
    // Only a fresh *positive* result is reused; "sold out" is always re-asked.
    let product: StockInfo;
    try {
      const cached = this.stock.recent(sku, this.opts.stockFreshMs);
      product = cached?.available ? cached : await this.stock.check(sku, 'presend');
    } catch (err) {
      if (err instanceof StockApiError) {
        this.enqueue(sku, 30_000); // stock API down: try again soon; the sweeper also covers it
        return;
      }
      throw err;
    }
    if (!product.available) return; // sold out again: stay pending for the next restock

    // Everyone waiting gets told, even if quantity is low: we can't know who
    // will actually buy, and a missed alert is worse than a late one.
    while (!this.stopping) {
      const batch = this.dueRequests(sku, 50);
      if (batch.length === 0) break;
      for (const row of batch) {
        if (this.stopping) break;
        await this.sendOne(row, product);
      }
    }
  }

  /** Claim, send, record. Safe to call concurrently for the same row. */
  async sendOne(row: RequestRow, product: StockInfo): Promise<void> {
    const now = Date.now();
    const claim = this.db
      .prepare(
        `UPDATE requests SET status = 'sending', claimed_at = ?, attempts = attempts + 1
         WHERE id = ? AND status = 'pending' AND next_attempt_at <= ?`,
      )
      .run(now, row.id, now);
    if (claim.changes !== 1) return; // someone else has it, or it's not due

    const attempts = row.attempts + 1;
    const content = renderBackInStockEmail({ request: row, product, shopUrl: this.opts.shopUrl });
    let result: SendResult;
    try {
      result = await this.resend.send(
        { from: this.opts.emailFrom, to: [row.email], subject: content.subject, html: content.html, text: content.text },
        idempotencyKey(row.id),
      );
    } catch (err) {
      result = { kind: 'retry', error: String(err) };
    }

    if (result.kind === 'sent') {
      this.opts.afterProviderAccepted?.(row);
      this.db
        .prepare(
          `UPDATE requests SET status = 'notified', notified_at = ?, resend_email_id = ?, last_error = NULL
           WHERE id = ? AND status = 'sending'`,
        )
        .run(Date.now(), result.id, row.id);
      log.info('email_sent', { request: row.id, sku: row.sku, to: maskEmail(row.email), attempts });
      return;
    }

    if (result.kind === 'fatal' || attempts >= this.opts.maxAttempts) {
      const reason = result.kind === 'fatal' ? result.error : `gave up after ${attempts} attempts: ${result.error}`;
      this.db
        .prepare(`UPDATE requests SET status = 'failed', last_error = ? WHERE id = ? AND status = 'sending'`)
        .run(reason, row.id);
      log.error('email_failed', { request: row.id, sku: row.sku, attempts, error: reason });
      return;
    }

    const delay = result.retryAfterMs ?? backoff(this.opts.retryBaseMs, attempts);
    this.db
      .prepare(
        `UPDATE requests SET status = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ? AND status = 'sending'`,
      )
      .run(Date.now() + delay, result.error, row.id);
    log.warn('email_retry_scheduled', { request: row.id, sku: row.sku, attempts, delayMs: delay, error: result.error });
    this.enqueue(row.sku, delay + 50);
  }
}

/** Exponential backoff with full-ish jitter: base * 2^(n-1) * [0.5, 1.5), capped. */
export function backoff(baseMs: number, attempt: number): number {
  const exp = Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + Math.random()));
}
