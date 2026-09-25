import type { Db } from './supabase.js';

export type AuditEntry = {
  actor: string | null;
  universityId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
};

export async function writeAudit(db: Db, e: AuditEntry): Promise<void> {
  const { error } = await db.from('audit_log').insert({
    actor_profile_id: e.actor,
    university_id: e.universityId,
    action: e.action,
    entity: e.entity,
    entity_id: e.entityId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    ip: e.ip ?? null,
  });
  if (error) throw new Error(`audit insert failed: ${error.message}`);
}

export type EffectiveSettings = {
  scan_cooldown_minutes: number;
  allow_offday_override: boolean;
  require_supervisor_geo: boolean;
  low_balance_threshold: number;
  expiry_warning_days: number;
  daily_job_hour: number;
  max_photo_mb: number;
  password_min_length: number;
};

export async function getSettings(db: Db, universityId: string | null): Promise<EffectiveSettings> {
  const { data, error } = await db.rpc('get_settings', { p_university_id: universityId });
  if (error || !data) throw new Error(`settings lookup failed: ${error?.message ?? 'empty'}`);
  return data as EffectiveSettings;
}
