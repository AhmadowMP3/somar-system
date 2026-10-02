import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { arShared, checkFullName, MEMBER_KINDS, memberInputSchema, normalizePhone, type MemberKind } from '@somar/shared';
import { assertPermission, assertUniversityScope, authOf, clientIp, type AppContext } from '../lib/auth.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { readMultipart } from '../lib/multipart.js';
import { runMemberImport } from '../services/member-import.js';
import { provisionStudent } from '../services/provisioning.js';

/** Doctors and university employees: accounts with a transport number and unlimited trips. */
export async function memberRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg, requireRole } = ctx;
  const staff = requireRole('admin', 'university_supervisor');

  app.post('/api/members', { preHandler: staff }, async (request, reply) => {
    const auth = authOf(request);
    assertPermission(auth, 'students');
    const input = memberInputSchema.parse(request.body);
    assertUniversityScope(auth, input.university_id);
    const name = checkFullName(input.full_name);
    const phone = input.phone ? normalizePhone(input.phone) : null;
    const reasons: string[] = [];
    if (!name.ok) reasons.push(name.reason === 'empty' ? arShared.import.NAME_REQUIRED : arShared.import.NAME_TOO_SHORT);
    if (phone && !phone.ok) reasons.push(arShared.import.PHONE_INVALID);
    if (!name.ok || (phone && !phone.ok)) throw badRequest('VALIDATION', reasons.join('، '), { reasons });

    if (input.area_primary_id) {
      const { data: area } = await db
        .from('areas')
        .select('id')
        .eq('id', input.area_primary_id)
        .eq('university_id', input.university_id)
        .maybeSingle();
      if (!area) throw badRequest('VALIDATION');
    }

    const res = await provisionStudent(
      db,
      cfg,
      input.university_id,
      {
        kind: input.kind,
        full_name: name.value,
        phone_e164: phone?.ok ? phone.value : null,
        job_title: input.job_title || null,
        residence_text: input.residence_text || null,
        area_primary_id: input.area_primary_id || null,
        work_days: [...new Set(input.work_days)].sort((a, b) => a - b),
        work_hours_text: input.work_hours_text || null,
        notes: input.notes || null,
      },
      auth.profile.id,
    );
    if (!res.ok) throw new ApiError(500, 'PROVISION_FAILED');
    reply.code(201);
    return { ok: true, student_id: res.studentId, transport_number: res.transportNumber };
  });

  app.post('/api/members/import', { preHandler: staff }, async (request) => {
    const auth = authOf(request);
    assertPermission(auth, 'students');
    const { fields, file } = await readMultipart(request);
    const universityId = fields.university_id ?? '';
    if (!z.string().uuid().safeParse(universityId).success) throw badRequest('UNIVERSITY_REQUIRED');
    assertUniversityScope(auth, universityId);
    const kind = z.enum(MEMBER_KINDS).safeParse(fields.kind);
    if (!kind.success) throw badRequest('VALIDATION');
    if (!file) throw badRequest('FILE_REQUIRED');
    if (!/\.xlsx$/i.test(file.filename)) throw badRequest('FILE_TYPE');
    const { data: uni } = await db.from('universities').select('id').eq('id', universityId).maybeSingle();
    if (!uni) throw new ApiError(404, 'NOT_FOUND');
    return runMemberImport(db, cfg, {
      universityId,
      kind: kind.data as MemberKind,
      buffer: file.buffer,
      dryRun: fields.dry_run !== 'false',
      actorId: auth.profile.id,
      ip: clientIp(request),
    });
  });
}
