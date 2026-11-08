import { errMessage } from './stock.js';

export interface OutgoingEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
}

export type SendResult =
  | { kind: 'sent'; id: string | null }
  /** Worth trying again (5xx, 409 in-flight idempotent request, 429, network, timeout). */
  | { kind: 'retry'; error: string; retryAfterMs?: number }
  /** Will never succeed as-is (4xx validation, auth). */
  | { kind: 'fatal'; error: string };

export interface ResendClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export class ResendClient {
  constructor(private readonly opts: ResendClientOptions) {}

  async send(email: OutgoingEmail, idempotencyKey: string): Promise<SendResult> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'user-agent': 'back-in-stock-alerts/1',
        },
        body: JSON.stringify(email),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      // We don't know whether the provider got it. The idempotency key makes a retry safe.
      return { kind: 'retry', error: `network: ${errMessage(err)}` };
    }

    const bodyText = await res.text().catch(() => '');
    if (res.ok) {
      let id: string | null = null;
      try {
        id = (JSON.parse(bodyText) as { id?: string }).id ?? null;
      } catch {
        /* 2xx with odd body still means accepted */
      }
      return { kind: 'sent', id };
    }

    const detail = `HTTP ${res.status}${summarise(bodyText)}`;
    if (res.status === 429) {
      return { kind: 'retry', error: detail, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) };
    }
    // 409 = Resend's "same idempotency key still in flight"; 408 = timeout.
    if (res.status >= 500 || res.status === 409 || res.status === 408) return { kind: 'retry', error: detail };
    return { kind: 'fatal', error: detail };
  }
}

function summarise(body: string): string {
  if (!body) return '';
  try {
    const j = JSON.parse(body) as { message?: string; name?: string };
    const msg = j.message || j.name;
    return msg ? `: ${String(msg).slice(0, 200)}` : '';
  } catch {
    return `: ${body.slice(0, 200)}`;
  }
}

export function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}
