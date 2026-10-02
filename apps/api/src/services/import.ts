import * as XLSX from 'xlsx';
import {
  arShared,
  dedupeImportRows,
  fieldHeader,
  foldArabic,
  IMPORT_FIELDS,
  matchHeaders,
  normalizeImportRow,
  normalizeText,
  summarizeImport,
  type HeaderMapping,
  type ImportFieldKey,
  type ImportRowResult,
  type ImportSummary,
  type RefItem,
} from '@somar/shared';
import type { Config } from '../config.js';
import { writeAudit } from '../lib/audit.js';
import { ApiError } from '../lib/errors.js';
import type { Db } from '../lib/supabase.js';
import { provisionStudent, type StudentData } from './provisioning.js';

export type ParsedSheet = { headers: string[]; rows: unknown[][] };

export function parseWorkbook(buffer: Buffer): ParsedSheet {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  } catch {
    throw new ApiError(400, 'FILE_TYPE');
  }
  const sheetName = wb.SheetNames[0];
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!sheet) throw new ApiError(400, 'FILE_EMPTY');
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  const [headerRow, ...rows] = matrix;
  if (!headerRow || !rows.length) throw new ApiError(400, 'FILE_EMPTY');
  const headers = headerRow.map((h) => (h === null || h === undefined ? '' : String(h)));
  return { headers, rows };
}

export type ImportOptions = {
  universityId: string;
  buffer: Buffer;
  mapping?: HeaderMapping;
  dryRun: boolean;
  actorId: string | null;
  ip?: string | null;
};

export type PublicImportRow = Omit<ImportRowResult, 'data'>;

export type ImportResult = {
  summary: ImportSummary;
  rows: PublicImportRow[];
  headers: string[];
  mapping: HeaderMapping;
  needs_area_mapping: number;
  dry_run: boolean;
};

function resolveMapping(headers: string[], override?: HeaderMapping): HeaderMapping {
  const auto = matchHeaders(headers).mapping;
  const mapping: HeaderMapping = { ...auto };
  if (override) {
    for (const [key, header] of Object.entries(override) as [ImportFieldKey, string | undefined][]) {
      if (!IMPORT_FIELDS.some((f) => f.key === key)) continue;
      if (header === undefined || header === '') delete mapping[key];
      else if (headers.includes(header)) mapping[key] = header;
    }
  }
  const missing = IMPORT_FIELDS.filter((f) => f.required && !mapping[f.key]);
  if (missing.length) {
    throw new ApiError(
      422,
      'MISSING_COLUMN',
      arShared.api.MISSING_COLUMN + missing.map((f) => `«${fieldHeader(f.key)}»`).join('، '),
      { headers, mapping, missing: missing.map((f) => f.key) },
    );
  }
  return mapping;
}

