import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  arShared,
  checkFullName,
  normalizeNationalId,
  normalizePhone,
  normalizeStudentNo,
  studentInputSchema,
  type HeaderMapping,
} from '@somar/shared';
import { writeAudit } from '../lib/audit.js';
import { assertPermission, assertUniversityScope, authOf, clientIp, type AppContext } from '../lib/auth.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors.js';
import { readMultipart, readRowSelection } from '../lib/multipart.js';
import { runImport } from '../services/import.js';
import { initialPassword, provisionStudent } from '../services/provisioning.js';

type StudentRow = {
  id: string;
  profile_id: string | null;
  university_id: string;
  transport_number: string;
  national_id: string | null;
  qr_token: string;
  photo_path: string | null;
};

export async function studentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg, requireRole } = ctx;
  const staff = requireRole('admin', 'university_supervisor');
  const adminOnly = requireRole('admin');

  async function loadStudent(id: string): Promise<StudentRow> {
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) throw notFound();
    const { data } = await db
      .from('students')
      .select('id, profile_id, university_id, transport_number, national_id, qr_token, photo_path')
      .eq('id', id)
      .maybeSingle<StudentRow>();
    if (!data) throw notFound();
    return data;
  }

  app.post('/api/students/import', { preHandler: staff }, async (request) => {
    const auth = authOf(request);
    assertPermission(auth, 'import');
    const { fields, file } = await readMultipart(request);
    const universityId = fields.university_id ?? '';
    if (!z.string().uuid().safeParse(universityId).success) throw badRequest('UNIVERSITY_REQUIRED');
    assertUniversityScope(auth, universityId);
    if (!file) throw badRequest('FILE_REQUIRED');
    if (!/\.xlsx$/i.test(file.filename)) throw badRequest('FILE_TYPE');
    let mapping: HeaderMapping | undefined;
    if (fields.mapping) {
      try {
        mapping = z.record(z.string()).parse(JSON.parse(fields.mapping)) as HeaderMapping;
      } catch {
        throw badRequest('VALIDATION');
      }
    }
    const dryRun = fields.dry_run !== 'false';
    return runImport(db, cfg, {
      universityId,
      buffer: file.buffer,
      mapping,
      onlyRows: readRowSelection(fields),
      dryRun,
      actorId: auth.profile.id,
      ip: clientIp(request),
    });
  });

  app.post('/api/students', { preHandler: staff }, async (request, reply) => {
    const auth = authOf(request);
    assertPermission(auth, 'students');
    const input = studentInputSchema.parse(request.body);
    assertUniversityScope(auth, input.university_id);
    const name = checkFullName(input.full_name);
    const no = normalizeStudentNo(input.university_student_no);
    const phone = normalizePhone(input.phone);
    const nationalId = input.national_id ? normalizeNationalId(input.national_id) : null;
    const reasons: string[] = [];
    if (!name.ok) reasons.push(name.reason === 'empty' ? arShared.import.NAME_REQUIRED : arShared.import.NAME_TOO_SHORT);
    if (!no.ok) reasons.push(arShared.import.STUDENT_NO_INVALID);
    if (!phone.ok) reasons.push(arShared.import.PHONE_INVALID);
    if (nationalId && !nationalId.ok) reasons.push(arShared.import.NATIONAL_ID_INVALID);
    if (!name.ok || !no.ok || !phone.ok || (nationalId && !nationalId.ok)) {
      throw badRequest('VALIDATION', reasons.join('، '), { reasons });
    }

    const { data: college } = await db
      .from('colleges')
      .select('id')
      .eq('id', input.college_id)
      .eq('university_id', input.university_id)
      .maybeSingle();
    if (!college) throw badRequest('VALIDATION', arShared.import.COLLEGE_REQUIRED);
    const { data: existing } = await db
      .from('students')
      .select('id')
      .eq('university_id', input.university_id)
      .eq('university_student_no', no.value)
      .maybeSingle();
    if (existing) throw conflict('STUDENT_EXISTS');

    const res = await provisionStudent(
      db,
      cfg,
      input.university_id,
      {
        full_name: name.value,
        university_student_no: no.value,
        national_id: nationalId?.ok ? nationalId.value : null,
        phone_e164: phone.value,
        college_id: input.college_id,
        residence_text: input.residence_text || null,
        area_primary_id: input.area_primary_id || null,
        area_secondary_id: input.area_secondary_id || null,
        area_other_text: input.area_other_text || null,
        work_days: [...new Set(input.work_days)].sort((a, b) => a - b),
        shift_start: input.shift_start,
      },
      auth.profile.id,
    );
    if (!res.ok) throw res.code === 'STUDENT_EXISTS' ? conflict('STUDENT_EXISTS') : new ApiError(500, 'PROVISION_FAILED');
    reply.code(201);
    return { ok: true, student_id: res.studentId, transport_number: res.transportNumber };
  });

  app.post<{ Params: { id: string } }>(
    '/api/students/:id/reset-password',
    { preHandler: adminOnly },
    async (request) => {
      const auth = authOf(request);
      const s = await loadStudent(request.params.id);
      if (!s.profile_id) throw notFound();
      const { error } = await db.auth.admin.updateUserById(s.profile_id, { password: initialPassword(s, s.transport_number) });
      if (error) throw new ApiError(500, 'INTERNAL');
      await db.from('profiles').update({ must_change_password: true }).eq('id', s.profile_id);
      await writeAudit(db, {
        actor: auth.profile.id,
        universityId: s.university_id,
        action: 'password.reset',
        entity: 'profiles',
        entityId: s.profile_id,
        ip: clientIp(request),
      });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>('/api/students/:id/reset-photo', { preHandler: adminOnly }, async (request) => {
    const auth = authOf(request);
    const s = await loadStudent(request.params.id);
    if (s.photo_path) await db.storage.from(cfg.SUPABASE_PHOTO_BUCKET).remove([s.photo_path]);
    const { error } = await db.from('students').update({ photo_path: null, photo_uploaded_at: null }).eq('id', s.id);
    if (error) throw new ApiError(500, 'INTERNAL');
    await writeAudit(db, {
      actor: auth.profile.id,
      universityId: s.university_id,
      action: 'photo.reset',
      entity: 'students',
      entityId: s.id,
      before: { photo_path: s.photo_path },
      ip: clientIp(request),
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/students/:id/regenerate-qr', { preHandler: adminOnly }, async (request) => {
    const auth = authOf(request);
    const s = await loadStudent(request.params.id);
    const token = randomUUID();
    const { error } = await db.from('students').update({ qr_token: token }).eq('id', s.id);
    if (error) throw new ApiError(500, 'INTERNAL');
    await writeAudit(db, {
      actor: auth.profile.id,
      universityId: s.university_id,
      action: 'qr.regenerate',
      entity: 'students',
      entityId: s.id,
      before: { qr_token: s.qr_token },
      after: { qr_token: token },
      ip: clientIp(request),
    });
    return { ok: true, qr_token: token };
  });
}
