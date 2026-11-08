import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { defaultTunables, type Config } from '../src/config.js';
import { openDb, type DB } from '../src/db.js';
import { Notifier, type NotifierOptions } from '../src/notifier.js';
import { ResendClient } from '../src/resend.js';
import { StockClient } from '../src/stock.js';

export interface FakeEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string | null;
  status: 'accepted' | 'deduped' | 'failed';
  id: string;
}

/**
 * One local server playing both the stock API and Resend, with the same
 * semantics as the challenge harness (idempotency only dedupes accepted sends).
 */
export class FakeUpstream {
  stock: Record<string, number> = {};
  stockCalls: string[] = [];
  /** Status codes to return for the next N email sends, in order. */
  emailFailures: { status: number; headers?: Record<string, string> }[] = [];
  /** Make the stock API return this status (e.g. 503) while set. */
  stockDown: number | null = null;
  emails: FakeEmail[] = [];
  emailCalls: { idempotencyKey: string | null; status: number }[] = [];
  url = '';
  private server = http.createServer((req, res) => void this.handle(req, res));
  private seq = 0;

  get accepted(): FakeEmail[] {
    return this.emails.filter((e) => e.status === 'accepted');
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((r) => this.server.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== 'Bearer test-key') return send(401, { error: 'bad key' });

    const m = url.pathname.match(/^\/stock\/(.+)$/);
    if (req.method === 'GET' && m) {
      const sku = decodeURIComponent(m[1]!);
      this.stockCalls.push(sku);
      if (this.stockDown) return send(this.stockDown, { error: 'down' });
      const quantity = this.stock[sku] ?? 0;
      return send(200, {
        sku,
        name: `Product ${sku}`,
        price: 24,
        currency: 'GBP',
        image: `https://img.example.com/${sku}.jpg`,
        quantity,
        in_stock: quantity > 0,
      });
    }

    if (req.method === 'POST' && url.pathname === '/emails') {
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Omit<FakeEmail, 'status' | 'id' | 'idempotencyKey'>;
      const key = (req.headers['idempotency-key'] as string | undefined) ?? null;
      const prev = key ? this.emails.find((e) => e.idempotencyKey === key && e.status === 'accepted') : undefined;
      if (prev) {
        this.emails.push({ ...payload, idempotencyKey: key, status: 'deduped', id: prev.id });
        this.emailCalls.push({ idempotencyKey: key, status: 200 });
        return send(200, { id: prev.id });
      }
      const fail = this.emailFailures.shift();
      const id = `em_${++this.seq}`;
      if (fail) {
        this.emails.push({ ...payload, idempotencyKey: key, status: 'failed', id });
        this.emailCalls.push({ idempotencyKey: key, status: fail.status });
        return send(fail.status, { statusCode: fail.status, name: 'injected', message: 'Injected failure' }, fail.headers);
      }
      this.emails.push({ ...payload, idempotencyKey: key, status: 'accepted', id });
      this.emailCalls.push({ idempotencyKey: key, status: 200 });
      return send(200, { id });
    }
    send(404, { error: 'not found' });
  }
}

export const SECRET = 'whsec_test_secret';
export const ADMIN = 'admin-pass';

export function testConfig(upstreamUrl: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    stockApiUrl: `${upstreamUrl}/stock`,
    stockApiKey: 'test-key',
    resendApiKey: 'test-key',
    resendBaseUrl: upstreamUrl,
    webhookSecret: SECRET,
    adminPassword: ADMIN,
    dataDir: ':memory:',
    emailFrom: 'Back in Stock <alerts@example.com>',
    publicUrl: undefined,
    shopUrl: 'https://shop.example.com/products/{sku}',
    ...defaultTunables,
    retryBaseMs: 20,
    sweepIntervalMs: 3_600_000, // tests call sweep() by hand
    stockTimeoutMs: 1_000,
    sendTimeoutMs: 2_000,
    ...overrides,
  };
}

export interface TestApp {
  db: DB;
  config: Config;
  stock: StockClient;
  notifier: Notifier;
  app: ReturnType<typeof createApp>;
  /** Build a fresh worker on the same DB, as a restarted process would. */
  restart(extra?: Partial<NotifierOptions>): Promise<TestApp>;
}

export function buildApp(upstream: FakeUpstream, opts: { db?: DB; config?: Partial<Config>; notifier?: Partial<NotifierOptions> } = {}): TestApp {
  const config = testConfig(upstream.url, opts.config);
  const db = opts.db ?? openDb(':memory:');
  const stock = new StockClient(db, { baseUrl: config.stockApiUrl, apiKey: config.stockApiKey, timeoutMs: config.stockTimeoutMs });
  const resend = new ResendClient({ baseUrl: config.resendBaseUrl, apiKey: config.resendApiKey, timeoutMs: config.sendTimeoutMs });
  const notifier = new Notifier(db, stock, resend, { ...config, ...opts.notifier });
  const app = createApp({ db, config, stock, notifier });
  const self: TestApp = {
    db,
    config,
    stock,
    notifier,
    app,
    async restart(extra) {
      await notifier.stop();
      return buildApp(upstream, { db, config: opts.config, notifier: extra });
    },
  };
  return self;
}

export function webhook(t: TestApp, body: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-webhook-secret'] = secret;
  return t.app.request('/webhooks/stock', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

export function subscribe(t: TestApp, email: string, sku: string) {
  return t.app.request('/api/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, sku }),
  });
}

export async function waitFor(cond: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const count = (db: DB, sql: string, ...params: unknown[]) =>
  (db.prepare(sql).get(...params) as { n: number }).n;
