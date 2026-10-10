import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Columns3, FileSpreadsheet, Printer } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { damascusDate, formatClock, formatDate, formatPhoneDisplay } from '@somar/shared';
import { WEEK_DAYS, type RiderKind } from '@/features/admin/common';
import { Button } from '@/components/ui/primitives';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { exportSheet } from '@/lib/exportSheet';
import { readSelection } from '@/lib/selection';
import { PHOTO_BUCKET, supabase, unwrap } from '@/lib/supabase';

/** Brand colours, fixed so the PDF looks the same whatever theme the screen uses. */
const BRAND = { red: '#C1121F', ink: '#2B2F36', silver: '#C9CDD3', zebra: '#F4F5F7', muted: '#5B616B' };

const printCss = (landscape: boolean) => `
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: ${landscape ? '10mm 8mm 12mm' : '14mm 12mm 16mm'}; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff !important; }
    .roster-sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; width: auto !important; }
  }
  .roster-table thead { display: table-header-group; }
  .roster-table tr { break-inside: avoid; }
`;

/** Above this many data columns the sheet turns landscape with a smaller font. */
const WIDE_AFTER = 5;
const PAGE = 1000;
const ID_CHUNK = 150;

type Row = {
  student_id: string;
  transport_number: string;
  full_name: string;
  college_name: string | null;
  university_student_no: string | null;
  phone_e164: string | null;
  residence_text: string | null;
  area_primary_name: string | null;
  area_other_text: string | null;
  work_days: number[] | null;
  shift_start: string | null;
  is_active: boolean;
  profile_role: string | null;
  created_at: string;
  package_name: string | null;
  subscription_ends_on: string | null;
  quota: number;
  remaining: number;
  job_title: string | null;
  work_hours_text: string | null;
  notes: string | null;
};
type Extra = { id: string; photo_path: string | null; national_id: string | null; home_stop: { name: string } | null };
type FullRow = Row & { extra?: Extra; photoUrl?: string | null };

const VIEW_COLUMNS =
  'student_id, transport_number, full_name, college_name, university_student_no, phone_e164, residence_text, area_primary_name, area_other_text, work_days, shift_start, is_active, profile_role, created_at, package_name, subscription_ends_on, quota, remaining, job_title, work_hours_text, notes';

type ColumnKey = keyof typeof t.roster.columns;
type ColumnDef = {
  key: ColumnKey;
  kinds?: RiderKind[];
  /** Needs the students table (not in v_rider_balance). */
  extra?: boolean;
  align?: 'center' | 'start';
  mono?: boolean;
  text: (r: FullRow, i: number) => string;
  cell?: (r: FullRow, i: number) => ReactNode;
};

const MEMBERS: RiderKind[] = ['doctor', 'employee'];
const dayNames = (days: number[] | null) =>
  WEEK_DAYS.filter((d) => days?.includes(d))
    .map((d) => t.days[d])
    .join('، ');

