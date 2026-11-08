import { z } from 'zod';

const url = z
  .string()
  .trim()
  .url()
  .transform((u) => u.replace(/\/+$/, ''));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  STOCK_API_URL: url,
  STOCK_API_KEY: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  RESEND_BASE_URL: url,
  WEBHOOK_SECRET: z.string().min(1),
  ADMIN_PASSWORD: z.string().min(1),
  DATA_DIR: z.string().min(1).default('/data'),
  EMAIL_FROM: z.string().min(3).default('Back in Stock <alerts@example.com>'),
  PUBLIC_URL: z
    .string()
    .trim()
    .optional()
    .transform((u) => (u ? u.replace(/\/+$/, '') : undefined)),
  SHOP_URL: z.string().trim().optional(),
});

export interface Config {
  port: number;
  stockApiUrl: string;
  stockApiKey: string;
  resendApiKey: string;
  resendBaseUrl: string;
  webhookSecret: string;
  adminPassword: string;
  dataDir: string;
  emailFrom: string;
  publicUrl: string | undefined;
  /** Product page link template; `{sku}` is replaced. */
  shopUrl: string;
  /** Tunables (not env-driven; overridden in tests). */
  sweepIntervalMs: number;
  staleSendingMs: number;
  retryBaseMs: number;
  maxAttempts: number;
  stockTimeoutMs: number;
  sendTimeoutMs: number;
  stockFreshMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Only print variable names, never values.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new Error(`Invalid or missing environment variables: ${names.join(', ')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    stockApiUrl: e.STOCK_API_URL,
    stockApiKey: e.STOCK_API_KEY,
    resendApiKey: e.RESEND_API_KEY,
    resendBaseUrl: e.RESEND_BASE_URL,
    webhookSecret: e.WEBHOOK_SECRET,
    adminPassword: e.ADMIN_PASSWORD,
    dataDir: e.DATA_DIR,
    emailFrom: e.EMAIL_FROM,
    publicUrl: e.PUBLIC_URL,
    shopUrl: e.SHOP_URL || 'https://shop.example.com/products/{sku}',
    ...defaultTunables,
  };
}

export const defaultTunables = {
  sweepIntervalMs: 60_000,
  staleSendingMs: 60_000,
  retryBaseMs: 2_000,
  maxAttempts: 10,
  stockTimeoutMs: 3_000,
  sendTimeoutMs: 10_000,
  stockFreshMs: 5_000,
} as const;
