import { esc } from '../html.js';

/** A tiny fake product page showing the embed in an iframe, the way a store would use it. */
export function renderHome({ nonce }: { nonce: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Back in Stock · demo store page</title>
<style>
:root{--bg:#f6f5f2;--fg:#141518;--muted:#62666c;--line:#e4e3de;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1012;--fg:#ededeb;--muted:#a5a8ad;--line:#2a2c30;--card:#17181b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:28px 16px 64px}
.note{font-size:13px;color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:10px 12px;margin-bottom:24px}
.note code{font-size:12px}
.grid{display:grid;grid-template-columns:1fr;gap:28px}
@media (min-width:780px){.grid{grid-template-columns:1.1fr 1fr}}
.img{aspect-ratio:1;border-radius:16px;background:#e9e7e1 center/cover no-repeat;background-image:url("https://picsum.photos/seed/HOOD-FLC-GRY-M/900/900")}
h1{font-size:28px;line-height:1.15;margin:4px 0 8px;letter-spacing:-.02em}
.price{font-size:20px;margin:0 0 6px}.so{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#b42318;margin-bottom:18px}
.crumb{font-size:13px;color:var(--muted)}
iframe{width:100%;border:0;height:220px;display:block;color-scheme:normal}
.desc{color:var(--muted);margin-top:22px}
</style>
</head>
<body>
<div class="wrap">
  <p class="note">Demo: a pretend store's product page with the back-in-stock form embedded via
  <code>&lt;iframe src="/embed?sku=HOOD-FLC-GRY-M"&gt;</code>. Admin lives at <a href="/admin">/admin</a>.</p>
  <div class="grid">
    <div class="img" role="img" aria-label="Fleece hoodie, heather grey"></div>
    <div>
      <div class="crumb">Apparel / Hoodies</div>
      <h1>Fleece Hoodie, Heather Grey, M</h1>
      <p class="price">£58</p>
      <span class="so">Sold out</span>
      <iframe id="bis" title="Get an email when this is back in stock" src="/embed?sku=${esc('HOOD-FLC-GRY-M')}" loading="lazy"></iframe>
      <p class="desc">Brushed-back organic cotton fleece, relaxed fit, ribbed cuffs. Made to be worn in.</p>
    </div>
  </div>
</div>
<script nonce="${esc(nonce)}">
window.addEventListener('message',function(e){
  if(e.origin!==location.origin||!e.data||e.data.type!=='back-in-stock:height')return;
  document.getElementById('bis').style.height=e.data.height+'px';
});
</script>
</body>
</html>`;
}
