import { esc } from '../html.js';

export type EmbedState =
  | { kind: 'form'; error?: string; email?: string }
  | { kind: 'created'; email: string }
  | { kind: 'already'; email: string }
  | { kind: 'in_stock'; email: string };

export interface EmbedView {
  sku: string | undefined;
  productName: string | null;
  productUrl: string | undefined;
  accent: string;
  nonce: string;
  state: EmbedState;
}

/** Accept only #rgb / #rrggbb so the store can theme the button safely. */
export function parseAccent(v: string | undefined): string {
  return v && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? (v.startsWith('#') ? v : `#${v}`) : '#111214';
}

const icons = {
  check:
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.2 4.2L19 7"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2.2 2.2 0 0 0 4 0"/></svg>',
  bag: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 8h14l-1 12H6L5 8zM9 8V6.5a3 3 0 0 1 6 0V8"/></svg>',
};

function resultBlock(state: Exclude<EmbedState, { kind: 'form' }>, productName: string | null): string {
  const item = productName ? `<strong>${esc(productName)}</strong>` : 'this item';
  const email = `<strong>${esc(state.email)}</strong>`;
  const copy = {
    created: {
      icon: icons.check,
      tone: 'ok',
      title: 'You’re on the list',
      body: `We’ll email ${email} once, the moment ${item} is back in stock.`,
    },
    already: {
      icon: icons.check,
      tone: 'ok',
      title: 'You’re already on the list',
      body: `${email} is already signed up for ${item}. We’ll only email you once.`,
    },
    in_stock: {
      icon: icons.bag,
      tone: 'stock',
      title: 'Good news: it’s in stock now',
      body: `${productName ? item : 'This item'} is available right now. We’ve also sent a link to ${email} so you don’t lose it.`,
    },
  }[state.kind];
  return `<div class="result ${copy.tone}" role="status" tabindex="-1" id="result">
    <span class="badge">${copy.icon}</span>
    <div><p class="title">${copy.title}</p><p class="body">${copy.body}</p></div>
  </div>`;
}

