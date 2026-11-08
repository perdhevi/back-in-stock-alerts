import type { RequestRow, RequestStatus } from '../db.js';
import { esc } from '../html.js';

export interface WebhookLogRow {
  event_id: string | null;
  sku: string | null;
  quantity: number | null;
  outcome: string;
  received_at: number;
  stock_quantity_seen: number | null;
}

export interface AdminView {
  rows: RequestRow[];
  counts: Record<RequestStatus | 'all', number>;
  filter: RequestStatus | 'all';
  q: string;
  limit: number;
  webhooks: WebhookLogRow[];
  stockCalls24h: number;
  emailsToday: number;
  productNames: Map<string, string>;
  now: number;
}

const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'Waiting',
  sending: 'Sending',
  notified: 'Notified',
  failed: 'Failed',
};

const OUTCOME_LABEL: Record<string, [string, string]> = {
  confirmed: ['Restock confirmed', 'ok'],
  not_confirmed: ['Not confirmed', 'warn'],
  sellout: ['Sold out', 'neutral'],
  duplicate: ['Duplicate', 'neutral'],
  bad_secret: ['Bad secret', 'bad'],
  invalid: ['Invalid', 'bad'],
  unverified: ['Stock API down', 'warn'],
  received: ['Received', 'neutral'],
};