async function loadRefs(db: Db, universityId: string) {
  const [colleges, areas, students] = await Promise.all([
    db.from('colleges').select('id, name').eq('university_id', universityId),
    db.from('areas').select('id, name').eq('university_id', universityId),
    db.from('students').select('id, university_student_no').eq('university_id', universityId),
  ]);
  if (colleges.error || areas.error || students.error) {
    throw new ApiError(500, 'INTERNAL', undefined, (colleges.error ?? areas.error ?? students.error)?.message);
  }
  return {
    colleges: (colleges.data ?? []) as RefItem[],
    areas: (areas.data ?? []) as RefItem[],
    existing: new Set((students.data ?? []).map((s) => s.university_student_no as string)),
  };
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runImport(db: Db, cfg: Config, opts: ImportOptions): Promise<ImportResult> {
  const { data: uni } = await db.from('universities').select('id').eq('id', opts.universityId).maybeSingle();
  if (!uni) throw new ApiError(404, 'NOT_FOUND');

  const sheet = parseWorkbook(opts.buffer);
  const mapping = resolveMapping(sheet.headers, opts.mapping);
  const refs = await loadRefs(db, opts.universityId);

  const columnIndex = Object.fromEntries(
    Object.entries(mapping).map(([key, header]) => [key, sheet.headers.indexOf(header as string)]),
  ) as Partial<Record<ImportFieldKey, number>>;

  let rows: ImportRowResult[] = sheet.rows.map((cells, i) => {
    const raw: Partial<Record<ImportFieldKey, unknown>> = {};
    for (const [key, idx] of Object.entries(columnIndex) as [ImportFieldKey, number][]) {
      if (idx >= 0) raw[key] = cells[idx];
    }
    return normalizeImportRow(i + 2, raw, { colleges: refs.colleges, areas: refs.areas });
  });
  rows = dedupeImportRows(rows).map((r) =>
    r.status === 'created' && r.university_student_no && refs.existing.has(r.university_student_no)
      ? { ...r, status: 'updated' as const }
      : r,
  );

  if (!opts.dryRun) {
    rows = await commitRows(db, cfg, opts, rows, refs.colleges);
  }

  const accepted = rows.filter((r) => r.status === 'created' || r.status === 'updated');
  const needsMapping = accepted.filter((r) => r.data && !r.data.area_primary_id && r.data.area_other_text).length;
  const summary = summarizeImport(rows);

  if (!opts.dryRun) {
    await writeAudit(db, {
      actor: opts.actorId,
      universityId: opts.universityId,
      action: 'import.run',
      entity: 'students',
      after: { summary, needs_area_mapping: needsMapping },
      ip: opts.ip ?? null,
    });
  }

  return {
    summary,
    rows: rows.map(({ data: _data, ...rest }) => rest),
    headers: sheet.headers,
    mapping,
    needs_area_mapping: needsMapping,
    dry_run: opts.dryRun,
  };
}

async function commitRows(
  db: Db,
  cfg: Config,
  opts: ImportOptions,
  rows: ImportRowResult[],
  colleges: RefItem[],
): Promise<ImportRowResult[]> {
  const newCollegeNames = [
    ...new Set(rows.filter((r) => r.data?.college_name && !r.data.college_id).map((r) => normalizeText(r.data?.college_name))),
  ];
  let allColleges = colleges;
  if (newCollegeNames.length) {
    const { data, error } = await db.rpc('ensure_colleges', {
      p_university_id: opts.universityId,
      p_names: newCollegeNames,
    });
    if (error) throw new ApiError(500, 'INTERNAL');
    allColleges = (data ?? []) as RefItem[];
  }
  const collegeByKey = new Map(allColleges.map((c) => [foldArabic(c.name), c.id]));

  const toStudentData = (r: ImportRowResult): StudentData | null => {
    if (!r.data) return null;
    // no college in the sheet → the student picks it at first login
    const collegeId = r.data.college_id ?? (r.data.college_name ? collegeByKey.get(foldArabic(r.data.college_name)) : null) ?? null;
    if (r.data.college_name && !collegeId) return null;
    return {
      full_name: r.data.full_name,
      university_student_no: r.data.university_student_no,
      national_id: r.data.national_id,
      phone_e164: r.data.phone_e164,
      college_id: collegeId,
      residence_text: r.data.residence_text,
      area_primary_id: r.data.area_primary_id,
      area_secondary_id: r.data.area_secondary_id,
      area_other_text: r.data.area_other_text,
      work_days: r.data.work_days,
      shift_start: r.data.shift_start,
    };
  };

  const out = [...rows];
  const reject = (index: number, reason: string) => {
    const r = out[index] as ImportRowResult;
    out[index] = { ...r, status: 'rejected', reasons: [...r.reasons, reason] };
  };

  // Updates: one transaction per batch of 100.
  const updates = out.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'updated');
  for (let b = 0; b < updates.length; b += 100) {
    const batch = updates.slice(b, b + 100);
    const payload = batch.map(({ r }) => toStudentData(r)).filter(Boolean);
    const { error } = await db.rpc('import_update_students', { p_university_id: opts.universityId, p_rows: payload });
    if (error) for (const { i } of batch) reject(i, arShared.import.PROVISION_FAILED);
  }

  // Creates: each row provisions an auth user; failures are rolled back per row.
  const creates = out.map((r, i) => ({ r, i })).filter(({ r }) => r.status === 'created');
  for (let b = 0; b < creates.length; b += 100) {
    await pool(creates.slice(b, b + 100), 4, async ({ r, i }) => {
      const data = toStudentData(r);
      if (!data) return reject(i, arShared.import.PROVISION_FAILED);
      const res = await provisionStudent(db, cfg, opts.universityId, data, null);
      if (!res.ok) {
        if (res.code === 'STUDENT_EXISTS') {
          out[i] = { ...r, status: 'updated' };
          await db.rpc('import_update_students', { p_university_id: opts.universityId, p_rows: [data] });
        } else reject(i, arShared.import.PROVISION_FAILED);
      }
    });
  }
  return out;
}