const COLUMNS: ColumnDef[] = [
  { key: 'index', align: 'center', text: (_, i) => String(i + 1) },
  {
    key: 'photo',
    extra: true,
    align: 'center',
    text: (r) => (r.extra?.photo_path ? '✓' : ''),
    cell: (r) =>
      r.photoUrl ? (
        <img src={r.photoUrl} alt="" className="mx-auto h-[12mm] w-[10mm] rounded-sm object-cover" />
      ) : (
        <span className="mx-auto block h-[12mm] w-[10mm] rounded-sm" style={{ background: BRAND.zebra, border: `1px solid ${BRAND.silver}` }} />
      ),
  },
  { key: 'name', text: (r) => r.full_name },
  { key: 'transport', align: 'center', mono: true, text: (r) => r.transport_number },
  { key: 'college', kinds: ['student'], text: (r) => r.college_name ?? '' },
  { key: 'universityNo', kinds: ['student'], align: 'center', mono: true, text: (r) => r.university_student_no ?? '' },
  { key: 'nationalId', extra: true, align: 'center', mono: true, text: (r) => r.extra?.national_id ?? '' },
  { key: 'phone', align: 'center', mono: true, text: (r) => formatPhoneDisplay(r.phone_e164) },
  { key: 'residence', text: (r) => r.residence_text ?? '' },
  { key: 'area', text: (r) => r.area_primary_name ?? r.area_other_text ?? '' },
  { key: 'homeStop', extra: true, text: (r) => r.extra?.home_stop?.name ?? '' },
  { key: 'package', kinds: ['student'], text: (r) => r.package_name ?? '' },
  { key: 'balance', kinds: ['student'], align: 'center', text: (r) => (r.package_name ? `${r.remaining} / ${r.quota}` : '') },
  { key: 'subscriptionEnd', kinds: ['student'], align: 'center', text: (r) => formatDate(r.subscription_ends_on) },
  { key: 'workDays', text: (r) => dayNames(r.work_days) },
  { key: 'shiftStart', kinds: ['student'], align: 'center', text: (r) => formatClock(r.shift_start) },
  { key: 'status', align: 'center', text: (r) => (r.is_active ? t.common.active : t.common.inactive) },
  { key: 'role', align: 'center', text: (r) => t.roster.supervisorRoles[r.profile_role ?? ''] ?? '' },
  { key: 'jobTitle', kinds: MEMBERS, text: (r) => r.job_title ?? '' },
  { key: 'workHours', kinds: MEMBERS, text: (r) => r.work_hours_text ?? '' },
  { key: 'notes', kinds: MEMBERS, text: (r) => r.notes ?? '' },
  { key: 'created', align: 'center', text: (r) => formatDate(damascusDate(new Date(r.created_at))) },
];

const DEFAULT_COLUMNS: ColumnKey[] = ['index', 'name', 'transport'];
const storageKey = (kind: RiderKind) => `somar-roster-columns:${kind}`;

function loadColumns(kind: RiderKind, allowed: ColumnKey[]): ColumnKey[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(kind)) ?? 'null') as unknown;
    if (Array.isArray(saved)) {
      const keys = saved.filter((k): k is ColumnKey => allowed.includes(k as ColumnKey));
      if (keys.length) return keys;
    }
  } catch {
    // unreadable storage: fall back to the defaults
  }
  return DEFAULT_COLUMNS;
}

function saveColumns(kind: RiderKind, keys: ColumnKey[]) {
  try {
    localStorage.setItem(storageKey(kind), JSON.stringify(keys));
  } catch {
    // not remembered, still works for this visit
  }
}

const chunks = <T,>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

type Scope = { universityId: string; kind: RiderKind; ids: string[] | null; college: string; pkg: string };

/** Every matching row of v_rider_balance, past the 1000-row API cap. */
async function fetchRows({ universityId, kind, ids, college, pkg }: Scope): Promise<Row[]> {
  const base = () => {
    let q = supabase.from('v_rider_balance').select(VIEW_COLUMNS).eq('university_id', universityId).eq('kind', kind);
    if (college) q = q.eq('college_id', college);
    if (pkg === 'none') q = q.is('package_id', null);
    else if (pkg) q = q.eq('package_id', pkg);
    return q;
  };
  const all: Row[] = [];
  if (ids) {
    for (const part of chunks(ids, ID_CHUNK)) all.push(...(unwrap(await base().in('student_id', part)) as unknown as Row[]));
    return all.sort((a, b) => a.transport_number.localeCompare(b.transport_number));
  }
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(await base().order('transport_number').range(from, from + PAGE - 1)) as unknown as Row[];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

/** Photo path, national id and nearest stop live only on the students table. */
async function fetchExtras(ids: string[]): Promise<Map<string, Extra>> {
  const map = new Map<string, Extra>();
  for (const part of chunks(ids, ID_CHUNK)) {
    const rows = unwrap(
      await supabase.from('students').select('id, photo_path, national_id, home_stop:stops!students_home_stop_id_fkey(name)').in('id', part),
    ) as unknown as Extra[];
    for (const r of rows) map.set(r.id, r);
  }
  return map;
}

async function fetchPhotoUrls(paths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const part of chunks(paths, 100)) {
    const { data, error } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(part, 3600);
    if (error) throw error;
    for (const d of data ?? []) if (d.path && d.signedUrl) map.set(d.path, d.signedUrl);
  }
  return map;
}

