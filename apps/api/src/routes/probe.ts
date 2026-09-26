import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { unauthorized } from '../lib/errors.js';

const MAX_PROBE_BYTES = 64 * 1024 * 1024;

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Upload-size probe for `npm run doctor`: streams the request body, counts bytes and discards them, so a 413
 * from a reverse proxy (Traefik / Kong) in front of the app is detected before a real import. Service key only.
 */
export async function probeRoutes(app: FastifyInstance, cfg: Config) {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => done(null, payload));
    scope.post('/api/_probe/upload', async (request) => {
      const auth = request.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!cfg.SUPABASE_SERVICE_ROLE_KEY || !token || !sameSecret(token, cfg.SUPABASE_SERVICE_ROLE_KEY)) throw unauthorized();
      let bytes = 0;
      for await (const chunk of request.body as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > MAX_PROBE_BYTES) break;
      }
      return { ok: true, bytes };
    });
  });
}
