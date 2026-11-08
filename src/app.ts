import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Config } from './config.js';
import { isUniqueViolation, type DB, type RequestRow, type RequestStatus } from './db.js';
import { isAllowedHost } from './html.js';
import { log } from './log.js';
import type { Notifier } from './notifier.js';
import { createRequest, NewRequestSchema, publicRequest, SKU_RE } from './requests.js';
import { StockApiError, type StockClient } from './stock.js';
import { renderAdmin, type WebhookLogRow } from './views/admin.js';
import { parseAccent, renderEmbed, type EmbedState } from './views/embed.js';
import { renderHome } from './views/home.js';

export interface AppDeps {
  db: DB;
  config: Config;
  stock: StockClient;
  notifier: Notifier;
}

/** Constant-time string compare that doesn't leak length (hash first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

const WebhookSchema = z.object({
  event_id: z.string().trim().min(1).max(200),
  type: z.string().max(100).optional(),
  sku: z.string().trim().regex(SKU_RE),
  quantity: z.coerce.number().finite(),
  occurred_at: z.string().max(100).optional(),
});

const STATUSES: RequestStatus[] = ['pending', 'sending', 'notified', 'failed'];

export function createApp({ db, config, stock, notifier }: AppDeps): Hono {
  const app = new Hono();

  // ---- baseline headers ---------------------------------------------------
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      c.header('X-Frame-Options', 'DENY');
    }
  });

  app.onError((err, c) => {
    log.error('unhandled', { path: c.req.path, error: String(err) });
    return c.json({ error: 'internal_error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  const tooLarge = (c: Context) => c.json({ error: 'payload_too_large' }, 413);

  // ---- health -----------------------------------------------------------
  app.get('/healthz', (c) => {
    try {
      db.prepare('SELECT 1').get();
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });

  app.get('/', (c) => {
    const nonce = randomBytes(16).toString('base64');
    c.header('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; frame-src 'self'; script-src 'nonce-${nonce}'; base-uri 'none'`);
    return c.html(renderHome({ nonce }));
  });

  // ---- embed ------------------------------------------------------------
  const embedCsp = (nonce: string) =>
    `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors *`;

  /** Product name + whether a recent reading says it's sold out. One stock call at most, then cached. */
  const productInfo = async (sku: string | undefined): Promise<{ name: string | null; soldOut?: boolean }> => {
    if (!sku) return { name: null };
    let info = stock.product(sku);
    if (!info) {
      try {
        info = await stock.check(sku, 'embed', { retries: 0 });
      } catch {
        return { name: null };
      }
    }
    const fresh = Date.now() - info.checkedAt < 10 * 60_000;
    return { name: info.name, soldOut: fresh && !info.available ? true : undefined };
  };

  const sendEmbed = async (
    c: Context,
    opts: { sku: string | undefined; productUrl: string | undefined; accent: string; state: EmbedState },
    status: 200 | 201 | 400 = 200,
  ) => {
    const nonce = randomBytes(16).toString('base64');
    c.header('Content-Security-Policy', embedCsp(nonce));
    c.header('Cache-Control', 'no-store');
    const p = await productInfo(opts.sku);
    const html = renderEmbed({ ...opts, productName: p.name, soldOut: p.soldOut, nonce });
    return c.html(html, status);
  };

  app.get('/embed', async (c) => {
    const rawSku = c.req.query('sku')?.trim();
    const sku = rawSku && SKU_RE.test(rawSku) ? rawSku : undefined;
    const url = c.req.query('url');
    return sendEmbed(c, {
      sku,
      productUrl: url && /^https?:\/\//.test(url) ? url.slice(0, 2000) : undefined,
      accent: parseAccent(c.req.query('accent')),
      state: { kind: 'form' },
    });
  });

  // ---- create request -------------------------------------------------
  app.post('/api/requests', bodyLimit({ maxSize: 16 * 1024, onError: tooLarge }), async (c) => {
    const ctype = c.req.header('content-type') ?? '';
    const isForm = ctype.includes('application/x-www-form-urlencoded') || ctype.includes('multipart/form-data');
    const wantsHtml = isForm || c.req.query('view') === 'embed';

    let body: Record<string, unknown>;
    try {
      if (isForm) {
        body = (await c.req.parseBody()) as Record<string, unknown>;
      } else {
        const parsed: unknown = await c.req.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      }
    } catch {
      return c.json({ error: 'invalid_body', message: 'Send JSON like {"email": "...", "sku": "..."}.' }, 400);
    }

    const accent = parseAccent(typeof body.accent === 'string' ? body.accent : undefined);
    const parsed = NewRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      if (wantsHtml) {
        const sku = typeof body.sku === 'string' && SKU_RE.test(body.sku.trim()) ? body.sku.trim() : undefined;
        return sendEmbed(
          c,
          {
            sku,
            productUrl: typeof body.product_url === 'string' ? body.product_url : undefined,
            accent,
            state: { kind: 'form', error: issues[0]?.message, email: typeof body.email === 'string' ? body.email : '' },
          },
          400,
        );
      }
      return c.json({ error: 'validation_error', issues }, 400);
    }

    // A product link is only kept if it points at an allowlisted store host (see SHOP_HOSTS).
    const input = { ...parsed.data, product_url: isAllowedHost(parsed.data.product_url, config.shopHosts) ? parsed.data.product_url : undefined };
    const { created, request } = createRequest(db, input, wantsHtml ? 'embed' : 'api');

    // Is it actually in stock right now? Store the request either way and let
    // the worker send the one email (after its own re-check). Bounded wait.
    let inStock: boolean | null = null;
    if (created) {
      try {
        const info = stock.recent(request.sku, config.stockFreshMs) ?? (await stock.check(request.sku, 'request', { retries: 0 }));
        inStock = info.available;
        if (inStock) notifier.enqueue(request.sku);
      } catch (err) {
        if (!(err instanceof StockApiError)) throw err;
        // Unknown: the sweeper will get to it.
      }
    }

    if (wantsHtml) {
      const state: EmbedState = !created
        ? { kind: 'already', email: request.email }
        : inStock
          ? { kind: 'in_stock', email: request.email }
          : { kind: 'created', email: request.email };
      return sendEmbed(c, { sku: request.sku, productUrl: request.product_url ?? undefined, accent, state }, created ? 201 : 200);
    }
    return c.json(
      { result: created ? 'created' : 'already_subscribed', in_stock: inStock, request: publicRequest(request) },
      created ? 201 : 200,
    );
  });

  // ---- stock webhook --------------------------------------------------
  const logHook = (event_id: string | null, sku: string | null, quantity: number | null, outcome: string) =>
    db
      .prepare('INSERT INTO webhook_log (event_id, sku, quantity, outcome, received_at) VALUES (?, ?, ?, ?, ?)')
      .run(event_id, sku, quantity, outcome, Date.now());

  app.post('/webhooks/stock', bodyLimit({ maxSize: 64 * 1024, onError: tooLarge }), async (c) => {
    // 1. Authenticate before reading anything.
    const secret = c.req.header('x-webhook-secret') ?? '';
    if (!safeEqual(secret, config.webhookSecret)) {
      logHook(null, null, null, 'bad_secret');
      log.warn('webhook_bad_secret');
      return c.json({ error: 'unauthorized' }, 401);
    }

    // 2. Validate.
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      logHook(null, null, null, 'invalid');
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = WebhookSchema.safeParse(raw);
    if (!parsed.success) {
      const r = (raw ?? {}) as Record<string, unknown>;
      logHook(typeof r.event_id === 'string' ? r.event_id.slice(0, 200) : null, null, null, 'invalid');
      return c.json({ error: 'validation_error', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400);
    }
    const ev = parsed.data;
    const claimed = Math.max(0, Math.floor(ev.quantity));

    // 3. Dedupe on event_id. The PRIMARY KEY makes concurrent duplicates safe.
    try {
      db.prepare(
        `INSERT INTO webhook_events (event_id, type, sku, claimed_quantity, occurred_at, received_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, 'received')`,
      ).run(ev.event_id, ev.type ?? null, ev.sku, claimed, ev.occurred_at ?? null, Date.now());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      db.prepare('UPDATE webhook_events SET deliveries = deliveries + 1 WHERE event_id = ?').run(ev.event_id);
      logHook(ev.event_id, ev.sku, claimed, 'duplicate');
      return c.json({ status: 'duplicate', event_id: ev.event_id });
    }

    const finish = (outcome: string, seen: number | null) => {
      db.prepare('UPDATE webhook_events SET outcome = ?, stock_quantity_seen = ? WHERE event_id = ?').run(outcome, seen, ev.event_id);
      logHook(ev.event_id, ev.sku, claimed, outcome);
      return c.json({ status: 'accepted', event_id: ev.event_id, outcome });
    };

    // A sell-out needs no verification: we never email on it.
    if (claimed <= 0) return finish('sellout', null);

    // 4. Don't trust the quantity: ask the stock API.
    try {
      const info = await stock.check(ev.sku, 'webhook');
      if (!info.available) return finish('not_confirmed', info.quantity);
      // 5. Emails go out from the background worker, not this request.
      notifier.enqueue(ev.sku);
      return finish('confirmed', info.quantity);
    } catch (err) {
      if (!(err instanceof StockApiError)) throw err;
      // 6. Stock API down: we have the event; don't make the sender retry forever.
      notifier.enqueue(ev.sku, 15_000);
      return finish('unverified', null);
    }
  });

  // ---- admin ------------------------------------------------------------
  app.use('/admin', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    let password = '';
    if (header.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      password = i >= 0 ? decoded.slice(i + 1) : '';
    }
    if (!safeEqual(password, config.adminPassword)) {
      c.header('WWW-Authenticate', 'Basic realm="Back in Stock admin", charset="UTF-8"');
      c.header('Cache-Control', 'no-store');
      return c.text('Authentication required', 401);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  app.get('/admin', (c) => {
    const statusQ = c.req.query('status') as RequestStatus | undefined;
    const filter: RequestStatus | 'all' = statusQ && STATUSES.includes(statusQ) ? statusQ : 'all';
    const q = (c.req.query('q') ?? '').trim().slice(0, 200);
    const limit = 300;

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter !== 'all') {
      where.push('status = ?');
      params.push(filter);
    }
    if (q) {
      where.push(`(email LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\')`);
      const like = `%${q.toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      params.push(like, like);
    }
    const rows = db
      .prepare(`SELECT * FROM requests ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as RequestRow[];

    const counts = { all: 0, pending: 0, sending: 0, notified: 0, failed: 0 } as Record<RequestStatus | 'all', number>;
    for (const r of db.prepare('SELECT status, COUNT(*) n FROM requests GROUP BY status').all() as { status: RequestStatus; n: number }[]) {
      counts[r.status] = r.n;
      counts.all += r.n;
    }
    const dayAgo = Date.now() - 86_400_000;
    const webhooks = db
      .prepare(
        `SELECT l.event_id, l.sku, l.quantity, l.outcome, l.received_at,
                CASE WHEN l.outcome IN ('confirmed','not_confirmed') THEN e.stock_quantity_seen END AS stock_quantity_seen
         FROM webhook_log l LEFT JOIN webhook_events e ON e.event_id = l.event_id
         ORDER BY l.id DESC LIMIT 40`,
      )
      .all() as WebhookLogRow[];
    const stockCalls24h = (db.prepare('SELECT COUNT(*) n FROM stock_checks WHERE checked_at >= ?').get(dayAgo) as { n: number }).n;
    const emailsToday = (db.prepare('SELECT COUNT(*) n FROM requests WHERE notified_at >= ?').get(dayAgo) as { n: number }).n;
    const productNames = new Map(
      (db.prepare('SELECT sku, name FROM products WHERE name IS NOT NULL').all() as { sku: string; name: string }[]).map((p) => [p.sku, p.name]),
    );

    return c.html(renderAdmin({ rows, counts, filter, q, limit, webhooks, stockCalls24h, emailsToday, productNames, now: Date.now() }));
  });

  return app;
}
