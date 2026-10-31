import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OUTBOUND_SLOTS, RETURN_SLOTS, servesTrip } from '@somar/shared';
import { getSettings } from '../lib/audit.js';
import { authOf, type AppContext } from '../lib/auth.js';
import { ApiError, badRequest } from '../lib/errors.js';
import { readMultipartFiles } from '../lib/multipart.js';
import { processFeedbackImage } from '../services/images.js';

export const FEEDBACK_BUCKET = 'feedback-images';
const MAX_IMAGES = 2;
/** Submissions one person may send in 24 hours (keeps a stuck button or a spammer from flooding the staff). */
const DAILY_LIMIT = 10;

const feedbackSchema = z.object({
  kind: z.enum(['note', 'complaint']),
  body: z.string().trim().min(3).max(2000),
  // a complaint names the trip: direction, the system's bus time and the line
  trip_direction: z.enum(['outbound', 'return']).optional(),
  trip_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  route_id: z.string().uuid().optional(),
});

type RouteRow = { id: string; name: string; direction: string; departure_time: string | null; route_stops: { departure_time: string | null }[] };

export async function feedbackRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, requireRole } = ctx;
  // students (doctors and employees have student accounts too) and supervisors
  const senders = requireRole('student', 'supervisor', 'university_supervisor');

  /** A note or complaint with up to two photos; the staff get a notification. */
  app.post('/api/feedback', { preHandler: senders }, async (request, reply) => {
    const auth = authOf(request);
    const { fields, files } = await readMultipartFiles(request, MAX_IMAGES);
    const input = feedbackSchema.safeParse(fields);
    if (!input.success) throw badRequest('VALIDATION');
    if (files.length > MAX_IMAGES) throw badRequest('FEEDBACK_IMAGES');

    const { data: student } = await db
      .from('students')
      .select('id, university_id, full_name, transport_number, kind, is_active')
      .eq('profile_id', auth.profile.id)
      .maybeSingle();
    const universityId = (student?.university_id as string | undefined) ?? auth.profile.university_id;
    if (!universityId) throw new ApiError(403, 'FORBIDDEN');
    const authorType = student && student.kind !== 'student' ? (student.kind as string) : auth.profile.role === 'student' ? 'student' : 'supervisor';

    // the trip of a complaint: a system time of that direction, and one of the lines running that trip
    let trip: { trip_direction: string; trip_time: string; route_id: string | null; route_name: string | null } | null = null;
    if (input.data.kind === 'complaint') {
      const { trip_direction: direction, trip_time: time, route_id: routeId } = input.data;
      const slots: readonly string[] = direction === 'return' ? RETURN_SLOTS : OUTBOUND_SLOTS;
      if (!direction || !time || !slots.includes(time)) throw badRequest('FEEDBACK_TRIP');
      const { data: routes } = await db
        .from('routes')
        .select('id, name, direction, departure_time, route_stops(departure_time)')
        .eq('university_id', universityId)
        .eq('is_active', true);
      const lines = ((routes ?? []) as RouteRow[]).filter((r) =>
        servesTrip(
          { ...r, first_stop_time: r.route_stops.map((x) => x.departure_time).filter(Boolean).sort()[0] ?? null },
          direction,
          time,
        ),
      );
      const line = lines.find((r) => r.id === routeId);
      // a line must be named whenever one runs that trip
      if (routeId ? !line : lines.length > 0) throw badRequest('FEEDBACK_TRIP');
      trip = { trip_direction: direction, trip_time: time, route_id: line?.id ?? null, route_name: line?.name ?? null };
    }

    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { count } = await db
      .from('feedback')
      .select('id', { count: 'exact', head: true })
      .eq('author_profile_id', auth.profile.id)
      .gte('created_at', since);
    if ((count ?? 0) >= DAILY_LIMIT) throw new ApiError(429, 'FEEDBACK_LIMIT');

    // photos are checked and shrunk before anything is saved
    const settings = await getSettings(db, universityId);
    const images = await Promise.all(files.map((f) => processFeedbackImage(f.buffer, f.mimetype, settings.max_photo_mb)));

    const id = randomUUID();
    const paths = images.map((_, i) => `${universityId}/${id}/${i + 1}.jpg`);
    for (const [i, jpeg] of images.entries()) {
      const { error } = await db.storage.from(FEEDBACK_BUCKET).upload(paths[i] as string, jpeg, { contentType: 'image/jpeg', upsert: true });
      if (error) {
        await db.storage.from(FEEDBACK_BUCKET).remove(paths.slice(0, i));
        throw new ApiError(500, 'INTERNAL');
      }
    }

    const authorName = (student?.full_name as string | undefined) ?? auth.profile.full_name;
    const { error } = await db.from('feedback').insert({
      id,
      university_id: universityId,
      author_profile_id: auth.profile.id,
      author_student_id: student?.id ?? null,
      author_name: authorName,
      author_code: (student?.transport_number as string | undefined) ?? auth.profile.login_code,
      author_type: authorType,
      kind: input.data.kind,
      body: input.data.body,
      image_paths: paths,
      ...trip,
    });
    if (error) {
      if (paths.length) await db.storage.from(FEEDBACK_BUCKET).remove(paths);
      throw new ApiError(500, 'INTERNAL');
    }

    // to the staff of the university (no student_id: the push goes to the admin and university supervisors)
    await db.from('notifications').insert({
      university_id: universityId,
      audience: { kind: 'staff' },
      type: 'FEEDBACK',
      title: input.data.kind === 'complaint' ? `شكوى جديدة من ${authorName}` : `ملاحظة جديدة من ${authorName}`,
      body: input.data.body.slice(0, 200),
      data: { feedback_id: id },
      created_by: auth.profile.id,
    });

    reply.code(201);
    return { ok: true, id };
  });
}
