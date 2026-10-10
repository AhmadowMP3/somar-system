import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, FileSpreadsheet, FileText, Plus, Printer, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/app/auth';
import { useToast } from '@/components/ui/overlay';
import { Badge, Button, Input, Select } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { PHOTO_BUCKET, supabase, unwrap } from '@/lib/supabase';
import { storeSelection } from '@/lib/selection';
import { cn } from '@/lib/utils';
import { ActiveBadge, exportNamesAndNumbers, useAreas, useColleges, usePackages, WEEK_DAYS, WithUniversity } from './common';
import { StudentsBulkBar } from './StudentsBulkBar';

export type StudentListRow = {
  student_id: string;
  university_id: string;
  college_id: string;
  college_name: string | null;
  transport_number: string;
  full_name: string;
  university_student_no: string;
  phone_e164: string;
  area_primary_id: string | null;
  area_primary_name: string | null;
  area_other_text: string | null;
  needs_area_mapping: boolean;
  work_days: number[];
  has_photo: boolean;
  is_active: boolean;
  profile_role: string | null;
  package_id: string | null;
  package_name: string | null;
  subscription_ends_on: string | null;
  quota: number;
  used: number;
  remaining: number;
};

export default function StudentsPage() {
  return <WithUniversity>{(universityId) => <StudentsBody universityId={universityId} />}</WithUniversity>;
}

const FILTER_KEYS = ['q', 'college', 'package', 'area', 'day', 'balance', 'photo', 'active'] as const;
type Filters = Record<(typeof FILTER_KEYS)[number], string>;

const PAGE_SIZES = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 50;
// PostgREST returns at most 1000 rows per request
const ID_PAGE = 1000;
// signed photo links live an hour; cached links are dropped well before that
const PHOTO_URL_SECONDS = 3600;
const PHOTO_STALE_MS = 45 * 60 * 1000;

/** The list's filters on v_rider_balance — one place for the page query and «select all matching». */
function filteredStudents(universityId: string, filters: Filters, lowBalance: number, columns: string, withCount = false) {
  let q = supabase
    .from('v_rider_balance')
    .select(columns, withCount ? { count: 'exact' } : undefined)
    .eq('university_id', universityId)
    .eq('kind', 'student');
  if (filters.q) {
    const term = filters.q.replace(/[,()]/g, ' ').trim();
    q = q.or(
      `full_name.ilike.%${term}%,transport_number.ilike.%${term}%,university_student_no.ilike.%${term}%,phone_e164.ilike.%${term}%`,
    );
  }
  if (filters.college) q = q.eq('college_id', filters.college);
  if (filters.package === 'none') q = q.is('package_id', null);
  else if (filters.package) q = q.eq('package_id', filters.package);
  if (filters.area === 'mapping') q = q.eq('needs_area_mapping', true);
  else if (filters.area) q = q.eq('area_primary_id', filters.area);
  if (filters.day) q = q.contains('work_days', [Number(filters.day)]);
  if (filters.photo === 'yes') q = q.eq('has_photo', true);
  if (filters.photo === 'no') q = q.eq('has_photo', false);
  if (filters.active === 'yes') q = q.eq('is_active', true);
  if (filters.active === 'no') q = q.eq('is_active', false);
  if (filters.balance === 'zero') q = q.not('package_id', 'is', null).lte('remaining', 0);
  if (filters.balance === 'low') q = q.not('package_id', 'is', null).lte('remaining', lowBalance);
  if (filters.balance === 'ok') q = q.gt('remaining', lowBalance);
  return q;
}

/** Every student id matching the filters, fetched in pages past the API row cap. */
async function matchingIds(universityId: string, filters: Filters, lowBalance: number): Promise<string[]> {
  const all: string[] = [];
  for (let from = 0; ; from += ID_PAGE) {
    const part = unwrap(
      await filteredStudents(universityId, filters, lowBalance, 'student_id')
        .order('transport_number')
        .range(from, from + ID_PAGE - 1),
    ) as unknown as { student_id: string }[];
    all.push(...part.map((r) => r.student_id));
    if (part.length < ID_PAGE) return all;
  }
}

