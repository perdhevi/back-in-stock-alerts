import type { RequestRow } from './db.js';
import type { StockInfo } from './stock.js';
import { esc, formatDate, formatPrice, isAllowedHost, safeHttpsUrl, safeUrl } from './html.js';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailContext {
  request: Pick<RequestRow, 'email' | 'sku' | 'created_at' | 'product_url'>;
  product: StockInfo;
  shopUrl: string;
  /** Allowed hosts for a per-request product link; see Config.shopHosts. */
  shopHosts: readonly string[];
}

/**
 * The button link. A per-request link (from the embed) is only used if its
 * host is allowlisted: otherwise anyone could sign up a victim and have us
 * email them a link of the attacker's choosing. Checked again here, not just
 * at sign-up, so rows stored before a config change are covered too.
 */
export function productLink(
  request: Pick<RequestRow, 'sku' | 'product_url'>,
  shopUrlTemplate: string,
  shopHosts: readonly string[],
): string {
  if (request.product_url && isAllowedHost(request.product_url, shopHosts)) return safeUrl(request.product_url);
  return safeUrl(shopUrlTemplate.replaceAll('{sku}', encodeURIComponent(request.sku)), 'https://shop.example.com/');
}

/**
 * Table-based, single column, max 600px, inline styles: the layout email
 * clients actually agree on. Dark-mode aware via color-scheme + a media query
 * for clients that honour <style>; falls back to a light palette otherwise.
 */
export function renderBackInStockEmail({ request, product, shopUrl, shopHosts }: EmailContext): EmailContent {
  const name = product.name || request.sku;
  const price = formatPrice(product.price, product.currency);
  const link = productLink(request, shopUrl, shopHosts);
  const image = safeHttpsUrl(product.image); // loaded automatically by the client: https only
  const asked = formatDate(request.created_at);
  const lowStock = product.quantity > 0 && product.quantity <= 5;

  const subject = `It's back: ${name}`;
  const preheader = `${name} is back in stock${price ? ` at ${price}` : ''}. Grab it before it goes again.`;

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(subject)}</title>
<style>
  body,table,td{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  img{border:0;line-height:100%;outline:none;text-decoration:none;display:block}
  a{text-decoration:none}
  @media (max-width:620px){
    .container{width:100%!important}
    .px{padding-left:24px!important;padding-right:24px!important}
    .h1{font-size:26px!important;line-height:32px!important}
  }
  @media (prefers-color-scheme:dark){
    .bg{background:#0f1012!important}
    .card{background:#1a1c1f!important}
    .panel{background:#232528!important}
    .fg{color:#f2f2f0!important}
    .muted{color:#a3a6aa!important}
    .rule{border-color:#2c2f33!important}
    .btn{background:#f2f2f0!important}
    .btn a{color:#111214!important}
    .pill{background:#2a2410!important;color:#f5cf63!important}
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#f4f3ef;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f3ef">
<tr><td align="center" style="padding:32px 12px">
  <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
    <tr><td class="px fg" style="padding:0 32px 18px;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#111214;font-weight:700">
      Back in stock
    </td></tr>
    <tr><td>
      <table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border-radius:16px;overflow:hidden">
        <tr><td class="px" style="padding:36px 40px 0">
          <h1 class="h1 fg" style="margin:0 0 10px;font-size:30px;line-height:36px;color:#111214;font-weight:700">Good news: it&rsquo;s back.</h1>
          <p class="muted" style="margin:0;font-size:16px;line-height:24px;color:#3d4045">You asked us to tell you when this was back in stock, so here we are. Popular items tend to go quickly, so if you still want it, now&rsquo;s the time.</p>
        </td></tr>
        <tr><td class="px" style="padding:24px 40px 0">
          <table role="presentation" class="panel" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f3ef;border-radius:12px">
            ${
              image
                ? `<tr><td align="center" style="padding:24px 24px 4px"><a href="${esc(link)}"><img src="${esc(image)}" width="280" height="280" alt="${esc(name)}" style="width:280px;max-width:100%;height:auto;border-radius:10px;background:#e9e7e1"></a></td></tr>`
                : ''
            }
            <tr><td align="center" style="padding:16px 24px 22px">
              <p class="fg" style="margin:0 0 4px;font-size:18px;line-height:26px;color:#111214;font-weight:600">${esc(name)}</p>
              ${price ? `<p class="muted" style="margin:0;font-size:16px;line-height:24px;color:#5c5f63">${esc(price)}</p>` : ''}
              ${
                lowStock
                  ? `<p style="margin:10px 0 0"><span class="pill" style="display:inline-block;background:#fff4d6;color:#7a5600;font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px">Only ${esc(product.quantity)} left</span></p>`
                  : ''
              }
            </td></tr>
          </table>
        </td></tr>
        <tr><td class="px" align="center" style="padding:24px 40px 36px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            <td class="btn" align="center" bgcolor="#111214" style="border-radius:10px;background:#111214">
              <a href="${esc(link)}" style="display:inline-block;padding:15px 44px;font-size:16px;font-weight:700;color:#ffffff;border-radius:10px">Shop now&nbsp;&rarr;</a>
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
    <tr><td class="px muted" style="padding:22px 32px 0;font-size:13px;line-height:20px;color:#6f7378">
      You&rsquo;re getting this one-time email because ${esc(request.email)} asked to be told when ${esc(name)} was back${asked ? ` (on ${esc(asked)})` : ''}. We won&rsquo;t email you about it again.
    </td></tr>
    <tr><td class="px muted" style="padding:10px 32px 0;font-size:12px;line-height:18px;color:#8d9095">
      Item ${esc(request.sku)}. Stock is limited and not reserved for you.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    `Good news: it's back.`,
    ``,
    `${name}${price ? ` (${price})` : ''} is back in stock.${lowStock ? ` Only ${product.quantity} left.` : ''}`,
    ``,
    `Shop now: ${link}`,
    ``,
    `You're getting this one-time email because ${request.email} asked to be told when ${name} was back${asked ? ` (on ${asked})` : ''}. We won't email you about it again.`,
    `Item ${request.sku}. Stock is limited and not reserved for you.`,
  ].join('\n');

  return { subject, html, text };
}
