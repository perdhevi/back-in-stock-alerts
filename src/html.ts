const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape for HTML text and double/single-quoted attributes. */
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/** Only allow http(s) URLs into href/src attributes. */
export function safeUrl(v: string | null | undefined, fallback = '#'): string {
  if (!v) return fallback;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : fallback;
  } catch {
    return fallback;
  }
}

/** https only, for anything the recipient's client loads automatically (images). */
export function safeHttpsUrl(v: string | null | undefined): string {
  if (!v || v.length > 2000) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : '';
  } catch {
    return '';
  }
}

/**
 * True if `url` is http(s) and its host is one of `hosts` or a subdomain of one.
 * "example.com" allows example.com and shop.example.com, not evil-example.com.
 */
export function isAllowedHost(url: string | null | undefined, hosts: readonly string[]): boolean {
  if (!url || hosts.length === 0) return false;
  try {
    const u = new URL(url);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function formatPrice(price: number | null, currency: string | null): string | null {
  if (price == null || !Number.isFinite(price)) return null;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: currency || 'GBP',
      minimumFractionDigits: Number.isInteger(price) ? 0 : 2,
    }).format(price);
  } catch {
    return `${price.toFixed(2)} ${currency ?? ''}`.trim();
  }
}

export function formatDate(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}
