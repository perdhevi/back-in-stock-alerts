import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isUniqueViolation, type DB, type RequestRow } from './db.js';

export const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;

export const NewRequestSchema = z.object({
  email: z
    .string({ error: 'Enter your email address.' })
    .trim()
    .toLowerCase()
    .min(1, 'Enter your email address.')
    .max(254, 'That email address is too long.')
    .pipe(z.email({ error: 'Enter a valid email address, like name@example.com.' })),
  sku: z
    .string({ error: 'Missing product.' })
    .trim()
    .regex(SKU_RE, 'That product code doesn’t look right.'),
  product_url: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .transform((u) => {
      if (!u) return undefined;
      try {
        const url = new URL(u);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
      } catch {
        return undefined;
      }
    }),
});
export type NewRequest = z.infer<typeof NewRequestSchema>;

export interface CreateResult {
  created: boolean;
  request: RequestRow;
}

/**
 * Insert-or-return-existing. The partial unique index is the arbiter, not a
 * read-then-write, so two concurrent submissions can never both create a row.
 */
export function createRequest(db: DB, input: NewRequest, source: 'api' | 'embed'): CreateResult {
  const now = Date.now();
  const row: RequestRow = {
    id: randomUUID(),
    email: input.email,
    sku: input.sku,
    status: 'pending',
    product_url: input.product_url ?? null,
    source,
    created_at: now,
    claimed_at: null,
    notified_at: null,
    attempts: 0,
    next_attempt_at: now,
    last_error: null,
    resend_email_id: null,
  };
  try {
    db.prepare(
      `INSERT INTO requests (id, email, sku, status, product_url, source, created_at, attempts, next_attempt_at)
       VALUES (@id, @email, @sku, 'pending', @product_url, @source, @created_at, 0, @next_attempt_at)`,
    ).run(row);
    return { created: true, request: row };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = db
      .prepare(`SELECT * FROM requests WHERE email = ? AND sku = ? AND status IN ('pending','sending')`)
      .get(input.email, input.sku) as RequestRow | undefined;
    // Vanishingly rare: the open row was notified between our INSERT and SELECT. Try once more.
    if (!existing) return createRequest(db, input, source);
    return { created: false, request: existing };
  }
}

export function publicRequest(r: RequestRow) {
  return {
    id: r.id,
    email: r.email,
    sku: r.sku,
    status: r.status,
    created_at: new Date(r.created_at).toISOString(),
    notified_at: r.notified_at ? new Date(r.notified_at).toISOString() : null,
  };
}
