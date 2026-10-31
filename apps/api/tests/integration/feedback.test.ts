import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { accessToken, cfg, closeDb, createStaff, createStudent, createUniversity, destroyUniversity, service, signIn, type Fixture } from './helpers.js';

type Part = { name: string; value: string } | { name: string; filename: string; contentType: string; data: Buffer };

function multipart(parts: Part[]) {
  const boundary = `----somar${Date.now()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`),
      );
      chunks.push(p.data, Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}\r\n`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

let app: FastifyInstance;
let fx: Fixture;
let other: Fixture;
let student: { id: string; client: SupabaseClient; token: string };
let rider2: SupabaseClient;
let staffAll: SupabaseClient;
let staffNoFeedback: SupabaseClient;
let supervisorToken: string;
let png: Buffer;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const send = (token: string, fields: Record<string, string>, images = 0) => {
  const body = multipart([
    ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    ...Array.from({ length: images }, (_, i) => ({ name: `image${i + 1}`, filename: `p${i}.png`, contentType: 'image/png', data: png })),
  ]);
  return app.inject({ method: 'POST', url: '/api/feedback', headers: { ...body.headers, ...auth(token) }, payload: body.payload });
};

beforeAll(async () => {
  app = (await buildApp(cfg, { logger: false })).app;
  fx = await createUniversity();
  other = await createUniversity();
  png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#c1121f' } }).png().toBuffer();
  const st = await createStudent(fx);
  const client = await signIn(st.transportNumber, st.transportNumber);
  student = { id: st.id, client, token: await accessToken(client) };
  const st2 = await createStudent(fx);
  rider2 = await signIn(st2.transportNumber, st2.transportNumber);
  staffAll = (await createStaff(fx, 'university_supervisor')).client;
  const limited = await createStaff(fx, 'university_supervisor');
  await service.from('profiles').update({ permissions: ['dashboard'] }).eq('id', limited.profileId);
  staffNoFeedback = limited.client;
  supervisorToken = await accessToken((await createStaff(fx, 'supervisor')).client);
});

afterAll(async () => {
  await app.close();
  await destroyUniversity(fx);
  await destroyUniversity(other);
  await closeDb();
});

describe('notes and complaints', () => {
  it('a rider sends a complaint with two photos; they are shrunk and stored privately; the staff are notified', async () => {
    const res = await send(student.token, { kind: 'complaint', body: 'الباص تأخر عن دوار الكرة' }, 2);
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const { data: row } = await service.from('feedback').select('*').eq('id', id).single();
    expect(row).toMatchObject({ author_type: 'student', kind: 'complaint', status: 'new', author_student_id: student.id });
    expect(row?.image_paths).toEqual([`${fx.universityId}/${id}/1.jpg`, `${fx.universityId}/${id}/2.jpg`]);
    const { data: file } = await service.storage.from('feedback-images').download(row?.image_paths[0] as string);
    expect(await sharp(Buffer.from(await (file as Blob).arrayBuffer())).metadata()).toMatchObject({ format: 'jpeg', width: 1600, height: 800 });
    const { data: notes } = await service.from('notifications').select('type, student_id, title').eq('university_id', fx.universityId).eq('type', 'FEEDBACK');
    expect(notes).toEqual([{ type: 'FEEDBACK', student_id: null, title: expect.stringContaining('شكوى جديدة') }]);
  });

  it('rejects a third photo, an empty text and a non-image file', async () => {
    expect((await send(student.token, { kind: 'note', body: 'ثلاث صور' }, 3)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await send(student.token, { kind: 'note', body: ' ' })).statusCode).toBe(400);
    const body = multipart([
      { name: 'kind', value: 'note' },
      { name: 'body', value: 'ملف نصي' },
      { name: 'image1', filename: 'x.txt', contentType: 'text/plain', data: Buffer.from('hi') },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/feedback', headers: { ...body.headers, ...auth(student.token) }, payload: body.payload });
    expect(res.statusCode).toBe(415);
  });

  it('supervisors can send too, as «supervisor»', async () => {
    const res = await send(supervisorToken, { kind: 'note', body: 'ملاحظة من المشرف' });
    expect(res.statusCode).toBe(201);
    const { data } = await service.from('feedback').select('author_type, author_student_id').eq('id', (res.json() as { id: string }).id).single();
    expect(data).toEqual({ author_type: 'supervisor', author_student_id: null });
  });

  it('senders see only their own; staff with the permission see all of their university and its photos', async () => {
    expect(((await student.client.from('feedback').select('id')).data ?? []).length).toBe(1);
    expect((await rider2.from('feedback').select('id')).data).toEqual([]);
    expect(((await staffAll.from('feedback').select('id')).data ?? []).length).toBe(2);
    expect((await staffNoFeedback.from('feedback').select('id')).data).toEqual([]);

    const { data: row } = await service.from('feedback').select('image_paths').eq('author_student_id', student.id).single();
    const path = row?.image_paths[0] as string;
    expect((await student.client.storage.from('feedback-images').createSignedUrl(path, 60)).error).toBeNull();
    expect((await staffAll.storage.from('feedback-images').createSignedUrl(path, 60)).error).toBeNull();
    expect((await rider2.storage.from('feedback-images').createSignedUrl(path, 60)).error).not.toBeNull();
    expect((await staffNoFeedback.storage.from('feedback-images').createSignedUrl(path, 60)).error).not.toBeNull();
  });

  it('staff set the status and reply; the rider gets the reply as a notification; others cannot answer', async () => {
    const { data: row } = await service.from('feedback').select('id').eq('author_student_id', student.id).single();
    const id = row?.id as string;
    expect((await staffNoFeedback.rpc('answer_feedback', { p_id: id, p_status: 'resolved', p_reply: 'x' })).error?.message).toBe('FORBIDDEN');
    expect((await student.client.rpc('answer_feedback', { p_id: id, p_status: 'resolved', p_reply: 'x' })).error?.message).toBe('FORBIDDEN');

    expect((await staffAll.rpc('answer_feedback', { p_id: id, p_status: 'in_progress', p_reply: null })).error).toBeNull();
    expect((await staffAll.rpc('answer_feedback', { p_id: id, p_status: 'resolved', p_reply: 'تمت متابعة السائق' })).error).toBeNull();
    const { data: own } = await student.client.from('feedback').select('status, reply').eq('id', id).single();
    expect(own).toEqual({ status: 'resolved', reply: 'تمت متابعة السائق' });
    const { data: notes } = await student.client.from('notifications').select('type, title, body').eq('type', 'FEEDBACK_REPLY');
    expect(notes).toEqual([{ type: 'FEEDBACK_REPLY', title: 'رد على شكواك', body: 'تمت متابعة السائق' }]);
    // saving the same reply again sends nothing new
    await staffAll.rpc('answer_feedback', { p_id: id, p_status: 'resolved', p_reply: 'تمت متابعة السائق' });
    expect(((await student.client.from('notifications').select('id').eq('type', 'FEEDBACK_REPLY')).data ?? []).length).toBe(1);
  });

  it('sending is direct-write proof and limited per day', async () => {
    const direct = await student.client
      .from('feedback')
      .insert({ university_id: fx.universityId, author_name: 'x', author_type: 'student', kind: 'note', body: 'مباشر' });
    expect(direct.error).not.toBeNull();
    let last = 201;
    for (let i = 0; i < 10 && last === 201; i++) last = (await send(student.token, { kind: 'note', body: `ملاحظة ${i}` })).statusCode;
    expect(last).toBe(429);
  });
});
