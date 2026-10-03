import {
  arShared,
  dedupeMemberRows,
  matchMemberHeaders,
  memberNameKey,
  MEMBER_IMPORT_FIELDS,
  normalizeMemberRow,
  summarizeMemberImport,
  type ImportSummary,
  type MemberFieldKey,
  type MemberKind,
  type MemberMapping,
  type MemberRowResult,
} from '@somar/shared';
import type { Config } from '../config.js';
import { writeAudit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/supabase.js';
import { parseWorkbook } from './import.js';
import { provisionStudent, type MemberData } from './provisioning.js';

export type MemberImportOptions = {
  universityId: string;
  kind: MemberKind;
  buffer: Buffer;
  dryRun: boolean;
  actorId: string | null;
  ip?: string | null;
};

export type MemberImportResult = {
  summary: ImportSummary;
  rows: Omit<MemberRowResult, 'data' | 'name_key'>[];
  headers: string[];
  mapping: MemberMapping;
  dry_run: boolean;
};

/**
 * Import doctors or employees from a sheet. A person already on file (same name, same kind) is updated,
 * everyone else gets an account and a transport number. Nothing is written on a dry run.
 */
export async function runMemberImport(db: Db, cfg: Config, opts: MemberImportOptions): Promise<MemberImportResult> {
  const sheet = parseWorkbook(opts.buffer);
  const { mapping, missing } = matchMemberHeaders(sheet.headers);
  if (missing.length) {
    const names = missing.map((k) => `«${MEMBER_IMPORT_FIELDS.find((f) => f.key === k)?.headers[0] ?? k}»`);
    throw new ApiError(422, 'MISSING_COLUMN', arShared.api.MISSING_COLUMN + names.join('، '), { headers: sheet.headers, mapping, missing });
  }
  const columns = Object.entries(mapping).map(([key, header]) => [key, sheet.headers.indexOf(header as string)] as const);

  const { data: existingRows, error } = await db
    .from('students')
    .select('id, profile_id, full_name')
    .eq('university_id', opts.universityId)
    .eq('kind', opts.kind);
  if (error) throw new ApiError(500, 'INTERNAL');
  const existing = new Map((existingRows ?? []).map((r) => [memberNameKey(r.full_name), r as { id: string; profile_id: string | null }]));

  let rows = sheet.rows.map((cells, i) => {
    const raw: Partial<Record<MemberFieldKey, unknown>> = {};
    for (const [key, idx] of columns) if (idx >= 0) raw[key as MemberFieldKey] = cells[idx];
    return normalizeMemberRow(i + 2, raw);
  });
  // Lines without a name are stray continuation cells (e.g. an address split over two rows), not people.
  rows = rows.filter((r) => r.full_name);
  rows = dedupeMemberRows(rows).map((r) => (r.status === 'created' && existing.has(r.name_key) ? { ...r, status: 'updated' as const } : r));

  if (!opts.dryRun) {
    const toData = (r: MemberRowResult): MemberData => ({
      kind: opts.kind,
      full_name: r.data!.full_name,
      phone_e164: null,
      job_title: r.data!.job_title,
      residence_text: null,
      area_primary_id: null,
      work_days: r.data!.work_days,
      work_hours_text: null,
      notes: null,
    });
    const failed = (r: MemberRowResult): MemberRowResult => ({ ...r, status: 'rejected', reasons: [arShared.import.PROVISION_FAILED] });
    const out: MemberRowResult[] = [];
    for (const r of rows) {
      if (!r.data || (r.status !== 'created' && r.status !== 'updated')) {
        out.push(r);
        continue;
      }
      const d = toData(r);
      if (r.status === 'updated') {
        const target = existing.get(r.name_key)!;
        // Only name, job and days come from the sheet; an empty job or days cell keeps what is on file.
        const patch = {
          full_name: d.full_name,
          ...(d.job_title ? { job_title: d.job_title } : {}),
          ...(d.work_days.length ? { work_days: d.work_days } : {}),
        };
        const { error: upErr } = await db.from('students').update(patch).eq('id', target.id);
        if (!upErr && target.profile_id) {
          await db.from('profiles').update({ full_name: d.full_name }).eq('id', target.profile_id);
        }
        out.push(upErr ? failed(r) : r);
        continue;
      }
      const res = await provisionStudent(db, cfg, opts.universityId, d, null);
      out.push(res.ok ? r : failed(r));
    }
    rows = out;
  }

  const summary = summarizeMemberImport(rows);
  if (!opts.dryRun) {
    await writeAudit(db, {
      actor: opts.actorId,
      universityId: opts.universityId,
      action: 'import.run',
      entity: 'students',
      after: { kind: opts.kind, summary },
      ip: opts.ip ?? null,
    });
  }
  return {
    summary,
    rows: rows.map(({ data: _data, name_key: _key, ...rest }) => rest),
    headers: sheet.headers,
    mapping,
    dry_run: opts.dryRun,
  };
}
