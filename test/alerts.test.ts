import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { idempotencyKey } from '../src/notifier.js';
import { ADMIN, buildApp, count, FakeUpstream, subscribe, waitFor, webhook, type TestApp } from './helpers.js';

let up: FakeUpstream;
let t: TestApp;

beforeEach(async () => {
  up = await new FakeUpstream().start();
  t = buildApp(up);
});

afterEach(async () => {
  await t.notifier.stop();
  t.db.close();
  await up.close();
});

const restock = (sku: string, quantity: number, event_id = `evt_${Math.random().toString(36).slice(2)}`) => ({
  event_id,
  type: 'stock.updated',
  sku,
  quantity,
  occurred_at: new Date().toISOString(),
});

describe('webhooks', () => {
  it('1. same event_id delivered twice concurrently → one event row, one email', async () => {
    expect((await subscribe(t, 'ada@example.com', 'TEE-1')).status).toBe(201);
    up.stock['TEE-1'] = 5;

    const ev = restock('TEE-1', 5, 'evt_dupe');
    const [a, b] = await Promise.all([webhook(t, ev), webhook(t, ev)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()].map((x) => (x as { status: string }).status).sort();
    expect(bodies).toEqual(['accepted', 'duplicate']);
    expect(count(t.db, 'SELECT COUNT(*) n FROM webhook_events')).toBe(1);

    await waitFor(() => count(t.db, `SELECT COUNT(*) n FROM requests WHERE status='notified'`) === 1);
    await t.notifier.whenIdle();
    // A third, late duplicate changes nothing either.
    expect((await (await webhook(t, ev)).json()) as object).toMatchObject({ status: 'duplicate' });
    await t.notifier.whenIdle();
    expect(up.emails).toHaveLength(1);
    expect(up.accepted[0]!.to).toEqual(['ada@example.com']);
  });

  it('2. phantom restock (stock API says 0) → no email, outcome not_confirmed', async () => {
    await subscribe(t, 'bo@example.com', 'MUG-1');
    up.stock['MUG-1'] = 0;
    const res = await webhook(t, restock('MUG-1', 12, 'evt_phantom'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'not_confirmed' });
    await t.notifier.whenIdle();
    const ev = t.db.prepare(`SELECT outcome, stock_quantity_seen FROM webhook_events WHERE event_id='evt_phantom'`).get();
    expect(ev).toEqual({ outcome: 'not_confirmed', stock_quantity_seen: 0 });
    expect(up.emails).toHaveLength(0);
    expect(count(t.db, `SELECT COUNT(*) n FROM requests WHERE status='pending'`)).toBe(1);
  });

  it('3. wrong / missing secret → 401, no side effects', async () => {
    await subscribe(t, 'cy@example.com', 'CAP-1');
    up.stock['CAP-1'] = 3;
    const callsBefore = up.stockCalls.length;
    const wrong = await webhook(t, restock('CAP-1', 3, 'evt_real'), 'nope');
    const missing = await webhook(t, restock('CAP-1', 3, 'evt_real'), null);
    const longer = await webhook(t, restock('CAP-1', 3, 'evt_real'), 'whsec_test_secret_but_longer');
    expect([wrong.status, missing.status, longer.status]).toEqual([401, 401, 401]);
    expect(count(t.db, 'SELECT COUNT(*) n FROM webhook_events')).toBe(0);
    expect(up.stockCalls.length).toBe(callsBefore);
    await t.notifier.whenIdle();
    expect(up.emails).toHaveLength(0);
    // The forged attempts must not block the real event with the same id.
    const real = await webhook(t, restock('CAP-1', 3, 'evt_real'));
    expect(await real.json()).toMatchObject({ status: 'accepted', outcome: 'confirmed' });
  });

  it('sell-out webhooks are recorded without a stock API call', async () => {
    const res = await webhook(t, restock('PAN-1', 0, 'evt_sold'));
    expect(await res.json()).toMatchObject({ outcome: 'sellout' });
    expect(up.stockCalls).toHaveLength(0);
  });

  it('stock API down → still 200 (event stored), sweeper delivers once it is back', async () => {
    await subscribe(t, 'dee@example.com', 'KTL-1');
    up.stock['KTL-1'] = 4;
    up.stockDown = 503;
    const res = await webhook(t, restock('KTL-1', 4, 'evt_down'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'unverified' });
    expect(up.emails).toHaveLength(0);

    up.stockDown = null;
    await t.notifier.sweep();
    await waitFor(() => up.accepted.length === 1);
  });
});

describe('exactly-once sending', () => {
  it('4. Resend 500, 500, then 200 → one notified, same idempotency key on all three calls', async () => {
    await subscribe(t, 'eve@example.com', 'BTL-1');
    up.stock['BTL-1'] = 9;
    up.emailFailures = [{ status: 500 }, { status: 500 }];
    await webhook(t, restock('BTL-1', 9));

    await waitFor(() => count(t.db, `SELECT COUNT(*) n FROM requests WHERE status='notified'`) === 1);
    const row = t.db.prepare('SELECT id, attempts, resend_email_id, last_error FROM requests').get() as {
      id: string;
      attempts: number;
      resend_email_id: string;
      last_error: string | null;
    };
    expect(up.emailCalls.map((c) => c.status)).toEqual([500, 500, 200]);
    expect(new Set(up.emailCalls.map((c) => c.idempotencyKey))).toEqual(new Set([idempotencyKey(row.id)]));
    expect(up.accepted).toHaveLength(1);
    expect(row.attempts).toBe(3);
    expect(row.resend_email_id).toBe(up.accepted[0]!.id);
    expect(row.last_error).toBeNull();
  });

  it('5. crash after the provider accepted, before we recorded it → restart resends with same key → one email', async () => {
    let crashed = false;
    const crashy = buildApp(up, {
      db: t.db,
      notifier: {
        afterProviderAccepted: () => {
          if (!crashed) {
            crashed = true;
            throw new Error('simulated crash');
          }
        },
      },
    });
    await subscribe(crashy, 'fin@example.com', 'LAMP-1');
    up.stock['LAMP-1'] = 2;
    await webhook(crashy, restock('LAMP-1', 2));
    await waitFor(() => crashed);
    await crashy.notifier.whenIdle();

    // The process "died" with the row claimed.
    expect(t.db.prepare('SELECT status FROM requests').get()).toEqual({ status: 'sending' });
    expect(up.accepted).toHaveLength(1);

    // Restart: boot recovery puts it back, the sweeper finds it, the resend reuses the key.
    const rebooted = await crashy.restart();
    rebooted.notifier.start();
    await waitFor(() => count(t.db, `SELECT COUNT(*) n FROM requests WHERE status='notified'`) === 1);
    await rebooted.notifier.stop();

    expect(up.emailCalls).toHaveLength(2);
    expect(up.emailCalls[0]!.idempotencyKey).toBe(up.emailCalls[1]!.idempotencyKey);
    expect(up.accepted).toHaveLength(1); // the provider saw one email
    expect(up.emails.map((e) => e.status)).toEqual(['accepted', 'deduped']);
  });

  it('crash after claim, before the send went out → restart sends it (no lost email)', async () => {
    await subscribe(t, 'gus@example.com', 'NB-1');
    // Simulate: claimed by a process that then died.
    t.db.prepare(`UPDATE requests SET status='sending', claimed_at=?, attempts=1`).run(Date.now() - 120_000);
    up.stock['NB-1'] = 1;
    const rebooted = await t.restart();
    rebooted.notifier.start();
    await waitFor(() => up.accepted.length === 1);
    await rebooted.notifier.stop();
    expect(t.db.prepare('SELECT status, attempts FROM requests').get()).toEqual({ status: 'notified', attempts: 2 });
  });

  it('restart while a retry is in backoff → retried when due, not a sweep interval later', async () => {
    await subscribe(t, 'gia@example.com', 'NB-2');
    up.stock['NB-2'] = 3;
    // Failed once just before the "crash"; due again in 300ms. In-memory timers are gone.
    t.db.prepare(`UPDATE requests SET attempts=1, next_attempt_at=?, last_error='HTTP 500'`).run(Date.now() + 300);
    const rebooted = await t.restart();
    rebooted.notifier.start(); // sweepIntervalMs is 1h in tests, so only the armed timer can deliver it
    await waitFor(() => up.accepted.length === 1, 2_000);
    await rebooted.notifier.stop();
  });

  it('4xx from Resend → failed with reason, no retry', async () => {
    await subscribe(t, 'hal@example.com', 'PEN-1');
    up.stock['PEN-1'] = 3;
    up.emailFailures = [{ status: 422 }];
    await webhook(t, restock('PEN-1', 3));
    await waitFor(() => count(t.db, `SELECT COUNT(*) n FROM requests WHERE status='failed'`) === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(up.emailCalls).toHaveLength(1);
    expect((t.db.prepare('SELECT last_error FROM requests').get() as { last_error: string }).last_error).toMatch(/422/);
  });

  it('429 honours Retry-After then succeeds', async () => {
    await subscribe(t, 'ivy@example.com', 'SOCK-1');
    up.stock['SOCK-1'] = 3;
    up.emailFailures = [{ status: 429, headers: { 'retry-after': '0' } }];
    await webhook(t, restock('SOCK-1', 3));
    await waitFor(() => up.accepted.length === 1);
    expect(up.emailCalls.map((c) => c.status)).toEqual([429, 200]);
  });

  it('gives up after maxAttempts and marks failed', async () => {
    const t2 = buildApp(up, { config: { maxAttempts: 3 } });
    await subscribe(t2, 'jo@example.com', 'TOTE-1');
    up.stock['TOTE-1'] = 3;
    up.emailFailures = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
    await webhook(t2, restock('TOTE-1', 3));
    await waitFor(() => count(t2.db, `SELECT COUNT(*) n FROM requests WHERE status='failed'`) === 1);
    expect(up.emailCalls).toHaveLength(3);
    await t2.notifier.stop();
    t2.db.close();
  });

  it('sold out again before sending → stays pending, sent on the next restock', async () => {
    await subscribe(t, 'kai@example.com', 'GRND-1');
    up.stock['GRND-1'] = 0;
    // Missed webhook scenario: nothing arrives, the sweeper checks once per SKU.
    await t.notifier.sweep();
    await t.notifier.whenIdle();
    expect(up.emails).toHaveLength(0);
    up.stock['GRND-1'] = 2;
    // Fresh-cache would hide the change for a few seconds; a webhook forces a real check.
    await webhook(t, restock('GRND-1', 2));
    await waitFor(() => up.accepted.length === 1);
  });

  it('sweeper makes one stock call per SKU, not per request, and notifies everyone waiting', async () => {
    for (let i = 0; i < 6; i++) await subscribe(t, `c${i}@example.com`, i < 4 ? 'BEAN-1' : 'THRW-1');
    up.stock['BEAN-1'] = 1; // low stock: we still tell all four
    up.stock['THRW-1'] = 7;
    const before = up.stockCalls.length;
    await t.notifier.sweep();
    await waitFor(() => up.accepted.length === 6);
    await t.notifier.whenIdle();
    expect(up.stockCalls.slice(before).sort()).toEqual(['BEAN-1', 'THRW-1']);
    expect(new Set(up.accepted.map((e) => e.to[0])).size).toBe(6);
  });
});

describe('POST /api/requests', () => {
  it('6. duplicate requests (sequential and concurrent) → one open row', async () => {
    const first = await subscribe(t, 'Lee@Example.com ', 'HOOD-1');
    expect(first.status).toBe(201);
    const again = await subscribe(t, 'lee@example.com', 'HOOD-1');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ result: 'already_subscribed' });

    const burst = await Promise.all(Array.from({ length: 10 }, () => subscribe(t, 'max@example.com', 'HOOD-1')));
    const statuses = burst.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);
    expect(count(t.db, `SELECT COUNT(*) n FROM requests WHERE email='max@example.com'`)).toBe(1);
    expect(count(t.db, `SELECT COUNT(*) n FROM requests WHERE email='lee@example.com'`)).toBe(1);
  });

  it('7. after a request is notified, the same email + SKU can open a new one', async () => {
    await subscribe(t, 'nia@example.com', 'KNF-1');
    up.stock['KNF-1'] = 2;
    await webhook(t, restock('KNF-1', 2));
    await waitFor(() => up.accepted.length === 1);
    await t.notifier.whenIdle();
    up.stock['KNF-1'] = 0;
    t.db.prepare('DELETE FROM products').run(); // forget the cached "in stock"
    const again = await subscribe(t, 'nia@example.com', 'KNF-1');
    expect(again.status).toBe(201);
    expect(count(t.db, `SELECT COUNT(*) n FROM requests WHERE email='nia@example.com'`)).toBe(2);
  });

  it('item already in stock → stored and emailed once, response says in_stock', async () => {
    up.stock['PLNT-1'] = 5;
    const res = await subscribe(t, 'oz@example.com', 'PLNT-1');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ in_stock: true });
    await waitFor(() => up.accepted.length === 1);
  });

  it('8. malformed JSON / bad input / huge body → 400 / 413, never 500', async () => {
    const post = (body: string, ctype = 'application/json') =>
      t.app.request('/api/requests', { method: 'POST', headers: { 'content-type': ctype }, body });
    expect((await post('{nope')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
    expect((await post('null')).status).toBe(400);
    expect((await post(JSON.stringify({ email: 'not-an-email', sku: 'X-1' }))).status).toBe(400);
    expect((await post(JSON.stringify({ email: 'a@b.co', sku: '<script>' }))).status).toBe(400);
    expect((await post(JSON.stringify({ email: 'a@b.co', sku: 'X'.repeat(30_000) }))).status).toBe(413);

    const hook = (body: string) => webhook(t, body);
    expect((await hook('{nope')).status).toBe(400);
    expect((await hook(JSON.stringify({ sku: 'X-1' }))).status).toBe(400);
    expect((await hook(JSON.stringify({ event_id: 'e', sku: 'X-1', quantity: 'lots' }))).status).toBe(400);
    expect((await hook('x'.repeat(100_000))).status).toBe(413);
    expect((await t.app.request('/healthz')).status).toBe(200);
  });

  it('handles the no-JS form post from the embed and renders HTML', async () => {
    const res = await t.app.request('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'pat@example.com', sku: 'CNDL-1' }).toString(),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('on the list');

    const bad = await t.app.request('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'nope', sku: 'CNDL-1' }).toString(),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('valid email');
  });
});

describe('pages', () => {
  it('embed can be framed anywhere and escapes input', async () => {
    const res = await t.app.request('/embed?sku=TEE-1&accent=%23ff5500');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(res.headers.get('x-frame-options')).toBeNull();
    const html = await res.text();
    expect(html).toContain('name="sku" value="TEE-1"');
    expect(html).toContain('--accent:#ff5500');
    const evil = await (await t.app.request('/embed?sku=%22%3E%3Cscript%3E&accent=red;}</style>')).text();
    expect(evil).not.toContain('"><script>');
    expect(evil).toContain('id="sku"'); // invalid sku → visible field instead
  });

  it('admin needs the password, is not cacheable, and shows requests', async () => {
    expect((await t.app.request('/admin')).status).toBe(401);
    const wrong = await t.app.request('/admin', { headers: { authorization: `Basic ${btoa('admin:wrong')}` } });
    expect(wrong.status).toBe(401);
    await subscribe(t, 'quin@example.com', 'BAG-1');
    const ok = await t.app.request('/admin?status=pending', { headers: { authorization: `Basic ${btoa(`admin:${ADMIN}`)}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-frame-options')).toBe('DENY');
    expect(await ok.text()).toContain('quin@example.com');
  });

  it('email escapes interpolated values and has a text part', async () => {
    const { renderBackInStockEmail } = await import('../src/email.js');
    const out = renderBackInStockEmail({
      request: { email: 'x"<b>@example.com', sku: 'A-1', created_at: Date.now(), product_url: 'javascript:alert(1)' },
      product: { sku: 'A-1', name: '<img src=x onerror=alert(1)>', price: 24, currency: 'GBP', image: 'https://i.example.com/a.jpg', quantity: 2, available: true, checkedAt: Date.now() },
      shopUrl: 'https://shop.example.com/p/{sku}',
      shopHosts: [],
    });
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).not.toContain('javascript:');
    expect(out.html).toContain('https://shop.example.com/p/A-1');
    expect(out.text).toContain('Shop now: https://shop.example.com/p/A-1');
    expect(out.html).toContain('£24');
  });
});
