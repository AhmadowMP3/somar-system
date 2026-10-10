import type { PostgrestError } from '@supabase/supabase-js';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatClock } from '@somar/shared';
import { useScope } from '@/app/auth';
import { Card, CardTitle, Select } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useColleges, WithUniversity, type RiderKind } from './common';

type StatRow = { dow: number; kind: 'outbound' | 'return'; slot: string; area_id: string | null; area_name: string | null; students: number };
type WorkDayRow = { dow: number; area_id: string | null; area_name: string | null; riders: number };
type CollegeRow = { dow: number; college_id: string | null; college_name: string | null; riders: number };

const KINDS: RiderKind[] = ['student', 'doctor', 'employee'];

/** The API returns at most 1000 rows per request and the rows are sorted by day: page until the last (short) page. */
async function allPages<T>(fetchPage: (from: number) => PromiseLike<{ data: unknown; error: PostgrestError | null }>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = unwrap(await fetchPage(from)) as T[];
    all.push(...page);
    if (page.length < 1000) return all;
  }
}

export default function StatsPage() {
  return <WithUniversity>{(universityId) => <StatsBody universityId={universityId} />}</WithUniversity>;
}

function StatsBody({ universityId }: { universityId: string }) {
  const s = t.admin.stats;
  const { university } = useScope();
  const weekStart = university?.week_start_dow ?? 6;
  const order = Array.from({ length: 7 }, (_, i) => ((weekStart - 1 + i) % 7) + 1);

  // filters live in the URL so a view can be shared or reloaded
  const [params, setParams] = useSearchParams();
  const kind: RiderKind = KINDS.find((k) => k === params.get('kind')) ?? 'student';
  const collegeId = params.get('college') || null;
  const picked = Number(params.get('day')) || null;
  const setParam = (key: string, value: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  const hasTimes = kind === 'student';
  const rpcArgs = { p_university_id: universityId, p_kind: kind, p_college_id: collegeId };

  const colleges = useColleges(universityId);
  const byCollege = useQuery({
    queryKey: ['attendance-by-college', universityId, kind],
    queryFn: () =>
      allPages<CollegeRow>((from) =>
        supabase.rpc('attendance_by_college', { p_university_id: universityId, p_kind: kind }).range(from, from + 999),
      ),
  });
  // members have no college on file: the college filter only makes sense when some rider has one
  const hasColleges = kind === 'student' || (byCollege.data ?? []).some((r) => r.college_id);
  const college = hasColleges ? collegeId : null;

  const progress = useQuery({
    queryKey: ['setup-progress', universityId, kind, college],
    queryFn: async () =>
      unwrap(await supabase.rpc('setup_progress', { ...rpcArgs, p_college_id: college })) as { total: number; completed: number },
  });
  const stats = useQuery({
    queryKey: ['schedule-stats', universityId, kind, college],
    enabled: hasTimes,
    queryFn: () =>
      allPages<StatRow>((from) => supabase.rpc('schedule_stats', { ...rpcArgs, p_college_id: college }).range(from, from + 999)),
  });
  const workDays = useQuery({
    queryKey: ['work-day-stats', universityId, kind, college],
    enabled: !hasTimes,
    queryFn: () =>
      allPages<WorkDayRow>((from) => supabase.rpc('work_day_stats', { ...rpcArgs, p_college_id: college }).range(from, from + 999)),
  });

  const perDay = useMemo(() => {
    const totals = new Map<number, number>();
    if (hasTimes) {
      for (const r of stats.data ?? []) if (r.kind === 'outbound') totals.set(r.dow, (totals.get(r.dow) ?? 0) + r.students);
    } else {
      for (const r of workDays.data ?? []) totals.set(r.dow, (totals.get(r.dow) ?? 0) + r.riders);
    }
    return totals;
  }, [hasTimes, stats.data, workDays.data]);
  const day = (picked && order.includes(picked) ? picked : null) ?? order.find((d) => perDay.get(d)) ?? order[0] ?? 6;

  return (
    <div className="space-y-4">
      <PageHeader title={s.title} subtitle={s.intro} />
      <div className="flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label={s.kind} className="flex rounded-lg border border-border p-1">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === kind}
              onClick={() => setParams((prev) => {
                const next = new URLSearchParams(prev);
                if (k === 'student') next.delete('kind');
                else next.set('kind', k);
                next.delete('college');
                return next;
              }, { replace: true })}
              className={cn('min-h-touch rounded-md px-3 text-sm font-semibold', k === kind ? 'bg-brand-ink text-on-ink' : '')}
              data-testid={`stats-kind-${k}`}
            >
              {s.kinds[k]}
            </button>
          ))}
        </div>
        {hasColleges ? (
          <label className="min-w-[12rem] flex-1 sm:flex-none">
            <span className="sr-only">{s.college}</span>
            <Select
              value={college ?? ''}
              onChange={(e) => setParam('college', e.target.value || null)}
              aria-label={s.college}
              data-testid="stats-college"
            >
              <option value="">{s.allColleges}</option>
              {(colleges.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
      {progress.data ? (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-semibold">
            {(hasTimes ? s.progress : s.memberProgress)(progress.data.completed, progress.data.total)}
          </p>
          <div className="h-2 w-full max-w-xs overflow-hidden rounded-full bg-surface" aria-hidden>
            <div
              className="h-full rounded-full bg-success"
              style={{ width: `${progress.data.total ? (progress.data.completed / progress.data.total) * 100 : 0}%` }}
            />
          </div>
        </Card>
      ) : null}
      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t.setup.day}>
        {order.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === day}
            onClick={() => setParam('day', String(d))}
            className={cn(
              'min-h-touch shrink-0 rounded-lg border px-3 text-sm font-semibold',
              d === day ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
            )}
            data-testid={`stats-day-${d}`}
          >
            {t.days[d]} <span className="num opacity-80">({perDay.get(d) ?? 0})</span>
          </button>
        ))}
      </div>
      {hasTimes ? (
        <QueryState query={stats}>
          {(rows) => {
            const dayRows = rows.filter((r) => r.dow === day);
            if (!dayRows.length) return <EmptyState title={s.empty} hint={s.emptyHint} />;
            return (
              <div className="space-y-4">
                <p className="text-sm">
                  {s.dayTotal}: <span className="num font-bold">{perDay.get(day) ?? 0}</span>
                </p>
                <Pivot title={s.outbound} rows={dayRows.filter((r) => r.kind === 'outbound')} testId="stats-outbound" />
                <Pivot title={s.return} rows={dayRows.filter((r) => r.kind === 'return')} testId="stats-return" />
              </div>
            );
          }}
        </QueryState>
      ) : (
        <QueryState query={workDays}>
          {(rows) => {
            const dayRows = rows.filter((r) => r.dow === day);
            return (
              <div className="space-y-4">
                <p className="text-sm text-muted">{s.memberHint}</p>
                {dayRows.length ? (
                  <>
                    <p className="text-sm">
                      {s.memberDayTotal}: <span className="num font-bold">{perDay.get(day) ?? 0}</span>
                    </p>
                    <CountTable
                      title={s.kinds[kind]}
                      head={s.area}
                      rows={dayRows.map((r) => ({ id: r.area_id ?? '', name: r.area_name ?? s.noArea, count: r.riders }))}
                      testId="stats-areas"
                    />
                  </>
                ) : (
                  <EmptyState title={s.empty} hint={s.memberEmptyHint} />
                )}
              </div>
            );
          }}
        </QueryState>
      )}
      {hasColleges ? (
        <QueryState query={byCollege}>
          {(rows) => {
            const dayRows = rows.filter((r) => r.dow === day);
            return (
              <CountTable
                title={s.byCollege}
                hint={s.byCollegeHint}
                head={s.college}
                rows={dayRows.map((r) => ({ id: r.college_id ?? '', name: r.college_name ?? s.noCollege, count: r.riders }))}
                selected={college}
                onPick={(id) => setParam('college', id === college ? null : id || null)}
                empty={s.byCollegeEmpty}
                testId="stats-by-college"
              />
            );
          }}
        </QueryState>
      ) : null}
    </div>
  );
}