export function renderEmbed(v: EmbedView): string {
  const s = v.state;
  const showForm = s.kind === 'form';
  const error = s.kind === 'form' ? s.error : undefined;
  const email = s.kind === 'form' ? s.email ?? '' : '';
  const heading = v.productName ? `Get an email when it’s back` : 'Get an email when it’s back';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Notify me when it’s back</title>
<style>
:root{
  --accent:${esc(v.accent)};
  --bg:#ffffff;--fg:#111214;--muted:#5d6166;--line:#dcdcd7;--field:#ffffff;--soft:#f5f4f0;
  --ok:#0f7a43;--ok-bg:#e8f5ee;--stock:#7a5600;--stock-bg:#fff4d6;--err:#b42318;--err-bg:#fdecea;
  --radius:12px;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#141517;--fg:#f2f2f0;--muted:#a3a6aa;--line:#34373b;--field:#1c1e21;--soft:#1c1e21;
  --ok:#57d18f;--ok-bg:#12291d;--stock:#f5cf63;--stock-bg:#2a2410;--err:#ff8a7e;--err-bg:#2d1513;
}}
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{color:var(--fg);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.card{background:var(--bg);border:1px solid var(--line);border-radius:16px;padding:18px;max-width:460px;margin:0 auto}
.head{display:flex;gap:12px;align-items:flex-start;margin-bottom:14px}
.head .ico{flex:none;width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--soft);color:var(--fg)}
h1{font-size:16px;line-height:1.3;margin:2px 0 2px;font-weight:650;letter-spacing:-.01em}
.sub{margin:0;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;font-weight:600;margin:0 0 6px}
.row{display:flex;gap:8px;flex-wrap:wrap}
input[type=email],input[type=text]{flex:1 1 200px;min-width:0;height:46px;padding:0 14px;font:inherit;font-size:16px;color:var(--fg);background:var(--field);border:1px solid var(--line);border-radius:var(--radius);outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
input[aria-invalid=true]{border-color:var(--err)}
.field+.field{margin-top:12px}
button{flex:1 0 auto;height:46px;padding:0 20px;font:inherit;font-weight:650;font-size:15px;color:#fff;background:var(--accent);border:0;border-radius:var(--radius);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;transition:filter .15s,transform .05s}
button:hover{filter:brightness(1.12)}button:active{transform:translateY(1px)}
button:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
button[disabled]{opacity:.7;cursor:progress}
.spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite;display:none}
.busy .spin{display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}
.err{display:flex;gap:6px;align-items:flex-start;margin:8px 0 0;color:var(--err);font-size:13px;font-weight:500}
.err[hidden]{display:none}
.fine{margin:12px 0 0;color:var(--muted);font-size:12px}
.result{display:flex;gap:12px;align-items:flex-start;outline:none}
.result .badge{flex:none;width:38px;height:38px;border-radius:50%;display:grid;place-items:center}
.result.ok .badge{background:var(--ok-bg);color:var(--ok)}
.result.stock .badge{background:var(--stock-bg);color:var(--stock)}
.result .title{margin:2px 0 2px;font-weight:650;font-size:16px}
.result .body{margin:0;color:var(--muted);font-size:14px}
.result .body strong{color:var(--fg);font-weight:600;word-break:break-word}
.again{margin-top:12px;font-size:13px}
.again a{color:var(--muted)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>
</head>
<body>
<main class="card" id="card">
${
  showForm
    ? `<div class="head">
    <span class="ico">${icons.bell}</span>
    <div>
      <h1>${heading}</h1>
      <p class="sub">${v.productName ? `${esc(v.productName)} is sold out right now.` : 'This item is sold out right now.'} Leave your email and we’ll let you know the moment it’s back.</p>
    </div>
  </div>
  <form id="f" method="post" action="/api/requests" novalidate>
    ${v.sku ? `<input type="hidden" name="sku" value="${esc(v.sku)}">` : ''}
    <input type="hidden" name="product_url" id="product_url" value="${esc(v.productUrl ?? '')}">
    <input type="hidden" name="accent" value="${esc(v.accent)}">
    ${
      v.sku
        ? ''
        : `<div class="field"><label for="sku">Product code</label>
      <div class="row"><input type="text" id="sku" name="sku" required autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. TEE-ORG-WHT-M"></div></div>`
    }
    <div class="field">
      <label for="email">Email address</label>
      <div class="row">
        <input type="email" id="email" name="email" value="${esc(email)}" required autocomplete="email" inputmode="email" placeholder="you@example.com" aria-describedby="email-err" ${error ? 'aria-invalid="true"' : ''}>
        <button type="submit" id="go"><span class="spin" aria-hidden="true"></span><span>Notify me</span></button>
      </div>
      <p class="err" id="email-err" role="alert" ${error ? '' : 'hidden'}>${esc(error ?? '')}</p>
    </div>
  </form>
  <p class="fine">One email when it’s back in stock. No marketing, no list.</p>`
    : resultBlock(s, v.productName)
}
</main>
<div class="sr" aria-live="polite" id="live"></div>
<script nonce="${esc(v.nonce)}">
(function(){
  var card=document.getElementById('card');
  function post(){try{parent.postMessage({type:'back-in-stock:height',height:Math.ceil(document.documentElement.scrollHeight)},'*')}catch(e){}}
  if('ResizeObserver' in window){new ResizeObserver(post).observe(card)}else{window.addEventListener('load',post)}
  post();
  var pu=document.getElementById('product_url');
  if(pu&&!pu.value&&document.referrer&&/^https?:/.test(document.referrer)){pu.value=document.referrer}
  var r=document.getElementById('result');if(r){r.focus()}
  var f=document.getElementById('f');if(!f||!window.fetch)return;
  var em=document.getElementById('email'),err=document.getElementById('email-err'),btn=document.getElementById('go');
  function showErr(m){err.textContent=m;err.hidden=false;em.setAttribute('aria-invalid','true');em.focus()}
  em.addEventListener('input',function(){if(!err.hidden){err.hidden=true;em.removeAttribute('aria-invalid')}});
  f.addEventListener('submit',function(ev){
    ev.preventDefault();
    var v=em.value.trim();
    if(!v||!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v)){showErr('Enter a valid email address, like name@example.com.');return}
    var data={};new FormData(f).forEach(function(val,k){data[k]=val});data.email=v;
    btn.disabled=true;btn.classList.add('busy');
    fetch('/api/requests?view=embed',{method:'POST',headers:{'content-type':'application/json','accept':'text/html'},body:JSON.stringify(data)})
      .then(function(res){return res.text().then(function(t){return{status:res.status,t:t}})})
      .then(function(x){
        var doc=new DOMParser().parseFromString(x.t,'text/html');
        if(x.status===400){
          var se=doc.getElementById('email-err');
          btn.disabled=false;btn.classList.remove('busy');
          showErr(se&&se.textContent?se.textContent:'Please check your email address.');return;
        }
        var next=doc.getElementById('card');
        if(x.status>=300||!next||!doc.getElementById('result'))throw new Error();
        card.innerHTML=next.innerHTML;
        var res=document.getElementById('result');
        document.getElementById('live').textContent=res.textContent.replace(/\\s+/g,' ').trim();res.focus();
        post();
      })
      .catch(function(){btn.disabled=false;btn.classList.remove('busy');showErr('Something went wrong on our side. Please try again.')});
  });
})();
</script>
</body>
</html>`;
}
