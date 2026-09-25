import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { arShared, checkPassword, loginCodeToEmail } from '@somar/shared';
import { getSettings, writeAudit } from '../lib/audit.js';
import { authOf, clientIp, type AppContext } from '../lib/auth.js';
import { ApiError, badRequest, conflict } from '../lib/errors.js';
import { readMultipart } from '../lib/multipart.js';
import { createAnonClient } from '../lib/supabase.js';
import { processStudentPhoto } from '../services/images.js';

const passwordSchema = z.object({
  password: z.string().max(128),
  confirm: z.string().max(128),
  current_password: z.string().max(128).optional(),
});

export async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg, requireRole } = ctx;
  const anyUser = requireRole();

  app.post('/api/me/password', { preHandler: anyUser }, async (request) => {
    const auth = authOf(request);
    const body = passwordSchema.parse(request.body);
    const settings = await getSettings(db, auth.profile.university_id);
    const rules = checkPassword(body.password, body.confirm, settings.password_min_length);
    if (!rules.every((r) => r.ok)) {
      const code = rules.find((r) => !r.ok)?.key === 'match' ? 'PASSWORD_MISMATCH' : 'PASSWORD_WEAK';
      throw badRequest(code, undefined, { rules });
    }
    if (!auth.profile.must_change_password) {
      if (!body.current_password) throw badRequest('VALIDATION');
      const { error } = await createAnonClient(cfg).auth.signInWithPassword({
        email: loginCodeToEmail(auth.profile.login_code, cfg.SUPABASE_STUDENT_EMAIL_DOMAIN),
        password: body.current_password,
      });
      if (error) throw new ApiError(400, 'CURRENT_PASSWORD', arShared.api.VALIDATION);
    }
    const { error } = await db.auth.admin.updateUserById(auth.profile.id, { password: body.password });
    if (error) throw badRequest('PASSWORD_WEAK');
    await db
      .from('profiles')
      .update({ must_change_password: false, password_changed_at: new Date().toISOString() })
      .eq('id', auth.profile.id);
    await writeAudit(db, {
      actor: auth.profile.id,
      universityId: auth.profile.university_id,
      action: 'password.change',
      entity: 'profiles',
      entityId: auth.profile.id,
      ip: clientIp(request),
    });
    return { ok: true, sign_out: true };
  });

  app.post('/api/me/photo', { preHandler: anyUser }, async (request) => {
    const auth = authOf(request);
    const { data: student } = await db
      .from('students')
      .select('id, university_id, photo_path')
      .eq('profile_id', auth.profile.id)
      .maybeSingle();
    if (!student) throw new ApiError(403, 'NOT_STUDENT');
    if (student.photo_path) throw conflict('PHOTO_LOCKED');

    const { file } = await readMultipart(request);
    if (!file) throw badRequest('FILE_REQUIRED');
    const settings = await getSettings(db, student.university_id as string);
    const jpeg = await processStudentPhoto(file.buffer, file.mimetype, settings.max_photo_mb);

    const path = `${student.university_id}/${student.id}.jpg`;
    const { error: upErr } = await db.storage
      .from(cfg.SUPABASE_PHOTO_BUCKET)
      .upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
    if (upErr) throw new ApiError(500, 'INTERNAL');
    const { data: updated, error } = await db
      .from('students')
      .update({ photo_path: path, photo_uploaded_at: new Date().toISOString() })
      .eq('id', student.id)
      .is('photo_path', null)
      .select('id');
    if (error) throw new ApiError(500, 'INTERNAL');
    if (!updated?.length) throw conflict('PHOTO_LOCKED');
    return { ok: true, photo_path: path };
  });
}