/** A name → count list, largest first, with a total; rows can be clickable. */
function CountTable({
  title,
  hint,
  head,
  rows,
  selected,
  onPick,
  empty,
  testId,
}: {
  title: string;
  hint?: string;
  head: string;
  rows: { id: string; name: string; count: number }[];
  selected?: string | null;
  onPick?: (id: string) => void;
  empty?: string;
  testId: string;
}) {
  const s = t.admin.stats;
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      {hint ? <p className="mb-2 text-sm text-muted">{hint}</p> : null}
      {sorted.length ? (
        <div className="overflow-x-auto" data-testid={testId}>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface text-xs text-muted">
                <th className="px-3 py-2 text-start">{head}</th>
                <th className="px-3 py-2 text-center">{s.riders}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} className={cn('border-t border-border', selected && r.id === selected && 'bg-brand-ink/10')}>
                  <th scope="row" className="px-3 py-2 text-start font-semibold">
                    {onPick && r.id ? (
                      <button
                        type="button"
                        onClick={() => onPick(r.id)}
                        aria-pressed={r.id === selected}
                        className="min-h-touch w-full text-start underline-offset-4 hover:underline"
                      >
                        {r.name}
                      </button>
                    ) : (
                      r.name
                    )}
                  </th>
                  <td className="num px-3 py-2 text-center font-bold text-brand-ink">{r.count}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-brand-ink/30 bg-surface font-bold">
                <th scope="row" className="px-3 py-2 text-start">
                  {s.total}
                </th>
                <td className="num px-3 py-2 text-center">{sorted.reduce((n, r) => n + r.count, 0)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-muted">{empty}</p>
      )}
    </Card>
  );
}

