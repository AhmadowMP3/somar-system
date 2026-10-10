import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { arShared, broadcastSchema } from '@somar/shared';
import { writeAudit } from '../lib/audit.js';
import { assertPermission, assertUniversityScope, authOf, clientIp, type AppContext } from '../lib/auth.js';
import { ApiError, badRequest } from '../lib/errors.js';
import type { PushService } from '../services/push.js';

const subscribeSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(200) }),
});

export async function notificationRoutes(app: FastifyInstance, ctx: AppContext & { push: PushService }) {
  const { db, requireRole, push } = ctx;
  const anyUser = requireRole();
  const staff = requireRole('admin', 'university_supervisor');

  app.post('/api/push/subscribe', { preHandler: anyUser }, async (request) => {
    const auth = authOf(request);
    const body = subscribeSchema.parse(request.body);
    const { error } = await db.from('push_subscriptions').upsert(
      {
        profile_id: auth.profile.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        user_agent: request.headers['user-agent']?.slice(0, 500) ?? null,
        failure_count: 0,
      },
      { onConflict: 'endpoint' },
    );
    if (error) throw new ApiError(500, 'INTERNAL');
    return { ok: true, enabled: push.enabled };
  });

  app.post('/api/push/test', { preHandler: anyUser }, async (request) => {
    const auth = authOf(request);
    if (!push.enabled) throw new ApiError(503, 'PUSH_DISABLED');
    const sent = await push.sendToProfiles([auth.profile.id], {
      title: arShared.notifications.testTitle,
      body: arShared.notifications.testBody,
      url: '/',
      tag: 'TEST',
    });
    return { ok: true, sent };
  });

  app.post('/api/notifications/broadcast', { preHandler: staff }, async (request, reply) => {
    const auth = authOf(request);
    assertPermission(auth, 'notifications');
    const input = broadcastSchema.parse(request.body);
    assertUniversityScope(auth, input.university_id);

    let studentIds: string[] = [];
    const a = input.audience;
    if (a.kind === 'package') {
      const { data, error } = await db
        .from('subscriptions')
        .select('student_id, students!inner(university_id, is_active)')
        .eq('package_id', a.package_id)
        .eq('status', 'active')
        .eq('students.university_id', input.university_id)
        .eq('students.is_active', true);
      if (error) throw new ApiError(500, 'INTERNAL');
      studentIds = (data ?? []).map((r) => r.student_id as string);
    } else if (a.kind === 'students') {
      // only this university's active students among the picked ids
      const picked = [...new Set(a.student_ids)];
      for (let i = 0; i < picked.length; i += 200) {
        const { data, error } = await db
          .from('students')
          .select('id')
          .eq('university_id', input.university_id)
          .eq('is_active', true)
          .in('id', picked.slice(i, i + 200));
        if (error) throw new ApiError(500, 'INTERNAL');
        studentIds.push(...(data ?? []).map((r) => r.id as string));
      }
    } else {
      let q = db.from('students').select('id').eq('university_id', input.university_id).eq('is_active', true);
      if (a.kind === 'college') q = q.eq('college_id', a.college_id);
      if (a.kind === 'student') q = q.eq('id', a.student_id);
      const { data, error } = await q;
      if (error) throw new ApiError(500, 'INTERNAL');
      studentIds = (data ?? []).map((r) => r.id as string);
    }
    studentIds = [...new Set(studentIds)];
    if (!studentIds.length) throw badRequest('NO_RECIPIENTS');
    // a picked list is stored as its size, not thousands of ids on every row
    const audience = a.kind === 'students' ? { kind: 'students', count: studentIds.length } : a;

    const { data: broadcast, error: bErr } = await db
      .from('broadcasts')
      .insert({
        university_id: input.university_id,
        title: input.title,
        body: input.body,
        audience,
        recipients: studentIds.length,
        created_by: auth.profile.id,
      })
      .select('id')
      .single();
    if (bErr || !broadcast) throw new ApiError(500, 'INTERNAL');

    for (let i = 0; i < studentIds.length; i += 500) {
      const { error } = await db.from('notifications').insert(
        studentIds.slice(i, i + 500).map((sid) => ({
          university_id: input.university_id,
          student_id: sid,
          audience,
          type: 'BROADCAST',
          title: input.title,
          body: input.body,
          data: { broadcast_id: broadcast.id },
          created_by: auth.profile.id,
        })),
      );
      if (error) throw new ApiError(500, 'INTERNAL');
    }
    await writeAudit(db, {
      actor: auth.profile.id,
      universityId: input.university_id,
      action: 'broadcast.send',
      entity: 'broadcasts',
      entityId: broadcast.id as string,
      after: { title: input.title, audience, recipients: studentIds.length },
      ip: clientIp(request),
    });
    void push.dispatchPending().catch((err: unknown) => request.log.error(err));
    reply.code(201);
    return { ok: true, broadcast_id: broadcast.id, recipients: studentIds.length };
  });
}
