import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHosts } from '../src/config.js';
import { isAllowedHost, safeHttpsUrl } from '../src/html.js';
import { cleanProductFields, MAX_NAME_LENGTH } from '../src/stock.js';
import { buildApp, FakeUpstream, waitFor, webhook, type TestApp } from './helpers.js';

let up: FakeUpstream;
let t: TestApp;

beforeEach(async () => {
  up = await new FakeUpstream().start();
  t = buildApp(up); // shopHosts: ['shop.example.com']
});

afterEach(async () => {
  await t.notifier.stop();
  t.db.close();
  await up.close();
});

const signUp = (body: Record<string, string>) =>
  t.app.request('/api/requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function restockAndGetEmail(sku: string) {
  up.stock[sku] = 4;
  await webhook(t, { event_id: `evt_${sku}`, sku, quantity: 4 });
  await waitFor(() => up.accepted.length === 1);
  return up.accepted[0]!;
}

describe('per-request product links (phishing relay)', () => {
  it('drops a link to a host that is not allowlisted; the email uses SHOP_URL', async () => {
    expect((await signUp({ email: 'victim@example.com', sku: 'TEE-1', product_url: 'https://phishing.example/login' })).status).toBe(201);
    const stored = t.db.prepare('SELECT product_url FROM requests').get() as { product_url: string | null };
    expect(stored.product_url).toBeNull();

    const email = await restockAndGetEmail('TEE-1');
    expect(email.html).not.toContain('phishing.example');
    expect(email.text).not.toContain('phishing.example');
    expect(email.html).toContain('https://shop.example.com/products/TEE-1');
  });

  it('rejects look-alike hosts and credentials-in-URL tricks', () => {
    const hosts = ['shop.example.com'];
    expect(isAllowedHost('https://shop.example.com/p/1', hosts)).toBe(true);
    expect(isAllowedHost('https://eu.shop.example.com/p/1', hosts)).toBe(true);
    expect(isAllowedHost('https://evil-shop.example.com/p/1', hosts)).toBe(false);
    expect(isAllowedHost('https://shop.example.com.evil.net/p/1', hosts)).toBe(false);
    expect(isAllowedHost('https://shop.example.com@evil.net/p/1', hosts)).toBe(false);
    expect(isAllowedHost('https://user:pw@shop.example.com/p/1', hosts)).toBe(false);
    expect(isAllowedHost('javascript://shop.example.com/%0aalert(1)', hosts)).toBe(false);
    expect(isAllowedHost('https://shop.example.com/p/1', [])).toBe(false);
  });

  it('keeps a link to an allowlisted store host and uses it in the email', async () => {
    await signUp({ email: 'ok@example.com', sku: 'TEE-2', product_url: 'https://eu.shop.example.com/products/tee-2?colour=white' });
    const email = await restockAndGetEmail('TEE-2');
    expect(email.html).toContain('https://eu.shop.example.com/products/tee-2?colour=white');
  });

  it('re-checks at send time: a stored link that is no longer allowed is not used', async () => {
    await signUp({ email: 'old@example.com', sku: 'TEE-3' });
    // e.g. stored before SHOP_HOSTS was tightened
    t.db.prepare(`UPDATE requests SET product_url = 'https://formerly-trusted.example/x'`).run();
    const email = await restockAndGetEmail('TEE-3');
    expect(email.html).not.toContain('formerly-trusted.example');
  });

  it('builds the allowlist from SHOP_HOSTS plus the SHOP_URL host', () => {
    expect(parseHosts(' Shop.Example.com, *.brand.co.uk ,bad host, nodot', 'https://store.example.org/p/{sku}')).toEqual([
      'shop.example.com',
      'brand.co.uk',
      'store.example.org',
    ]);
    expect(parseHosts(undefined, undefined)).toEqual([]);
  });
});

describe('stock API display fields are untrusted', () => {
  it('caps and flattens product names', () => {
    const long = cleanProductFields({ name: 'A'.repeat(5000) }).name!;
    expect(long.length).toBe(MAX_NAME_LENGTH);
    expect(long.endsWith('…')).toBe(true);
    expect(cleanProductFields({ name: `Mug\r\nBcc: x@evil.test${String.fromCharCode(0x2028)}line` }).name).toBe('Mug Bcc: x@evil.test line');
    expect(cleanProductFields({ name: '   ' }).name).toBeNull();
    expect(cleanProductFields({ name: 42 }).name).toBeNull();
  });

  it('drops impossible prices and unknown currencies (never shows a price in the wrong currency)', () => {
    expect(cleanProductFields({ price: 24, currency: 'gbp' })).toMatchObject({ price: 24, currency: 'GBP' });
    expect(cleanProductFields({ price: 0, currency: 'GBP' }).price).toBeNull();
    expect(cleanProductFields({ price: -5, currency: 'GBP' }).price).toBeNull();
    expect(cleanProductFields({ price: 1e9, currency: 'GBP' }).price).toBeNull();
    expect(cleanProductFields({ price: 'free', currency: 'GBP' }).price).toBeNull();
    expect(cleanProductFields({ price: 24, currency: 'POUNDS' })).toMatchObject({ price: null, currency: null });
    expect(cleanProductFields({ price: 24 })).toMatchObject({ price: 24, currency: null }); // absent currency: GBP default
  });

  it('only accepts https images', () => {
    expect(cleanProductFields({ image: 'https://img.example.com/a.jpg' }).image).toBe('https://img.example.com/a.jpg');
    expect(cleanProductFields({ image: 'http://img.example.com/a.jpg' }).image).toBeNull();
    expect(cleanProductFields({ image: 'javascript:alert(1)' }).image).toBeNull();
    expect(cleanProductFields({ image: `https://img.example.com/${'a'.repeat(3000)}` }).image).toBeNull();
    expect(safeHttpsUrl('https://u:p@img.example.com/a.jpg')).toBe('');
  });

  it('a hostile stock API response still produces a safe email, and the restock is still confirmed', async () => {
    await signUp({ email: 'cust@example.com', sku: 'MUG-9' });
    up.productOverrides['MUG-9'] = {
      name: `Your order failed. Verify your card at secure-pay-help.example ${'!'.repeat(400)}`,
      price: 0.0001,
      currency: 'XXXX',
      image: 'http://tracker.example/pixel.gif',
    };
    const email = await restockAndGetEmail('MUG-9'); // confirmed despite junk display fields
    const name = /<p class="fg"[^>]*>([^<]*)<\/p>/.exec(email.html)?.[1] ?? '';
    expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(email.subject.length).toBeLessThan(MAX_NAME_LENGTH + 20);
    expect(email.html).not.toContain('tracker.example');
    expect(email.html).not.toMatch(/£0|XXXX/);
  });

  it('a type-confused body (name as object) does not block confirmation', async () => {
    up.productOverrides['MUG-10'] = { name: { evil: true }, price: [1], image: 7 }; // before any good name is cached
    await signUp({ email: 'cust2@example.com', sku: 'MUG-10' });
    const email = await restockAndGetEmail('MUG-10');
    expect(email.subject).toBe("It's back: MUG-10"); // falls back to the SKU
  });
});
