import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { arShared } from '@somar/shared';
import { publicRuntimeConfig, type Config } from '../config.js';

const NO_STORE = 'no-store, no-cache, must-revalidate';

/** Serves the built SPA with the runtime config injected into index.html. */
export async function staticRoutes(app: FastifyInstance, cfg: Config) {
  const root = cfg.WEB_DIST_DIR;
  const indexPath = join(root, 'index.html');
  const hasSpa = existsSync(indexPath);

  let indexHtml = '';
  if (hasSpa) {
    const json = JSON.stringify(publicRuntimeConfig(cfg)).replace(/</g, '\\u003c');
    indexHtml = readFileSync(indexPath, 'utf8').replace(
      '<!--APP_CONFIG-->',
      `<script>window.__APP_CONFIG__=${json};</script>`,
    );
    await app.register(fastifyStatic, {
      root,
      wildcard: true,
      index: false,
      cacheControl: false,
      allowedPath: (pathName) => pathName !== '/index.html',
      setHeaders(res, filePath) {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (/\/(sw\.js|index\.html|manifest\.webmanifest)$/.test(normalized)) res.setHeader('Cache-Control', NO_STORE);
        else res.setHeader('Cache-Control', 'public, max-age=3600');
      },
    });
  } else {
    app.log.warn(`SPA build not found at ${root}; only /api routes are served`);
  }

  const sendIndex = (reply: FastifyReply) =>
    reply.header('Cache-Control', NO_STORE).type('text/html; charset=utf-8').send(indexHtml);

  app.get('/', (_request, reply) => (hasSpa ? sendIndex(reply) : reply.code(404).send()));
  app.get('/index.html', (_request, reply) => (hasSpa ? sendIndex(reply) : reply.code(404).send()));

  app.setNotFoundHandler((request, reply) => {
    const url = request.url.split('?')[0] ?? '';
    if (url.startsWith('/api') || !hasSpa || request.method !== 'GET') {
      return reply.code(404).send({ ok: false, code: 'NOT_FOUND', message_ar: arShared.api.NOT_FOUND });
    }
    if (/\.[a-z0-9]{2,5}$/i.test(url)) {
      return reply.code(404).send();
    }
    return sendIndex(reply);
  });
}