function ts(ms: number | null): string {
  if (!ms) return '';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function ago(ms: number | null, now: number): string {
  if (!ms) return '';
  const s = Math.round((now - ms) / 1000);
  const fut = s < 0;
  const a = Math.abs(s);
  const v = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return fut ? `in ${v}` : `${v} ago`;
}

function time(ms: number | null, now: number): string {
  if (!ms) return '<span class="dim">—</span>';
  return `<time datetime="${new Date(ms).toISOString()}" title="${ts(ms)}">${ago(ms, now)}</time>`;
}

function qs(filter: string, q: string): string {
  const p = new URLSearchParams();
  if (filter !== 'all') p.set('status', filter);
  if (q) p.set('q', q);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function renderAdmin(v: AdminView): string {
  const tabs: (RequestStatus | 'all')[] = ['all', 'pending', 'sending', 'notified', 'failed'];
  const tabLabel = (t: RequestStatus | 'all') => (t === 'all' ? 'All' : STATUS_LABEL[t]);

  const rows = v.rows
    .map((r) => {
      const name = v.productNames.get(r.sku);
      const retry =
        r.status === 'pending' && r.attempts > 0 ? `<div class="dim small">retry ${time(r.next_attempt_at, v.now)}</div>` : '';
      return `<tr>
  <td data-l="Customer"><span class="email">${esc(r.email)}</span></td>
  <td data-l="Product"><code>${esc(r.sku)}</code>${name ? `<div class="dim small">${esc(name)}</div>` : ''}</td>
  <td data-l="Status"><span class="pill s-${r.status}">${STATUS_LABEL[r.status]}</span>${retry}</td>
  <td data-l="Requested">${time(r.created_at, v.now)}</td>
  <td data-l="Notified">${time(r.notified_at, v.now)}</td>
  <td data-l="Attempts" class="num">${r.attempts}</td>
  <td data-l="Last error" class="err">${r.last_error ? `<span title="${esc(r.last_error)}">${esc(r.last_error)}</span>` : '<span class="dim">—</span>'}</td>
</tr>`;
    })
    .join('');

  const hooks = v.webhooks
    .map((w) => {
      const [label, tone] = OUTCOME_LABEL[w.outcome] ?? [w.outcome, 'neutral'];
      return `<tr>
  <td data-l="Received">${time(w.received_at, v.now)}</td>
  <td data-l="Event"><code>${esc(w.event_id ?? '—')}</code></td>
  <td data-l="SKU"><code>${esc(w.sku ?? '—')}</code></td>
  <td data-l="Claimed" class="num">${w.quantity ?? '—'}</td>
  <td data-l="Stock API" class="num">${w.stock_quantity_seen ?? '<span class="dim">—</span>'}</td>
  <td data-l="Outcome"><span class="pill o-${tone}">${esc(label)}</span></td>
</tr>`;
    })
    .join('');

  const stat = (label: string, value: number, cls: string) =>
    `<div class="stat ${cls}"><span class="k">${label}</span><span class="v">${value.toLocaleString('en-GB')}</span></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>Back in Stock · Admin</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--fg:#141518;--muted:#62666c;--dim:#9a9ea4;--line:#e4e3de;--head:#faf9f6;
--ok:#0f7a43;--ok-bg:#e6f4ec;--warn:#8a5a00;--warn-bg:#fff2d1;--bad:#b42318;--bad-bg:#fde8e6;--info:#2453c7;--info-bg:#e8eefc;--n-bg:#efeeea;--accent:#141518}
@media (prefers-color-scheme:dark){:root{--bg:#0f1012;--card:#17181b;--fg:#ededeb;--muted:#a5a8ad;--dim:#6d7177;--line:#2a2c30;--head:#1b1c20;
--ok:#5fd394;--ok-bg:#11281b;--warn:#f2c35b;--warn-bg:#2b230f;--bad:#ff8b80;--bad-bg:#2e1614;--info:#8eaeff;--info-bg:#18213a;--n-bg:#24262a;--accent:#ededeb}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1180px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.brand{display:flex;align-items:center;gap:10px}
.logo{width:34px;height:34px;border-radius:9px;background:var(--accent);color:var(--bg);display:grid;place-items:center}
h1{font-size:18px;margin:0;letter-spacing:-.01em}
.sub{color:var(--muted);font-size:13px;margin:0}
h2{font-size:15px;margin:32px 0 10px;display:flex;align-items:baseline;gap:8px}
h2 .dim{font-weight:400;font-size:13px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:10px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}
.stat .k{color:var(--muted);font-size:12px;font-weight:500}
.stat .v{font-size:24px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat.pending .v{color:var(--info)}.stat.notified .v{color:var(--ok)}.stat.failed .v{color:var(--bad)}.stat.sending .v{color:var(--warn)}
.bar{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:10px}
nav.tabs{display:flex;gap:4px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:3px;overflow-x:auto;max-width:100%}
nav.tabs a{padding:6px 12px;border-radius:7px;color:var(--muted);text-decoration:none;font-weight:550;white-space:nowrap;font-size:13px}
nav.tabs a:hover{color:var(--fg)}
nav.tabs a[aria-current=page]{background:var(--fg);color:var(--bg)}
nav.tabs .c{opacity:.7;font-variant-numeric:tabular-nums;margin-left:4px}
form.search{display:flex;gap:6px;flex:1 1 240px;max-width:360px}
form.search input{flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg);font:inherit}
form.search button,.btn{height:36px;padding:0 14px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}
th{position:sticky;top:0;background:var(--head);text-align:left;font-size:12px;font-weight:600;color:var(--muted);padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:color-mix(in srgb,var(--head) 70%,transparent)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.email{font-weight:550;overflow-wrap:anywhere}
.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}.small{font-size:12px;margin-top:2px}
td.err{max-width:260px;color:var(--bad);font-size:12.5px}
td.err span{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
time{white-space:nowrap}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.s-pending{background:var(--info-bg);color:var(--info)}.s-sending{background:var(--warn-bg);color:var(--warn)}
.s-notified{background:var(--ok-bg);color:var(--ok)}.s-failed{background:var(--bad-bg);color:var(--bad)}
.o-ok{background:var(--ok-bg);color:var(--ok)}.o-warn{background:var(--warn-bg);color:var(--warn)}.o-bad{background:var(--bad-bg);color:var(--bad)}.o-neutral{background:var(--n-bg);color:var(--muted)}
.empty{padding:36px 16px;text-align:center;color:var(--muted)}
.foot{color:var(--muted);font-size:12px;margin-top:8px}
@media (max-width:760px){
  thead{display:none}
  table,tbody,tr,td{display:block;width:100%}
  tr{padding:10px 14px;border-bottom:1px solid var(--line)}
  tr:last-child{border-bottom:0}
  td{border:0;padding:3px 0;display:flex;gap:12px;justify-content:space-between;text-align:right}
  td::before{content:attr(data-l);color:var(--muted);font-size:12px;font-weight:500;text-align:left;flex:none}
  td.num{text-align:right}
  td.err{max-width:none}
  td > div{text-align:right}
  tbody tr:hover td{background:none}
}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="brand">
    <span class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2.2 2.2 0 0 0 4 0"/></svg></span>
    <div><h1>Back in Stock</h1><p class="sub">Restock alerts · admin</p></div>
  </div>
  <a class="btn" href="/admin${qs(v.filter, v.q)}">Refresh</a>
</header>

<section class="stats" aria-label="Totals">
  ${stat('Waiting', v.counts.pending, 'pending')}
  ${stat('Sending', v.counts.sending, 'sending')}
  ${stat('Notified', v.counts.notified, 'notified')}
  ${stat('Failed', v.counts.failed, 'failed')}
  ${stat('Sent (24h)', v.emailsToday, '')}
  ${stat('Stock checks (24h)', v.stockCalls24h, '')}
</section>

<div class="bar">
  <nav class="tabs" aria-label="Filter by status">
    ${tabs
      .map(
        (t) =>
          `<a href="/admin${qs(t, v.q)}"${t === v.filter ? ' aria-current="page"' : ''}>${tabLabel(t)}<span class="c">${v.counts[t].toLocaleString('en-GB')}</span></a>`,
      )
      .join('')}
  </nav>
  <form class="search" method="get" action="/admin" role="search">
    ${v.filter !== 'all' ? `<input type="hidden" name="status" value="${esc(v.filter)}">` : ''}
    <label class="dim" for="q" style="position:absolute;left:-9999px">Search email or SKU</label>
    <input id="q" name="q" value="${esc(v.q)}" placeholder="Search email or SKU" autocomplete="off">
    <button type="submit">Search</button>
  </form>
</div>

<div class="card">
${
  rows
    ? `<table>
<thead><tr><th>Customer</th><th>Product</th><th>Status</th><th>Requested</th><th>Notified</th><th class="num">Attempts</th><th>Last error</th></tr></thead>
<tbody>${rows}</tbody></table>`
    : `<div class="empty">${v.q ? 'No requests match that search.' : 'No requests here yet.'}</div>`
}
</div>
${v.rows.length >= v.limit ? `<p class="foot">Showing the latest ${v.limit}. Narrow it down with a filter or search.</p>` : ''}

<h2>Recent webhooks <span class="dim">last ${v.webhooks.length}</span></h2>
<div class="card">
${
  hooks
    ? `<table>
<thead><tr><th>Received</th><th>Event</th><th>SKU</th><th class="num">Claimed qty</th><th class="num">Stock API qty</th><th>Outcome</th></tr></thead>
<tbody>${hooks}</tbody></table>`
    : '<div class="empty">No webhooks received yet.</div>'
}
</div>
<p class="foot">Times are relative; hover for UTC. Webhook quantities are only a hint: every restock is confirmed with the stock API before anyone is emailed.</p>
</div>
</body>
</html>`;
}