/** Areas × time slots, with row and column totals. */
function Pivot({ title, rows, testId }: { title: string; rows: StatRow[]; testId: string }) {
  const s = t.admin.stats;
  const slots = [...new Set(rows.map((r) => r.slot))].sort();
  const areaKey = (r: StatRow) => r.area_id ?? '';
  const areas = [...new Map(rows.map((r) => [areaKey(r), r.area_name ?? s.noArea])).entries()];
  const cell = (area: string, slot: string) => rows.find((r) => areaKey(r) === area && r.slot === slot)?.students ?? 0;
  const areaTotal = (area: string) => rows.filter((r) => areaKey(r) === area).reduce((n, r) => n + r.students, 0);
  const slotTotal = (slot: string) => rows.filter((r) => r.slot === slot).reduce((n, r) => n + r.students, 0);
  areas.sort((a, b) => areaTotal(b[0]) - areaTotal(a[0]));
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <div className="overflow-x-auto" data-testid={testId}>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface text-xs text-muted">
              <th className="sticky start-0 bg-surface px-3 py-2 text-start">{s.area}</th>
              {slots.map((slot) => (
                <th key={slot} className="num px-3 py-2 text-center">
                  {formatClock(slot)}
                </th>
              ))}
              <th className="px-3 py-2 text-center">{s.total}</th>
            </tr>
          </thead>
          <tbody>
            {areas.map(([id, name]) => (
              <tr key={id} className="border-t border-border">
                <th scope="row" className="sticky start-0 bg-bg px-3 py-2 text-start font-semibold">
                  {name}
                </th>
                {slots.map((slot) => {
                  const n = cell(id, slot);
                  return (
                    <td key={slot} className={cn('num px-3 py-2 text-center', n ? 'font-bold text-brand-ink' : 'text-brand-silver')}>
                      {n || '·'}
                    </td>
                  );
                })}
                <td className="num px-3 py-2 text-center font-bold">{areaTotal(id)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-brand-ink/30 bg-surface font-bold">
              <th scope="row" className="sticky start-0 bg-surface px-3 py-2 text-start">
                {s.total}
              </th>
              {slots.map((slot) => (
                <td key={slot} className="num px-3 py-2 text-center">
                  {slotTotal(slot)}
                </td>
              ))}
              <td className="num px-3 py-2 text-center">{rows.reduce((n, r) => n + r.students, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}
