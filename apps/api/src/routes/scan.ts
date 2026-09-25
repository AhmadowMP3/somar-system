import type { FastifyInstance } from 'fastify';
import { arShared, scanRequestSchema, type ScanResult } from '@somar/shared';
import { toPublicUrl } from '../config.js';
import { authOf, type AppContext } from '../lib/auth.js';
import { ApiError } from '../lib/errors.js';
import { createUserClient } from '../lib/supabase.js';

export async function scanRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg, requireRole } = ctx;
  const scanners = requireRole('admin', 'university_supervisor', 'supervisor');

  /** Runs perform_scan() as the signed-in supervisor and attaches a signed photo URL. */
  app.post('/api/scan', { preHandler: scanners }, async (request) => {
    const auth = authOf(request);
    const body = scanRequestSchema.parse(request.body);
    const userDb = createUserClient(cfg, auth.token);
    const { data, error } = await userDb.rpc('perform_scan', {
      p_qr_token: body.qr_token ?? null,
      p_transport_number: body.transport_number ?? null,
      p_lat: body.lat ?? null,
      p_lng: body.lng ?? null,
      p_accuracy: body.accuracy ?? null,
      p_geo_denied: body.geo_denied ?? false,
      p_override_reason: body.override_reason ?? null,
    });
    if (error || !data) throw new ApiError(500, 'INTERNAL');
    const result = data as ScanResult;
    if (!result.ok) {
      return { ...result, message_ar: result.message_ar || arShared.scanCodes[result.code] || '' };
    }
    if (result.student.photo_path) {
      const { data: signed } = await db.storage
        .from(cfg.SUPABASE_PHOTO_BUCKET)
        .createSignedUrl(result.student.photo_path, 3600);
      result.student.photo_url = signed?.signedUrl ? toPublicUrl(cfg, signed.signedUrl) : null;
    }
    return result;
  });
}
