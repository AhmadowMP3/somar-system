import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { roleForPermissions, staffInputSchema } from '@somar/shared';
import { writeAudit } from '../lib/audit.js';
import { assertUniversityScope, authOf, clientIp, type AppContext } from '../lib/auth.js';
import { ApiError, notFound } from '../lib/errors.js';
import { readMultipart } from '../lib/multipart.js';
import { processLogo } from '../services/images.js';
import { provisionStaff } from '../services/provisioning.js';

export async function staffRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg, requireRole } = ctx;
  const adminOnly = requireRole('admin');
  const staff = requireRole('admin', 'university_supervisor');

  app.post('/api/supervisors', { preHandler: adminOnly }, async (request, reply) => {
    const auth = authOf(request);
    const input = staffInputSchema.parse(request.body);
    const permissions = input.permissions ? [...new Set(input.permissions)].sort() : null;
    const role = permissions ? roleForPermissions(permissions) : input.role;
    const { profileId } = await provisionStaff(db, cfg, { ...input, role, must_change_password: true });
    if (permissions) {
      const { error } = await db.from('profiles').update({ permissions }).eq('id', profileId);
      if (error) throw new ApiError(500, 'INTERNAL');
    }
    await writeAudit(db, {
      actor: auth.profile.id,
      universityId: input.university_id,
      action: 'supervisor.create',
      entity: 'profiles',
      entityId: profileId,
      after: { login_code: input.login_code, role, permissions, full_name: input.full_name },
      ip: clientIp(request),
    });
    reply.code(201);
    return { ok: true, profile_id: profileId };
  });

  app.post<{ Params: { id: string } }>(
    '/api/supervisors/:id/reset-password',
    { preHandler: adminOnly },
    async (request) => {
      const auth = authOf(request);
      const { password } = z.object({ password: z.string().min(6).max(128) }).parse(request.body);
      const { data: profile } = await db
        .from('profiles')
        .select('id, university_id, role')
        .eq('id', request.params.id)
        .maybeSingle();
      if (!profile || profile.role === 'student') throw notFound();
      const { error } = await db.auth.admin.updateUserById(profile.id as string, { password });
      if (error) throw new ApiError(400, 'PASSWORD_WEAK');
      await db.from('profiles').update({ must_change_password: true }).eq('id', profile.id);
      await writeAudit(db, {
        actor: auth.profile.id,
        universityId: profile.university_id as string | null,
        action: 'password.reset',
        entity: 'profiles',
        entityId: profile.id as string,
        ip: clientIp(request),
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/universities/:id/logo', { preHandler: staff }, async (request) => {
    const auth = authOf(request);
    assertUniversityScope(auth, request.params.id);
    const { file } = await readMultipart(request);
    if (!file) throw new ApiError(400, 'FILE_REQUIRED');
    const png = await processLogo(file.buffer);
    const path = `${request.params.id}/logo.png`;
    const { error } = await db.storage
      .from(cfg.SUPABASE_LOGO_BUCKET)
      .upload(path, png, { contentType: 'image/png', upsert: true });
    if (error) throw new ApiError(500, 'INTERNAL');
    await db.from('universities').update({ logo_path: path }).eq('id', request.params.id);
    return { ok: true, logo_path: path };
  });

  app.post<{ Querystring: { force?: string } }>(
    '/api/jobs/daily',
    { preHandler: adminOnly },
    async (request) => {
      const { data, error } = await db.rpc('run_daily_jobs', { p_force: request.query.force !== 'false' });
      if (error) throw new ApiError(500, 'INTERNAL');
      return { ok: true, result: data };
    },
  );
}
