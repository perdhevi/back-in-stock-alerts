import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

export type RequestStatus = 'pending' | 'sending' | 'notified' | 'failed';

export interface RequestRow {
  id: string;
  email: string;
  sku: string;
  status: RequestStatus;
  product_url: string | null;
  source: string;
  created_at: number;
  claimed_at: number | null;
  notified_at: number | null;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  resend_email_id: string | null;
}

export interface ProductRow {
  sku: string;
  name: string | null;
  price: number | null;
  currency: string | null;
  image: string | null;
  quantity: number;
  in_stock: number;
  checked_at: number;
}

/**
 * Migrations are append-only. Each runs once inside a transaction and is
 * recorded in schema_migrations, so boot is safe to repeat.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE requests (
    id              TEXT PRIMARY KEY,
    email           TEXT NOT NULL,
    sku             TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending','sending','notified','failed')),
    product_url     TEXT,
    source          TEXT NOT NULL DEFAULT 'api',
    created_at      INTEGER NOT NULL,
    claimed_at      INTEGER,
    notified_at     INTEGER,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    resend_email_id TEXT
  );
  -- One open request per customer + product, enforced by the database.
  CREATE UNIQUE INDEX requests_one_open ON requests (email, sku) WHERE status IN ('pending','sending');
  CREATE INDEX requests_due ON requests (status, sku, next_attempt_at);
  CREATE INDEX requests_created ON requests (created_at DESC);

  -- Authenticated, well-formed events only. event_id is the dedupe key.
  CREATE TABLE webhook_events (
    event_id            TEXT PRIMARY KEY,
    type                TEXT,
    sku                 TEXT NOT NULL,
    claimed_quantity    INTEGER NOT NULL,
    occurred_at         TEXT,
    received_at         INTEGER NOT NULL,
    outcome             TEXT NOT NULL,
    stock_quantity_seen INTEGER,
    deliveries          INTEGER NOT NULL DEFAULT 1
  );

  -- Every delivery attempt, including rejected and duplicate ones (admin view).
  CREATE TABLE webhook_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    TEXT,
    sku         TEXT,
    quantity    INTEGER,
    outcome     TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX webhook_log_recent ON webhook_log (received_at DESC);

  -- Latest known product info + stock, refreshed by every stock API call.
  CREATE TABLE products (
    sku        TEXT PRIMARY KEY,
    name       TEXT,
    price      REAL,
    currency   TEXT,
    image      TEXT,
    quantity   INTEGER NOT NULL,
    in_stock   INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
  );

  CREATE TABLE stock_checks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sku        TEXT NOT NULL,
    quantity   INTEGER,
    in_stock   INTEGER,
    reason     TEXT NOT NULL,
    error      TEXT,
    checked_at INTEGER NOT NULL
  );
  CREATE INDEX stock_checks_recent ON stock_checks (checked_at DESC);
  `,
];

export function openDb(dataDir: string, filename = 'back-in-stock.db'): DB {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, filename);
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );
  MIGRATIONS.forEach((sql, i) => {
    const version = i + 1;
    if (applied.has(version)) return;
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    })();
  });
}

export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}