/** Signed photo links for the shown page only, created in one storage call. */
async function fetchPhotoUrls(ids: string[]): Promise<Record<string, string>> {
  const rows = unwrap(await supabase.from('students').select('id, photo_path').in('id', ids)) as { id: string; photo_path: string | null }[];
  const withPhoto = rows.filter((r): r is { id: string; photo_path: string } => Boolean(r.photo_path));
  if (!withPhoto.length) return {};
  const { data } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(
    withPhoto.map((r) => r.photo_path),
    PHOTO_URL_SECONDS,
  );
  const byPath = new Map((data ?? []).filter((d) => d.path && d.signedUrl).map((d) => [d.path as string, d.signedUrl]));
  return Object.fromEntries(withPhoto.flatMap((r) => (byPath.has(r.photo_path) ? [[r.id, byPath.get(r.photo_path) as string]] : [])));
}

function Avatar({ name, url }: { name: string; url?: string }) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  if (url && url !== brokenUrl) {
    return (
      <img
        src={url}
        alt={t.admin.students.photoOf(name)}
        loading="lazy"
        decoding="async"
        width={40}
        height={40}
        className="h-10 w-10 shrink-0 rounded-full border border-border bg-surface object-cover"
        onError={() => setBrokenUrl(url)}
      />
    );
  }
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join(' ');
  return (
    <span
      aria-hidden
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-xs font-bold text-brand-ink"
    >
      {initials}
    </span>
  );
}

/** Page numbers around the current one, the first and the last, with gaps between. */
function pageList(page: number, pages: number): (number | 'gap')[] {
  const keep = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  sorted.forEach((p, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && p - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && p - prev > 2) out.push('gap');
    out.push(p);
  });
  return out;
}

function Pager({ page, size, count, onPage }: { page: number; size: number; count: number; onPage: (page: number) => void }) {
  const p = t.admin.students.pager;
  const pages = Math.max(1, Math.ceil(count / size));
  const from = count ? (page - 1) * size + 1 : 0;
  const to = Math.min(page * size, count);
  return (
    <nav aria-label={p.label} className="mt-4 flex flex-wrap items-center justify-between gap-3" data-testid="students-pager">
      <p className="text-sm text-muted num">{p.range(from, to, count)}</p>
      {pages > 1 ? (
        <ul className="flex flex-wrap items-center gap-1">
          <li>
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={p.prev}>
              <ChevronRight className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{p.prev}</span>
            </Button>
          </li>
          {pageList(page, pages).map((n, i) =>
            n === 'gap' ? (
              <li key={`gap-${i}`} className="px-1 text-muted" aria-hidden>
                …
              </li>
            ) : (
              <li key={n}>
                <Button
                  size="sm"
                  variant={n === page ? 'secondary' : 'ghost'}
                  className="num min-w-[42px] px-2"
                  aria-label={p.page(n)}
                  aria-current={n === page ? 'page' : undefined}
                  onClick={() => onPage(n)}
                >
                  {n}
                </Button>
              </li>
            ),
          )}
          <li>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={p.next}>
              <span className="hidden sm:inline">{p.next}</span>
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
          </li>
        </ul>
      ) : null}
    </nav>
  );
}

function CheckBox({
  checked,
  indeterminate,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <label className="flex min-h-touch min-w-touch cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        className="h-5 w-5 cursor-pointer accent-brand-ink"
        checked={checked}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate);
        }}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label}
        data-testid={testId}
      />
    </label>
  );
}

const EMPTY_SELECTION = new Set<string>();

