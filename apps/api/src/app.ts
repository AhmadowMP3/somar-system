import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { arShared } from '@somar/shared';
import type { Config } from './config.js';
import { makeAuthGuard, type AppContext } from './lib/auth.js';
import { ApiError } from './lib/errors.js';
import { createAdminClient } from './lib/supabase.js';
import { meRoutes } from './routes/me.js';
import { probeRoutes } from './routes/probe.js';
import { notificationRoutes } from './routes/notifications.js';
import { scanRoutes } from './routes/scan.js';
import { staffRoutes } from './routes/staff.js';
import { staticRoutes } from './routes/static.js';
import { studentRoutes } from './routes/students.js';
import { createPushService, type PushService } from './services/push.js';

export type BuiltApp = { app: FastifyInstance; ctx: AppContext & { push: PushService } };

export async function buildApp(cfg: Config, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  const db = createAdminClient(cfg);
  const ctx = { cfg, db, requireRole: makeAuthGuard(db) };
  const push = createPushService(cfg, db, (msg) => app.log.warn(msg));

  app.decorateRequest('auth', null);
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 20 } });

  app.setErrorHandler((error: FastifyError | ApiError | ZodError, request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .code(error.status)
        .send({ ok: false, code: error.code, message_ar: error.messageAr, details: error.details });
    }
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ ok: false, code: 'VALIDATION', message_ar: arShared.api.VALIDATION, details: error.flatten() });
    }
    const status = (error as FastifyError).statusCode;
    if (status === 413 || (error as FastifyError).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ ok: false, code: 'PHOTO_SIZE', message_ar: arShared.api.PHOTO_SIZE });
    }
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ ok: false, code: 'VALIDATION', message_ar: arShared.api.VALIDATION });
    }
    request.log.error(error);
    return reply.code(500).send({ ok: false, code: 'INTERNAL', message_ar: arShared.api.INTERNAL });
  });

  app.get('/api/healthz', async () => {
    let dbState: 'up' | 'down' = 'down';
    if (cfg.SUPABASE_URL && cfg.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const res = await Promise.race([
          db.from('settings').select('id').limit(1),
          new Promise<{ error: Error }>((resolve) => setTimeout(() => resolve({ error: new Error('timeout') }), 3000)),
        ]);
        dbState = res.error ? 'down' : 'up';
      } catch {
        dbState = 'down';
      }
    }
    return { ok: true, version: cfg.version, db: dbState };
  });

  await app.register(async (scope) => {
    await studentRoutes(scope, ctx);
    await meRoutes(scope, ctx);
    await staffRoutes(scope, ctx);
    await scanRoutes(scope, ctx);
    await notificationRoutes(scope, { ...ctx, push });
  });
  await probeRoutes(app, cfg);
  await staticRoutes(app, cfg);

  return { app, ctx: { ...ctx, push } };
}
