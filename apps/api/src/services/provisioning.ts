import { loginCodeToEmail, type NormalizedImportRow } from '@somar/shared';
import type { Config } from '../config.js';
import { ApiError, conflict } from '../lib/errors.js';
import type { Db } from '../lib/supabase.js';

export type StudentData = Pick<
  NormalizedImportRow,
  | 'full_name'
  | 'university_student_no'
  | 'phone_e164'
  | 'residence_text'
  | 'area_primary_id'
  | 'area_secondary_id'
  | 'area_other_text'
  | 'work_days'
  | 'shift_start'
> & { college_id: string };

export type ProvisionResult =
  | { ok: true; studentId: string; transportNumber: string; profileId: string }
  | { ok: false; code: 'STUDENT_EXISTS' | 'PROVISION_FAILED'; detail: string };

/**
 * Create auth user → profile → student for one student. Every failure rolls back the auth user
 * (no orphans) and gives the transport number back when it is still the latest allocation.
 */
export async function provisionStudent(
  db: Db,
  cfg: Config,
  universityId: string,
  data: StudentData,
  actorId: string | null,
): Promise<ProvisionResult> {
  const { data: tn, error: allocErr } = await db.rpc('allocate_transport_number', { p_university_id: universityId });
  if (allocErr || typeof tn !== 'string') {
    return { ok: false, code: 'PROVISION_FAILED', detail: allocErr?.message ?? 'allocation failed' };
  }
  const release = async () => {
    await db.rpc('release_transport_number', { p_university_id: universityId, p_transport_number: tn });
  };

  const { data: created, error: userErr } = await db.auth.admin.createUser({
    email: loginCodeToEmail(tn, cfg.SUPABASE_STUDENT_EMAIL_DOMAIN),
    password: tn,
    email_confirm: true,
    user_metadata: { login_code: tn },
  });
  if (userErr || !created.user) {
    await release();
    return { ok: false, code: 'PROVISION_FAILED', detail: userErr?.message ?? 'auth user not created' };
  }

  const { data: studentId, error: provErr } = await db.rpc('provision_student', {
    p_user_id: created.user.id,
    p_university_id: universityId,
    p_transport_number: tn,
    p_data: data,
    p_actor: actorId,
  });
  if (provErr || typeof studentId !== 'string') {
    await db.auth.admin.deleteUser(created.user.id);
    await release();
    const exists = provErr?.code === '23505' && /university_student_no/.test(provErr.message ?? '');
    return {
      ok: false,
      code: exists ? 'STUDENT_EXISTS' : 'PROVISION_FAILED',
      detail: provErr?.message ?? 'student not created',
    };
  }
  return { ok: true, studentId, transportNumber: tn, profileId: created.user.id };
}

export type StaffData = {
  login_code: string;
  full_name: string;
  phone?: string | null;
  university_id: string | null;
  password: string;
  role: 'admin' | 'university_supervisor' | 'supervisor';
  must_change_password?: boolean;
};

/** Create a standalone staff account (no student row). */
export async function provisionStaff(db: Db, cfg: Config, input: StaffData): Promise<{ profileId: string }> {
  const code = input.login_code.trim();
  const { data: taken } = await db.from('profiles').select('id').ilike('login_code', code).maybeSingle();
  if (taken) throw conflict('LOGIN_CODE_TAKEN');

  const { data: created, error } = await db.auth.admin.createUser({
    email: loginCodeToEmail(code, cfg.SUPABASE_STUDENT_EMAIL_DOMAIN),
    password: input.password,
    email_confirm: true,
    user_metadata: { login_code: code },
  });
  if (error || !created.user) {
    if (error?.message && /already/i.test(error.message)) throw conflict('LOGIN_CODE_TAKEN');
    throw new ApiError(500, 'PROVISION_FAILED');
  }
  const { error: pErr } = await db.from('profiles').insert({
    id: created.user.id,
    login_code: code,
    role: input.role,
    university_id: input.university_id,
    full_name: input.full_name,
    phone: input.phone ?? null,
    must_change_password: input.must_change_password ?? true,
  });
  if (pErr) {
    await db.auth.admin.deleteUser(created.user.id);
    throw new ApiError(500, 'PROVISION_FAILED');
  }
  return { profileId: created.user.id };
}
