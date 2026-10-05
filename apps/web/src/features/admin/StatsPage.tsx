import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatClock } from '@somar/shared';
import { useScope } from '@/app/auth';
import { Card, CardTitle } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { WithUniversity } from './common';

type StatRow = { dow: number; kind: 'outbound' | 'return'; slot: string; area_id: string | null; area_name: string | null; students: number };

export default function StatsPage() {
  return <WithUniversity>{(universityId) => <StatsBody universityId={universityId} />}</WithUniversity>;
}

function StatsBody({ universityId }: { universityId: string }) {
  const s = t.admin.stats;
  const { university } = useScope();
  const weekStart = university?.week_start_dow ?? 6;
  const order = Array.from({ length: 7 }, (_, i) => ((weekStart - 1 + i) % 7) + 1);

  const progress = useQuery({
    queryKey: ['setup-progress', universityId],
    queryFn: async () => unwrap(await supabase.rpc('setup_progress', { p_university_id: universityId })) as { total: number; completed: number },
  });
  const stats = useQuery({
    queryKey: ['schedule-stats', universityId],
    // the API returns at most 1000 rows per request and the rows are sorted by day, so a single request
    // used to cut off everything after the first days: page until the last (short) page
    queryFn: async () => {
      const all: StatRow[] = [];
      for (let from = 0; ; from += 1000) {
        const page = unwrap(
          await supabase.rpc('schedule_stats', { p_university_id: universityId }).range(from, from + 999),
        ) as StatRow[];
        all.push(...page);
        if (page.length < 1000) return all;
      }
    },
  });

  const perDay = useMemo(() => {
    const totals = new Map<number, number>();
    for (const r of stats.data ?? []) if (r.kind === 'outbound') totals.set(r.dow, (totals.get(r.dow) ?? 0) + r.students);
    return totals;
  }, [stats.data]);
  const [picked, setPicked] = useState<number | null>(null);
  const day = picked ?? order.find((d) => perDay.get(d)) ?? order[0] ?? 6;

  return (
    <div className="space-y-4">
      <PageHeader title={s.title} subtitle={s.intro} />
      {progress.data ? (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-semibold">{s.progress(progress.data.completed, progress.data.total)}</p>
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
            onClick={() => setPicked(d)}
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
    </div>
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
