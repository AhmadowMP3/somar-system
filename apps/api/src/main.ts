import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { startCron } from './jobs/cron.js';
import { sharpSelfTest } from './services/images.js';

const cfg = loadConfig();
const { app, ctx } = await buildApp(cfg);

const sharpError = await sharpSelfTest();
if (sharpError) {
  app.log.error(`sharp failed to load — photo and logo uploads will fail: ${sharpError}`);
}
if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
  app.log.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set; the API cannot reach the database');
}
if (!ctx.push.enabled) {
  app.log.warn('VAPID keys are not set; web push is disabled (in-app notifications still work)');
}

const stopCron = cfg.DISABLE_CRON ? () => undefined : startCron(ctx.db, ctx.push, app.log);

const shutdown = async () => {
  stopCron();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await app.listen({ port: cfg.PORT, host: cfg.HOST });
