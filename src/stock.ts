import { z } from 'zod';
import type { DB, ProductRow } from './db.js';
import { safeHttpsUrl } from './html.js';
import { log } from './log.js';

// Only the stock fields decide whether the body is usable. Display fields are
// parsed loosely and cleaned by cleanProductFields(): a bad name must not stop
// a real restock from being confirmed.
const StockResponse = z.object({
  quantity: z.coerce.number().default(0),
  in_stock: z.boolean().optional(),
  name: z.unknown().optional(),
  price: z.unknown().optional(),
  currency: z.unknown().optional(),
  image: z.unknown().optional(),
});

export const MAX_NAME_LENGTH = 200;
// C0/C1 control characters plus the line/paragraph separators (code points 0x2028, 0x2029).
const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f-\\x9f' + String.fromCharCode(0x2028, 0x2029) + ']+', 'g');
const MAX_PRICE = 1_000_000;

/**
 * The stock API's display fields end up in emails sent under our name, so they
 * are treated as untrusted content: anything that fails a check is dropped
 * (the email falls back to the SKU, no price, no image) rather than shown.
 */
export function cleanProductFields(b: { name?: unknown; price?: unknown; currency?: unknown; image?: unknown }) {
  let name: string | null = null;
  if (typeof b.name === 'string') {
    // Collapse control characters and whitespace runs (no header/line injection), then cap.
    const n = b.name.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    name = n ? (n.length > MAX_NAME_LENGTH ? `${n.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : n) : null;
  }

  const rawCurrency = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : null;
  const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;

  const p = typeof b.price === 'number' ? b.price : typeof b.price === 'string' && b.price.trim() !== '' ? Number(b.price) : NaN;
  // A price in an unknown currency would be shown as GBP, which would be a lie: drop both.
  const priceOk = Number.isFinite(p) && p > 0 && p < MAX_PRICE && (currency !== null || b.currency == null);
  const price = priceOk ? Math.round(p * 100) / 100 : null;

  const image = typeof b.image === 'string' ? safeHttpsUrl(b.image.trim()) || null : null;

  return { name, price, currency: priceOk ? currency : null, image };
}

export interface StockInfo {
  sku: string;
  name: string | null;
  price: number | null;
  currency: string | null;
  image: string | null;
  quantity: number;
  /** True only when the API says in_stock AND quantity > 0. */
  available: boolean;
  checkedAt: number;
}

export class StockApiError extends Error {}

export type CheckReason = 'webhook' | 'presend' | 'sweep' | 'request' | 'embed';

export interface StockClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries?: number;
}

/** Talks to the stock API. Every call is recorded so the admin page can show it. */
export class StockClient {
  private readonly retries: number;
  /** Coalesces concurrent checks for the same SKU into one HTTP call. */
  private readonly inflight = new Map<string, Promise<StockInfo>>();

  constructor(
    private readonly db: DB,
    private readonly opts: StockClientOptions,
  ) {
    this.retries = opts.retries ?? 1;
  }

  check(sku: string, reason: CheckReason, opts: { retries?: number } = {}): Promise<StockInfo> {
    const existing = this.inflight.get(sku);
    if (existing) return existing;
    const p = this.doCheck(sku, reason, opts.retries ?? this.retries).finally(() => this.inflight.delete(sku));
    this.inflight.set(sku, p);
    return p;
  }

  /** Last known result if it is younger than maxAgeMs, else undefined. */
  recent(sku: string, maxAgeMs: number): StockInfo | undefined {
    const row = this.db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as ProductRow | undefined;
    if (!row || Date.now() - row.checked_at > maxAgeMs) return undefined;
    return rowToInfo(row);
  }

  /** Cached product details (any age), for rendering. */
  product(sku: string): StockInfo | undefined {
    const row = this.db.prepare('SELECT * FROM products WHERE sku = ?').get(sku) as ProductRow | undefined;
    return row ? rowToInfo(row) : undefined;
  }

  private async doCheck(sku: string, reason: CheckReason, retries: number): Promise<StockInfo> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(250 + Math.random() * 250);
      try {
        const info = await this.fetchOnce(sku);
        this.record(info, reason);
        return info;
      } catch (err) {
        lastErr = err;
        // 4xx (other than 408/429) won't fix itself on retry.
        if (err instanceof HttpError && err.status < 500 && err.status !== 408 && err.status !== 429) break;
      }
    }
    const message = errMessage(lastErr);
    this.db
      .prepare('INSERT INTO stock_checks (sku, reason, error, checked_at) VALUES (?, ?, ?, ?)')
      .run(sku, reason, message, Date.now());
    log.warn('stock_check_failed', { sku, reason, error: message });
    throw new StockApiError(message);
  }

  private async fetchOnce(sku: string): Promise<StockInfo> {
    const res = await fetch(`${this.opts.baseUrl}/${encodeURIComponent(sku)}`, {
      headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (res.status === 404) {
      await res.body?.cancel();
      return emptyInfo(sku);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(res.status, `stock API HTTP ${res.status}`);
    }
    const parsed = StockResponse.safeParse(await res.json());
    if (!parsed.success) throw new Error('stock API returned an unexpected body');
    const b = parsed.data;
    const quantity = Number.isFinite(b.quantity) ? Math.max(0, Math.floor(b.quantity)) : 0;
    return {
      sku,
      ...cleanProductFields(b),
      quantity,
      // Both signals must agree before we believe it.
      available: (b.in_stock ?? quantity > 0) && quantity > 0,
      checkedAt: Date.now(),
    };
  }

  private record(info: StockInfo, reason: CheckReason): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO stock_checks (sku, quantity, in_stock, reason, checked_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(info.sku, info.quantity, info.available ? 1 : 0, reason, info.checkedAt);
      this.db
        .prepare(
          `INSERT INTO products (sku, name, price, currency, image, quantity, in_stock, checked_at)
           VALUES (@sku, @name, @price, @currency, @image, @quantity, @in_stock, @checked_at)
           ON CONFLICT (sku) DO UPDATE SET
             name = COALESCE(excluded.name, products.name),
             price = COALESCE(excluded.price, products.price),
             currency = COALESCE(excluded.currency, products.currency),
             image = COALESCE(excluded.image, products.image),
             quantity = excluded.quantity, in_stock = excluded.in_stock, checked_at = excluded.checked_at`,
        )
        .run({
          sku: info.sku,
          name: info.name,
          price: info.price,
          currency: info.currency,
          image: info.image,
          quantity: info.quantity,
          in_stock: info.available ? 1 : 0,
          checked_at: info.checkedAt,
        });
      // Keep the audit table bounded.
      this.db.prepare('DELETE FROM stock_checks WHERE id <= (SELECT MAX(id) - 5000 FROM stock_checks)').run();
    });
    tx();
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function emptyInfo(sku: string): StockInfo {
  return { sku, name: null, price: null, currency: null, image: null, quantity: 0, available: false, checkedAt: Date.now() };
}

function rowToInfo(r: ProductRow): StockInfo {
  return {
    sku: r.sku,
    // Re-clean on read: rows cached before a rule change are covered too.
    ...cleanProductFields({ name: r.name, price: r.price, currency: r.currency, image: r.image }),
    quantity: r.quantity,
    available: r.in_stock === 1 && r.quantity > 0,
    checkedAt: r.checked_at,
  };
}

export function errMessage(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    return cause ? `${err.message} (${cause})` : err.message;
  }
  return String(err);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