function StudentsBody({ universityId }: { universityId: string }) {
  const { can } = useAuth();
  const s = t.admin.students;
  const f = s.filters;
  const b = s.bulk;
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const colleges = useColleges(universityId);
  const packages = usePackages(universityId);
  const areas = useAreas(universityId);
  const ids = { search: useId() };
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Filters;
  const filterKey = JSON.stringify([universityId, filters]);
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
  const size = PAGE_SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : DEFAULT_PAGE_SIZE;

  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  const setFilter = (key: string, value: string) => updateParams({ [key]: value, page: null });
  const setPage = (n: number) => updateParams({ page: n > 1 ? String(n) : null });

  // the selection belongs to one filter set: a new filter starts empty, paging keeps it
  const [selection, setSelection] = useState<{ key: string; ids: Set<string> }>({ key: filterKey, ids: EMPTY_SELECTION });
  const selected = selection.key === filterKey ? selection.ids : EMPTY_SELECTION;
  const setSelected = (next: Set<string>) => setSelection({ key: filterKey, ids: next });
  const [selectingAll, setSelectingAll] = useState(false);

  const threshold = useQuery({
    queryKey: ['settings', universityId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_settings', { p_university_id: universityId });
      if (error) throw error;
      return (data as { low_balance_threshold: number }).low_balance_threshold;
    },
  });
  const lowBalance = threshold.data ?? 2;

  const query = useQuery({
    queryKey: ['students', universityId, filters, lowBalance, page, size],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const from = (page - 1) * size;
      const res = await filteredStudents(universityId, filters, lowBalance, '*', true)
        .order('transport_number')
        .range(from, from + size - 1);
      // a page past the end (rows deleted, or an old link): go back to the first page. PostgREST answers
      // 416 only beyond the total; a page starting exactly at it comes back empty instead
      const empty = !res.error && page > 1 && (res.data?.length ?? 0) === 0;
      if (res.error?.code === 'PGRST103' || empty) return { rows: [] as StudentListRow[], count: res.count ?? 0, outOfRange: true };
      return { rows: unwrap(res) as unknown as StudentListRow[], count: res.count ?? 0, outOfRange: false };
    },
  });
  const outOfRange = Boolean(query.data?.outOfRange) && page > 1 && !query.isPlaceholderData;
  useEffect(() => {
    if (!outOfRange) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [outOfRange, setParams]);

  const rows = useMemo(() => query.data?.rows ?? [], [query.data]);
  const count = query.data?.count ?? 0;

  const photoIds = useMemo(() => rows.filter((r) => r.has_photo).map((r) => r.student_id), [rows]);
  const photos = useQuery({
    queryKey: ['student-photos', photoIds],
    enabled: photoIds.length > 0,
    staleTime: PHOTO_STALE_MS,
    gcTime: PHOTO_STALE_MS,
    queryFn: () => fetchPhotoUrls(photoIds),
  });
  const photoUrl = (id: string) => photos.data?.[id];

  const pageIds = rows.map((r) => r.student_id);
  const pageSelectedCount = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && pageSelectedCount === pageIds.length;
  const allMatching = count > 0 && selected.size >= count;

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const togglePage = (on: boolean) => {
    const next = new Set(selected);
    for (const id of pageIds) {
      if (on) next.add(id);
      else next.delete(id);
    }
    setSelected(next);
  };
  const selectAllMatching = async () => {
    const key = filterKey;
    setSelectingAll(true);
    try {
      setSelection({ key, ids: new Set(await matchingIds(universityId, filters, lowBalance)) });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSelectingAll(false);
    }
  };

  // the roster prints the list as filtered; filters it cannot express travel as a stored id list
  const [openingRoster, setOpeningRoster] = useState(false);
  const openRoster = async () => {
    const base = `/admin/roster?university=${universityId}&kind=student`;
    const simple = FILTER_KEYS.every((k) => k === 'college' || k === 'package' || !filters[k]);
    if (simple) {
      navigate(`${base}${filters.college ? `&college=${filters.college}` : ''}${filters.package ? `&package=${filters.package}` : ''}`);
      return;
    }
    setOpeningRoster(true);
    try {
      navigate(`${base}&sel=${storeSelection(await matchingIds(universityId, filters, lowBalance))}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOpeningRoster(false);
    }
  };

  const printHref = useMemo(() => {
    if (filters.package && filters.package !== 'none') return `/admin/cards?package=${filters.package}`;
    if (filters.college) return `/admin/cards?college=${filters.college}`;
    // every match is on this page and the list is short: print exactly those
    if (rows.length && rows.length === count && rows.length <= 60) return `/admin/cards?ids=${rows.map((r) => r.student_id).join(',')}`;
    return `/admin/cards?university=${universityId}&kind=student`;
  }, [filters.package, filters.college, rows, count, universityId]);

  return (
    <div>
      <PageHeader
        title={s.title}
        subtitle={query.data ? s.count(count) : undefined}
        actions={
          <>
            <Button asChild>
              <Link to={printHref}>
                <Printer className="h-4 w-4" aria-hidden />
                {s.printCards}
              </Link>
            </Button>
            {can('import') ? (
              <Button asChild data-testid="students-import">
                <Link to="/admin/import">
                  <FileSpreadsheet className="h-4 w-4" aria-hidden />
                  {t.admin.members.import}
                </Link>
              </Button>
            ) : null}
            <Button onClick={() => void exportNamesAndNumbers(universityId, 'student', t.admin.exportNamesFile.student)} data-testid="export-names">
              <Download className="h-4 w-4" aria-hidden />
              {t.admin.exportNames}
            </Button>
            <Button onClick={() => void openRoster()} disabled={openingRoster} data-testid="export-pdf">
              <FileText className="h-4 w-4" aria-hidden />
              {t.admin.exportPdf}
            </Button>
            <Button asChild variant="secondary">
              <Link to="/admin/students/new">
                <Plus className="h-4 w-4" aria-hidden />
                {s.add}
              </Link>
            </Button>
          </>
        }
      />
      <div className="mb-4 space-y-3 rounded-xl border border-border bg-bg p-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter('q', search.trim());
          }}
        >
          <label htmlFor={ids.search} className="sr-only">
            {t.common.search}
          </label>
          <Input id={ids.search} placeholder={t.common.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} />
          <Button type="submit" variant="secondary" aria-label={t.common.search}>
            <Search className="h-4 w-4" />
          </Button>
        </form>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Select aria-label={f.college} value={filters.college} onChange={(e) => setFilter('college', e.target.value)}>
            <option value="">{f.college}: {t.common.all}</option>
            {(colleges.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label={f.package} value={filters.package} onChange={(e) => setFilter('package', e.target.value)}>
            <option value="">{f.package}: {t.common.all}</option>
            <option value="none">{f.noPackage}</option>
            {(packages.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select aria-label={f.area} value={filters.area} onChange={(e) => setFilter('area', e.target.value)}>
            <option value="">{f.area}: {t.common.all}</option>
            <option value="mapping">{s.needsMapping}</option>
            {(areas.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <Select aria-label={f.workDay} value={filters.day} onChange={(e) => setFilter('day', e.target.value)}>
            <option value="">{f.workDay}: {t.common.all}</option>
            {WEEK_DAYS.map((d) => (
              <option key={d} value={d}>
                {t.days[d]}
              </option>
            ))}
          </Select>
          <Select aria-label={f.balance} value={filters.balance} onChange={(e) => setFilter('balance', e.target.value)}>
            <option value="">{f.balance}: {t.common.all}</option>
            <option value="zero">{f.balanceZero}</option>
            <option value="low">{f.balanceLow}</option>
            <option value="ok">{f.balanceOk}</option>
          </Select>
          <Select aria-label={f.photo} value={filters.photo} onChange={(e) => setFilter('photo', e.target.value)}>
            <option value="">{f.photo}: {t.common.all}</option>
            <option value="yes">{f.hasPhoto}</option>
            <option value="no">{f.noPhoto}</option>
          </Select>
          <Select aria-label={f.active} value={filters.active} onChange={(e) => setFilter('active', e.target.value)}>
            <option value="">{f.active}: {t.common.all}</option>
            <option value="yes">{t.common.active}</option>
            <option value="no">{t.common.inactive}</option>
          </Select>
        </div>
      </div>
      <QueryState
        query={query}
        empty={(d) => (d.rows.length || d.outOfRange ? null : <EmptyState title={s.empty} hint={s.emptyHint} />)}
      >
        {() => (
          <>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1 text-sm font-semibold">
                <CheckBox
                  checked={allOnPage}
                  indeterminate={pageSelectedCount > 0 && !allOnPage}
                  onChange={togglePage}
                  label={b.selectPage}
                  testId="students-select-page"
                />
                <span aria-hidden>{b.selectPage}</span>
              </div>
              <Select
                aria-label={s.pager.size}
                className="w-auto"
                value={size}
                onChange={(e) => updateParams({ size: Number(e.target.value) === DEFAULT_PAGE_SIZE ? null : e.target.value, page: null })}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {s.pager.perPage(n)}
                  </option>
                ))}
              </Select>
            </div>
            {allOnPage && count > pageIds.length ? (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-brand-ink/5 px-3 py-2 text-sm" role="status">
                {allMatching ? (
                  <>
                    <span className="num">{b.allSelected(count)}</span>
                    <Button size="sm" variant="link" onClick={() => setSelected(new Set())}>
                      {b.clear}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="num">{b.pageSelected(pageIds.length)}</span>
                    <Button size="sm" variant="link" disabled={selectingAll} onClick={() => void selectAllMatching()}>
                      <span className="num">{selectingAll ? b.selectingAll : b.selectAll(count)}</span>
                    </Button>
                  </>
                )}
              </div>
            ) : null}
            <div className={cn('transition-opacity', query.isPlaceholderData && 'opacity-60')} aria-busy={query.isFetching}>
              <DataList
                rows={rows}
                rowKey={(r) => r.student_id}
                onRowClick={(r) => navigate(`/admin/students/${r.student_id}`)}
                rowClassName={(r) => (selected.has(r.student_id) ? 'bg-brand-ink/5' : undefined)}
                leading={{
                  header: <CheckBox checked={allOnPage} indeterminate={pageSelectedCount > 0 && !allOnPage} onChange={togglePage} label={b.selectPage} />,
                  cell: (r) => (
                    <CheckBox
                      checked={selected.has(r.student_id)}
                      onChange={(on) => toggle(r.student_id, on)}
                      label={b.selectRow(r.full_name)}
                      testId="student-row-check"
                    />
                  ),
                }}
                cardTitle={(r) => (
                  <span className="flex items-center gap-3">
                    <Avatar name={r.full_name} url={photoUrl(r.student_id)} />
                    <span className="min-w-0 flex-1">{r.full_name}</span>
                    <span className="num font-mono text-sm text-brand-ink">{r.transport_number}</span>
                  </span>
                )}
                columns={[
                  { key: 'tn', header: t.student.transportNumber, cell: (r) => <span className="num font-mono">{r.transport_number}</span>, mobileHidden: true },
                  {
                    key: 'name',
                    header: t.common.name,
                    mobileHidden: true,
                    cell: (r) => (
                      <span className="flex items-center gap-2">
                        <Avatar name={r.full_name} url={photoUrl(r.student_id)} />
                        <span className="flex flex-wrap items-center gap-1">
                          {r.full_name}
                          {r.profile_role === 'supervisor' ? <Badge tone="info">{s.isSupervisor}</Badge> : null}
                        </span>
                      </span>
                    ),
                  },
                  { key: 'college', header: t.student.college, cell: (r) => r.college_name },
                  { key: 'package', header: t.student.package, cell: (r) => r.package_name ?? <span className="text-muted">{s.noSubscription}</span> },
                  {
                    key: 'balance',
                    header: t.student.remainingShort,
                    cell: (r) =>
                      r.package_id ? (
                        <Badge tone={r.remaining <= 0 ? 'danger' : r.remaining <= lowBalance ? 'warning' : 'success'}>
                          <span className="num">
                            {r.remaining} / {r.quota}
                          </span>
                        </Badge>
                      ) : (
                        t.common.none
                      ),
                  },
                  {
                    key: 'area',
                    header: t.student.area,
                    cell: (r) => r.area_primary_name ?? (r.area_other_text ? <Badge tone="warning">{r.area_other_text}</Badge> : t.common.none),
                  },
                  { key: 'photo', header: t.student.photo, cell: (r) => (r.has_photo ? <Badge tone="success">✓</Badge> : <Badge>{s.filters.noPhoto}</Badge>) },
                  { key: 'status', header: t.common.status, cell: (r) => <ActiveBadge active={r.is_active} /> },
                ]}
              />
            </div>
            <Pager page={page} size={size} count={count} onPage={setPage} />
          </>
        )}
      </QueryState>
      {selected.size ? (
        <StudentsBulkBar universityId={universityId} ids={[...selected]} onClear={() => setSelected(new Set())} />
      ) : null}
    </div>
  );
}
