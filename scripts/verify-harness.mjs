#!/usr/bin/env node
// Cross-checks a run against the challenge harness:
//   node scripts/verify-harness.mjs <harness db.json> <app sqlite db>
// - every notified request has exactly one accepted email with its idempotency key
// - every accepted email belongs to exactly one request (no strays, no doubles)
// - nobody is still waiting for a product the harness says is in stock
import fs from 'node:fs';
import Database from 'better-sqlite3';

const [harnessFile, appDbFile] = process.argv.slice(2);
if (!harnessFile || !appDbFile) {
  console.error('usage: verify-harness.mjs <harness db.json> <app sqlite db>');
  process.exit(2);
}
const harness = JSON.parse(fs.readFileSync(harnessFile, 'utf8'));
const candidates = Object.values(harness.candidates);
const c = candidates.find((x) => x.emails?.length) ?? candidates[0];
const db = new Database(appDbFile, { readonly: true });

const requests = db.prepare('SELECT id, email, sku, status, created_at, next_attempt_at FROM requests').all();
const byKey = new Map();
for (const e of c.emails) {
  if (e.status !== 'accepted') continue;
  const list = byKey.get(e.idempotencyKey) ?? [];
  list.push(e);
  byKey.set(e.idempotencyKey, list);
}
const statusCounts = c.emails.reduce((m, e) => ((m[e.status] = (m[e.status] ?? 0) + 1), m), {});

const problems = [];
let notified = 0;
const known = new Set();
for (const r of requests) {
  const key = `back-in-stock/${r.id}`;
  known.add(key);
  const got = byKey.get(key) ?? [];
  if (r.status === 'notified') {
    notified++;
    if (got.length !== 1) problems.push(`request ${r.id} notified but ${got.length} accepted emails`);
    else if (got[0].to[0] !== r.email) problems.push(`request ${r.id} email went to ${got[0].to[0]}`);
  } else if (got.length > 0 && r.status !== 'sending') {
    problems.push(`request ${r.id} is ${r.status} but the provider accepted an email`);
  }
}
for (const [key, list] of byKey) {
  if (!known.has(key)) problems.push(`accepted email with unknown key ${key} (${list.length})`);
}

const now = Date.now();
const waitingInStock = requests.filter(
  (r) => r.status === 'pending' && (c.stock[r.sku] ?? 0) > 0 && now - Math.max(r.created_at, r.next_attempt_at) > 90_000,
);
for (const r of waitingInStock) problems.push(`request ${r.id} for ${r.sku} still waiting although stock is ${c.stock[r.sku]}`);

const outcomes = db.prepare('SELECT outcome, COUNT(*) n FROM webhook_log GROUP BY outcome').all();
const stockCalls = db.prepare('SELECT COUNT(*) n FROM stock_checks').get().n;

console.log(JSON.stringify({
  requests: requests.length,
  notified,
  pending: requests.filter((r) => r.status === 'pending').length,
  failed: requests.filter((r) => r.status === 'failed').length,
  harnessInbox: statusCounts,
  webhookOutcomes: Object.fromEntries(outcomes.map((o) => [o.outcome, o.n])),
  stockApiCalls: stockCalls,
  problems,
}, null, 2));
process.exit(problems.length ? 1 : 0);
