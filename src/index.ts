import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { log } from './log.js';
import { Notifier } from './notifier.js';
import { ResendClient } from './resend.js';
import { StockClient } from './stock.js';

function main() {
  const config = loadConfig();
  const db = openDb(config.dataDir);
  const stock = new StockClient(db, { baseUrl: config.stockApiUrl, apiKey: config.stockApiKey, timeoutMs: config.stockTimeoutMs });
  const resend = new ResendClient({ baseUrl: config.resendBaseUrl, apiKey: config.resendApiKey, timeoutMs: config.sendTimeoutMs });
  const notifier = new Notifier(db, stock, resend, config);
  const app = createApp({ db, config, stock, notifier });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    log.info('listening', { port: info.port, dataDir: config.dataDir });
  });
  notifier.start();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting_down', { signal });
    const force = setTimeout(() => {
      log.error('shutdown_timeout');
      process.exit(1);
    }, 20_000);
    force.unref();
    server.close();
    await notifier.stop(); // lets in-flight sends finish and record their result
    db.close();
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

try {
  main();
} catch (err) {
  log.error('startup_failed', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
