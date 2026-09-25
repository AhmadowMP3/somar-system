import { useQuery } from '@tanstack/react-query';
import { Plus, Printer, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Input, Select } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';
import { ActiveBadge, useAreas, useColleges, usePackages, WEEK_DAYS, WithUniversity } from './common';

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

function StudentsBody({ universityId }: { universityId: string }) {
  const s = t.admin.students;
  const f = s.filters;
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const colleges = useColleges(universityId);
  const packages = usePackages(universityId);
  const areas = useAreas(universityId);
  const ids = { search: useId() };
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<(typeof FILTER_KEYS)[number], string>;

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const threshold = useQuery({
    queryKey: ['settings', universityId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_settings', { p_university_id: universityId });
      if (error) throw error;
      return (data as { low_balance_threshold: number }).low_balance_threshold;
    },
  });

  const query = useQuery({
    queryKey: ['students', universityId, filters, threshold.data],
    queryFn: async () => {
      let q = supabase
        .from('v_student_balance')
        .select('*', { count: 'exact' })
        .eq('university_id', universityId)
        .order('transport_number')
        .limit(500);
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
      if (filters.balance === 'low') q = q.not('package_id', 'is', null).lte('remaining', threshold.data ?? 2);
      if (filters.balance === 'ok') q = q.gt('remaining', threshold.data ?? 2);
      const res = await q;
      return { rows: unwrap(res) as StudentListRow[], count: res.count ?? 0 };
    },
  });

  const printHref = useMemo(() => {
    if (filters.package && filters.package !== 'none') return `/admin/cards?package=${filters.package}`;
    if (filters.college) return `/admin/cards?college=${filters.college}`;
    const rows = query.data?.rows ?? [];
    if (rows.length && rows.length <= 60) return `/admin/cards?ids=${rows.map((r) => r.student_id).join(',')}`;
    return `/admin/cards?university=${universityId}`;
  }, [filters.package, filters.college, query.data, universityId]);

  return (
    <div>
      <PageHeader
        title={s.title}
        subtitle={query.data ? s.count(query.data.count) : undefined}
        actions={
          <>
            <Button asChild>
              <Link to={printHref}>
                <Printer className="h-4 w-4" aria-hidden />
                {s.printCards}
              </Link>
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
        empty={(d) => (d.rows.length ? null : <EmptyState title={s.empty} hint={s.emptyHint} />)}
      >
        {(d) => (
          <DataList
            rows={d.rows}
            rowKey={(r) => r.student_id}
            onRowClick={(r) => navigate(`/admin/students/${r.student_id}`)}
            cardTitle={(r) => (
              <span className="flex items-center justify-between gap-2">
                <span>{r.full_name}</span>
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
                  <span className="flex flex-wrap items-center gap-1">
                    {r.full_name}
                    {r.profile_role === 'supervisor' ? <Badge tone="info">{s.isSupervisor}</Badge> : null}
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
                    <Badge tone={r.remaining <= 0 ? 'danger' : r.remaining <= (threshold.data ?? 2) ? 'warning' : 'success'}>
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
        )}
      </QueryState>
    </div>
  );
}