/**
 * Students, doctors or employees as a branded A4 sheet with the columns the staff pick;
 * «حفظ كملف PDF» in the print dialog turns it into the PDF (browsers shape Arabic correctly).
 * Scope: `university` + `kind`, narrowed by `sel` (a stored selection), `ids`, `college` or `package`.
 */
export default function RosterPrintPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const universityId = params.get('university') ?? '';
  const kind = (['student', 'doctor', 'employee'].includes(params.get('kind') ?? '') ? params.get('kind') : 'student') as RiderKind;
  const r = t.roster;

  const selKey = params.get('sel');
  const idsParam = params.get('ids');
  const ids = useMemo(() => {
    if (selKey) return readSelection(selKey) ?? [];
    return idsParam ? idsParam.split(',').filter(Boolean) : null;
  }, [selKey, idsParam]);
  const selectionLost = Boolean(selKey) && ids?.length === 0;
  const college = params.get('college') ?? '';
  const pkg = params.get('package') ?? '';

  const available = useMemo(() => COLUMNS.filter((c) => !c.kinds || c.kinds.includes(kind)), [kind]);
  const [chosen, setChosen] = useState<ColumnKey[]>(() => loadColumns(kind, available.map((c) => c.key)));
  const [chooserOpen, setChooserOpen] = useState(false);
  useEffect(() => setChosen(loadColumns(kind, available.map((c) => c.key))), [kind, available]);

  const setColumns = (keys: ColumnKey[]) => {
    setChosen(keys);
    saveColumns(kind, keys);
  };
  // keep the canonical order whatever order they were ticked in
  const columns = available.filter((c) => chosen.includes(c.key));
  const needsExtra = columns.some((c) => c.extra);
  const needsPhotos = chosen.includes('photo');
  const dataColumns = columns.filter((c) => c.key !== 'index').length;
  const landscape = dataColumns > WIDE_AFTER;
  const fontPt = landscape ? (dataColumns > 9 ? 7.5 : 8.5) : 11;

  const query = useQuery({
    queryKey: ['roster', universityId, kind, ids, college, pkg],
    enabled: Boolean(universityId) && !selectionLost,
    staleTime: 0,
    queryFn: async () => {
      const [rows, uni] = await Promise.all([
        fetchRows({ universityId, kind, ids, college, pkg }),
        supabase.from('universities').select('name').eq('id', universityId).single(),
      ]);
      return { rows, university: (unwrap(uni) as { name: string }).name };
    },
  });
  const rowIds = useMemo(() => (query.data?.rows ?? []).map((x) => x.student_id), [query.data]);

  const extras = useQuery({
    queryKey: ['roster-extras', rowIds],
    enabled: needsExtra && rowIds.length > 0,
    queryFn: () => fetchExtras(rowIds),
  });
  const photoPaths = useMemo(
    () => [...(extras.data?.values() ?? [])].map((e) => e.photo_path).filter((p): p is string => Boolean(p)),
    [extras.data],
  );
  const photos = useQuery({
    queryKey: ['roster-photos', photoPaths],
    enabled: needsPhotos && photoPaths.length > 0,
    staleTime: 30 * 60 * 1000,
    queryFn: () => fetchPhotoUrls(photoPaths),
  });

  const rows: FullRow[] = useMemo(
    () =>
      (query.data?.rows ?? []).map((row) => {
        const extra = extras.data?.get(row.student_id);
        return { ...row, extra, photoUrl: extra?.photo_path ? photos.data?.get(extra.photo_path) ?? null : null };
      }),
    [query.data, extras.data, photos.data],
  );
  const extrasPending = (needsExtra && extras.isLoading) || (needsPhotos && photos.isLoading);
  const extrasFailed = (needsExtra && extras.isError) || (needsPhotos && photos.isError);

  // printing before the photos download leaves blank boxes in the PDF: wait for every <img> on the sheet
  const sheetRef = useRef<HTMLElement>(null);
  const [imagesFor, setImagesFor] = useState<FullRow[] | null>(null);
  useEffect(() => {
    const imgs = [...(sheetRef.current?.querySelectorAll('img') ?? [])];
    let cancelled = false;
    void Promise.all(imgs.map((img) => (img.complete ? null : img.decode().catch(() => null)))).then(() => {
      if (!cancelled) setImagesFor(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [rows, needsPhotos]);
  const imagesLoaded = !needsPhotos || imagesFor === rows;

  const ready = rows.length > 0 && columns.length > 0 && !extrasPending && !extrasFailed && imagesLoaded;
  const excelReady = ready && columns.some((c) => c.key !== 'photo');
  const today = formatDate(damascusDate());

  const exportExcel = () => {
    const cols = columns.filter((c) => c.key !== 'photo');
    exportSheet(
      t.admin.exportNamesFile[kind],
      rows.map((row, i) => Object.fromEntries(cols.map((c) => [r.columns[c.key], c.text(row, i)]))),
    );
  };

  return (
    <div className="min-h-dvh bg-surface print:bg-white" dir="rtl">
      <style>{printCss(landscape)}</style>
      <div className="no-print sticky top-0 z-10 border-b border-border bg-bg p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowRight className="h-4 w-4" aria-hidden />
            {t.common.back}
          </Button>
          <h1 className="text-lg font-extrabold">{r.title[kind]}</h1>
          {query.data ? <span className="text-sm text-muted">{r.count(query.data.rows.length)}</span> : null}
          <div className="ms-auto flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setChooserOpen((o) => !o)} aria-expanded={chooserOpen} aria-controls="roster-columns" data-testid="roster-columns-toggle">
              <Columns3 className="h-4 w-4" aria-hidden />
              {r.columnsCount(columns.length)}
            </Button>
            <Button variant="ghost" disabled={!excelReady} onClick={exportExcel} data-testid="roster-excel">
              <FileSpreadsheet className="h-4 w-4" aria-hidden />
              {r.exportExcel}
            </Button>
            <Button variant="secondary" disabled={!ready} onClick={() => window.print()} data-testid="roster-print">
              <Printer className="h-4 w-4" aria-hidden />
              {r.savePdf}
            </Button>
          </div>
        </div>
        {chooserOpen ? (
          <fieldset id="roster-columns" className="mt-3 rounded-xl border border-border p-3" data-testid="roster-columns">
            <legend className="px-1 text-sm font-bold">{r.columnsTitle}</legend>
            <div className="mb-2 flex flex-wrap gap-2">
              <Button variant="ghost" onClick={() => setColumns(available.map((c) => c.key))}>
                {r.selectAll}
              </Button>
              <Button variant="ghost" onClick={() => setColumns([])}>
                {r.clearAll}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
              {available.map((c) => (
                <label key={c.key} className="flex min-h-touch cursor-pointer items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface">
                  <input
                    type="checkbox"
                    className="h-5 w-5 shrink-0"
                    checked={chosen.includes(c.key)}
                    onChange={(e) => setColumns(e.target.checked ? [...chosen, c.key] : chosen.filter((k) => k !== c.key))}
                    data-testid={`roster-col-${c.key}`}
                  />
                  {c.key === 'index' ? r.indexLabel : r.columns[c.key]}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {columns.length === 0 ? <p className="mt-2 text-xs font-semibold text-danger">{r.pickOne}</p> : null}
        {landscape ? <p className="mt-2 text-xs text-muted">{r.landscapeHint}</p> : null}
        <p className="mt-1 w-full text-xs text-muted">{t.cards.printHint}</p>
      </div>

      {selectionLost ? (
        <div className="p-6">
          <EmptyState title={r.selectionLost} />
        </div>
      ) : query.isLoading ? (
        <div className="p-6">
          <ListSkeleton rows={4} />
        </div>
      ) : query.isError ? (
        <div className="p-6">
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : !query.data?.rows.length ? (
        <div className="p-6">
          <EmptyState title={r.empty} />
        </div>
      ) : needsExtra && extras.isError ? (
        <div className="p-6">
          <ErrorState error={extras.error} onRetry={() => void extras.refetch()} />
        </div>
      ) : needsPhotos && photos.isError ? (
        <div className="p-6">
          <ErrorState error={photos.error} onRetry={() => void photos.refetch()} />
        </div>
      ) : (
        <div className="flex justify-center p-4 print:block print:p-0">
          <article
            ref={sheetRef}
            className={`roster-sheet max-w-full bg-white shadow-md ${landscape ? 'w-[297mm] p-[8mm]' : 'w-[210mm] p-[12mm]'}`}
            style={{ color: BRAND.ink, fontSize: `${fontPt}pt` }}
            data-ready={ready ? 'true' : 'false'}
          >
            <header className="mb-5 flex items-center justify-between gap-4 pb-4" style={{ borderBottom: `3px solid ${BRAND.red}` }}>
              <div className="min-w-0">
                <p className="text-[9pt] font-bold tracking-wide" style={{ color: BRAND.red }}>
                  {t.brand}
                </p>
                <h2 className="mt-1 text-[18pt] font-extrabold leading-tight">{r.title[kind]}</h2>
                <p className="mt-1 text-[10pt]">{query.data.university}</p>
              </div>
              <img src="/icons/logo.png" alt={t.brand} className="h-[22mm] w-auto shrink-0" />
            </header>

            <div className="mb-3 flex flex-wrap justify-between gap-2 text-[9pt]" style={{ color: BRAND.muted }}>
              <span>
                {r.date}: <span className="num">{today}</span>
              </span>
              <span>{r.count(rows.length)}</span>
            </div>

            <div className="overflow-x-auto print:overflow-visible">
              <table className="roster-table w-full border-collapse text-start" data-testid="roster-table">
                <thead>
                  <tr style={{ background: BRAND.red, color: '#fff' }}>
                    {columns.map((c) => (
                      <th
                        key={c.key}
                        className={`font-bold ${landscape ? 'px-1.5 py-1.5' : 'px-3 py-2'} ${c.align === 'center' ? 'text-center' : 'text-start'}`}
                        style={{ fontSize: '0.92em' }}
                      >
                        {r.columns[c.key]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.student_id} style={{ background: i % 2 ? BRAND.zebra : '#fff', borderBottom: `1px solid ${BRAND.silver}` }}>
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={[
                            landscape ? 'px-1.5 py-1' : 'px-3 py-1.5',
                            c.align === 'center' ? 'text-center' : 'text-start',
                            c.key === 'name' ? 'font-semibold' : '',
                            c.key === 'transport' ? 'font-bold tracking-wider' : '',
                            c.mono ? 'num font-mono' : '',
                          ].join(' ')}
                          style={c.key === 'index' ? { color: BRAND.muted, fontSize: '0.85em' } : undefined}
                          dir={c.mono ? 'ltr' : undefined}
                        >
                          {c.cell ? c.cell(row, i) : c.text(row, i)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <footer className="mt-6 flex justify-between pt-2 text-[8pt]" style={{ borderTop: `1px solid ${BRAND.silver}`, color: BRAND.muted }}>
              <span>
                {t.brand} · {query.data.university}
              </span>
              <span className="num">{today}</span>
            </footer>
          </article>
        </div>
      )}
    </div>
  );
}
