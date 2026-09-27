import { useQuery } from '@tanstack/react-query';
import { ChevronDown, MapPin } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { formatDate } from '@somar/shared';
import { Badge, Button, Card, Field, Select } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { WithUniversity } from './common';

type StatRow = { area_id: string | null; area_name: string | null; stop_id: string; stop_name: string; students: number };
type DayRow = { service_date: string; students: number };
type AreaGroup = { key: string; name: string; total: number; stops: StatRow[] };

function dayLabel(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return `${t.days[dow]} ${formatDate(date)}`;
}

export default function PickupsPage() {
  return <WithUniversity>{(universityId) => <PickupsBody universityId={universityId} />}</WithUniversity>;
}

function PickupsBody({ universityId }: { universityId: string }) {
  const s = t.admin.pickups;
  const dayId = useId();
  const win = useQuery({
    queryKey: ['pickup-window'],
    queryFn: async () => unwrap(await supabase.rpc('pickup_window')) as { service_date: string },
  });
  const days = useQuery({
    queryKey: ['pickup-days', universityId],
    queryFn: async () => unwrap(await supabase.rpc('pickup_days', { p_university_id: universityId })) as DayRow[],
  });
  const active = useQuery({
    queryKey: ['active-students', universityId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('students')
        .select('id', { count: 'exact', head: true })
        .eq('university_id', universityId)
        .eq('is_active', true);
      if (error) throw error;
      return count ?? 0;
    },
  });
  const [picked, setPicked] = useState<string | null>(null);
  const tomorrow = win.data?.service_date;
  const date = picked ?? tomorrow ?? null;

  const stats = useQuery({
    queryKey: ['pickup-stats', universityId, date],
    enabled: Boolean(date),
    queryFn: async () => unwrap(await supabase.rpc('pickup_stats', { p_university_id: universityId, p_date: date as string })) as StatRow[],
  });

  const options = useMemo(() => {
    const list = [...(days.data ?? [])];
    if (tomorrow && !list.some((d) => d.service_date === tomorrow)) list.unshift({ service_date: tomorrow, students: 0 });
    return list.sort((a, b) => b.service_date.localeCompare(a.service_date));
  }, [days.data, tomorrow]);

  return (
    <div className="space-y-4">
      <PageHeader title={s.title} subtitle={s.intro} />
      <Card className="flex flex-wrap items-end gap-3">
        <Field label={s.archive} htmlFor={dayId} className="min-w-[240px] flex-1">
          <Select id={dayId} value={date ?? ''} onChange={(e) => setPicked(e.target.value)} data-testid="pickup-day">
            {options.map((d) => (
              <option key={d.service_date} value={d.service_date}>
                {d.service_date === tomorrow ? `${s.tomorrow} — ` : ''}
                {dayLabel(d.service_date)} ({d.students})
              </option>
            ))}
          </Select>
        </Field>
        {tomorrow && date !== tomorrow ? (
          <Button variant="outline" onClick={() => setPicked(null)}>
            {s.tomorrow}
          </Button>
        ) : null}
      </Card>

      <QueryState query={stats}>
        {(rows) => {
          const chosen = rows.reduce((n, r) => n + r.students, 0);
          if (!rows.length) return <EmptyState title={s.empty} hint={s.emptyHint} />;
          const groups = new Map<string, AreaGroup>();
          for (const r of rows) {
            const key = r.area_id ?? '';
            const g = groups.get(key) ?? { key, name: r.area_name ?? s.noArea, total: 0, stops: [] };
            g.total += r.students;
            g.stops.push(r);
            groups.set(key, g);
          }
          const areas = [...groups.values()].sort((a, b) => b.total - a.total);
          return (
            <div className="space-y-4">
              <Card className="space-y-2">
                <p className="font-semibold" data-testid="pickup-summary">
                  {date ? `${dayLabel(date)} · ` : ''}
                  {s.chosen(chosen, active.data ?? 0)}
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface" aria-hidden>
                  <div className="h-full rounded-full bg-success" style={{ width: `${active.data ? (chosen / active.data) * 100 : 0}%` }} />
                </div>
              </Card>
              <ul className="grid gap-4 lg:grid-cols-2" data-testid="pickup-areas">
                {areas.map((g) => (
                  <li key={g.key}>
                    <Card>
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="flex items-center gap-2 text-lg font-extrabold">
                          <MapPin className="h-5 w-5 text-brand-ink" aria-hidden />
                          {g.name}
                        </p>
                        <Badge tone="info">
                          <span className="num">{g.total}</span> {s.students}
                        </Badge>
                      </div>
                      <ul className="divide-y divide-border">
                        {g.stops.map((stop) => (
                          <StopLine key={stop.stop_id} stop={stop} date={date as string} universityId={universityId} />
                        ))}
                      </ul>
                    </Card>
                  </li>
                ))}
              </ul>
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}

/** One stop with its count; the student list loads only when opened. */
function StopLine({ stop, date, universityId }: { stop: StatRow; date: string; universityId: string }) {
  const s = t.admin.pickups;
  const [open, setOpen] = useState(false);
  const people = useQuery({
    queryKey: ['pickup-people', universityId, date, stop.stop_id],
    enabled: open,
    queryFn: async () =>
      unwrap(
        await supabase
          .from('pickup_choices')
          .select('student_id, students(full_name, transport_number)')
          .eq('university_id', universityId)
          .eq('service_date', date)
          .eq('stop_id', stop.stop_id),
      ) as unknown as { student_id: string; students: { full_name: string; transport_number: string } | null }[],
  });
  return (
    <li className="py-2">
      <button
        type="button"
        className="flex min-h-touch w-full items-center justify-between gap-2 text-start"
        aria-expanded={open}
        aria-label={`${stop.stop_name} — ${open ? s.hideStudents : s.showStudents}`}
        onClick={() => setOpen((o) => !o)}
        data-testid="pickup-stop-row"
      >
        <span className="font-semibold">{stop.stop_name}</span>
        <span className="flex items-center gap-2">
          <span className="num text-lg font-extrabold text-brand-ink">{stop.students}</span>
          <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
      </button>
      {open ? (
        <QueryState query={people}>
          {(list) => (
            <ul className="mt-1 space-y-1 text-sm">
              {list.map((p) => (
                <li key={p.student_id} className="flex justify-between gap-2 rounded bg-surface px-2 py-1">
                  <span>{p.students?.full_name}</span>
                  <span className="num text-muted" dir="ltr">
                    {p.students?.transport_number}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      ) : null}
    </li>
  );
}
