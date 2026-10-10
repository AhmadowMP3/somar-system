import { useQuery } from '@tanstack/react-query';
import { ChevronDown, FileSpreadsheet, MapPin, Search } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { foldArabic, formatClock, formatDate } from '@somar/shared';
import { Badge, Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { exportSheet } from '@/lib/exportSheet';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { WithUniversity } from './common';

/** stop_id is null for a stop deleted since: it is then identified by the name saved with the booking. */
type StatRow = { area_id: string | null; area_name: string | null; stop_id: string | null; stop_name: string; students: number };
/** outbound_time is null on bookings made before the outbound time was asked. */
type OutboundRow = StatRow & { outbound_time: string | null };
type ReturnRow = StatRow & { return_time: string };
type DayRow = { service_date: string; students: number };
type AreaGroup = { key: string; name: string; total: number; stops: StatRow[] };
/** Which students a stop line lists: boarding there at an outbound time, or dropped there at a return time. */
type StopFilter = { kind: 'outbound'; time: string | null } | { kind: 'return'; time: string };
type BookingRow = {
  student_id: string;
  outbound_time: string | null;
  return_time: string | null;
  stop_name: string | null;
  return_stop_name: string | null;
  students: { full_name: string; transport_number: string } | null;
  stops: { name: string } | null;
  return_stop: { name: string } | null;
};

function dayLabel(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return `${t.days[dow]} ${formatDate(date)}`;
}

const clockOr = (time: string | null) => formatClock(time) || t.pickup.unknown;

function groupByArea(rows: StatRow[]): AreaGroup[] {
  const groups = new Map<string, AreaGroup>();
  for (const r of rows) {
    const key = r.area_id ?? '';
    const g = groups.get(key) ?? { key, name: r.area_name ?? t.admin.pickups.noArea, total: 0, stops: [] };
    g.total += r.students;
    g.stops.push(r);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total);
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
    queryKey: ['pickup-outbound-stats', universityId, date],
    enabled: Boolean(date),
    queryFn: async () =>
      unwrap(await supabase.rpc('pickup_outbound_stats', { p_university_id: universityId, p_date: date as string })) as OutboundRow[],
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
          if (!rows.length || !date) return <EmptyState title={s.empty} hint={s.emptyHint} />;
          return (
            <div className="space-y-4">
              <Card className="space-y-2">
                <p className="font-semibold" data-testid="pickup-summary">
                  {dayLabel(date)} · {s.chosen(chosen, active.data ?? 0)}
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface" aria-hidden>
                  <div className="h-full rounded-full bg-success" style={{ width: `${active.data ? (chosen / active.data) * 100 : 0}%` }} />
                </div>
              </Card>
              <h2 className="text-lg font-extrabold text-brand-ink">{s.outbound}</h2>
              <OutboundSection rows={rows} date={date} universityId={universityId} />
              <h2 className="pt-2 text-lg font-extrabold text-brand-ink">{s.return}</h2>
              <ReturnSection date={date} universityId={universityId} />
              <h2 className="pt-2 text-lg font-extrabold text-brand-ink">{s.list}</h2>
              <BookingsList date={date} universityId={universityId} />
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}

function AreaCards({
  areas,
  date,
  universityId,
  filter,
  testId,
}: {
  areas: AreaGroup[];
  date: string;
  universityId: string;
  filter: StopFilter;
  testId: string;
}) {
  const s = t.admin.pickups;
  return (
    <ul className="grid gap-4 lg:grid-cols-2" data-testid={testId}>
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
                <StopLine key={stop.stop_id ?? `deleted:${stop.stop_name}`} stop={stop} date={date} universityId={universityId} filter={filter} />
              ))}
            </ul>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/** A time heading with its total, then the areas and stops of that time. */
function TimeBlock({ title, rows, children }: { title: string; rows: StatRow[]; children: ReactNode }) {
  const total = rows.reduce((n, r) => n + r.students, 0);
  return (
    <section className="space-y-2">
      <p className="flex items-center gap-2 font-extrabold">
        <span className="num">{title}</span>
        <Badge tone="info">
          <span className="num">{total}</span> {t.admin.pickups.students}
        </Badge>
      </p>
      {children}
    </section>
  );
}

/** Outbound bookings: one block per outbound time (old bookings without one last), then areas and stops. */
function OutboundSection({ rows, date, universityId }: { rows: OutboundRow[]; date: string; universityId: string }) {
  const s = t.admin.pickups;
  const times = [...new Set(rows.map((r) => r.outbound_time))].sort((a, b) => (a ?? '99').localeCompare(b ?? '99'));
  return (
    <div className="space-y-4" data-testid="pickup-areas">
      {times.map((time) => {
        const slot = rows.filter((r) => r.outbound_time === time);
        return (
          <TimeBlock key={time ?? 'none'} title={time ? s.outboundAt(formatClock(time)) : s.noTime} rows={slot}>
            <AreaCards
              areas={groupByArea(slot)}
              date={date}
              universityId={universityId}
              filter={{ kind: 'outbound', time }}
              testId="pickup-outbound-areas"
            />
          </TimeBlock>
        );
      })}
    </div>
  );
}

/** Return bookings: one block per return time, then areas and drop-off stops inside it. */
function ReturnSection({ date, universityId }: { date: string; universityId: string }) {
  const s = t.admin.pickups;
  const stats = useQuery({
    queryKey: ['pickup-return-stats', universityId, date],
    queryFn: async () => unwrap(await supabase.rpc('pickup_return_stats', { p_university_id: universityId, p_date: date })) as ReturnRow[],
  });
  return (
    <QueryState query={stats}>
      {(rows) => {
        if (!rows.length) return <p className="text-sm text-muted">{s.noReturns}</p>;
        const times = [...new Set(rows.map((r) => r.return_time))].sort();
        return (
          <div className="space-y-4" data-testid="pickup-returns">
            {times.map((time) => {
              const slot = rows.filter((r) => r.return_time === time);
              return (
                <TimeBlock key={time} title={s.returnAt(formatClock(time))} rows={slot}>
                  <AreaCards
                    areas={groupByArea(slot)}
                    date={date}
                    universityId={universityId}
                    filter={{ kind: 'return', time }}
                    testId="pickup-return-areas"
                  />
                </TimeBlock>
              );
            })}
          </div>
        );
      }}
    </QueryState>
  );
}

/** One stop with its count; the student list loads only when opened. */
function StopLine({ stop, date, universityId, filter }: { stop: StatRow; date: string; universityId: string; filter: StopFilter }) {
  const s = t.admin.pickups;
  const [open, setOpen] = useState(false);
  const people = useQuery({
    queryKey: ['pickup-people', universityId, date, stop.stop_id, stop.stop_name, filter],
    enabled: open,
    queryFn: async () => {
      let q = supabase
        .from('pickup_choices')
        .select('student_id, students(full_name, transport_number)')
        .eq('university_id', universityId)
        .eq('service_date', date);
      const [idCol, nameCol, timeCol] =
        filter.kind === 'outbound' ? ['stop_id', 'stop_name', 'outbound_time'] : ['return_stop_id', 'return_stop_name', 'return_time'];
      q = stop.stop_id ? q.eq(idCol, stop.stop_id) : q.is(idCol, null).eq(nameCol, stop.stop_name);
      q = filter.time ? q.eq(timeCol, filter.time) : q.is(timeCol, null);
      return unwrap(await q) as unknown as { student_id: string; students: { full_name: string; transport_number: string } | null }[];
    },
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

const PAGE = 1000;

/** Every booking of the day (paged past the API's row cap), earliest outbound first. */
async function fetchBookings(universityId: string, date: string): Promise<BookingRow[]> {
  const all: BookingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(
      await supabase
        .from('pickup_choices')
        .select(
          'student_id, outbound_time, return_time, stop_name, return_stop_name, students(full_name, transport_number), stops!pickup_choices_stop_id_fkey(name), return_stop:stops!pickup_choices_return_stop_id_fkey(name)',
        )
        .eq('university_id', universityId)
        .eq('service_date', date)
        .order('student_id')
        .range(from, from + PAGE - 1),
    ) as unknown as BookingRow[];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all.sort(
    (a, b) =>
      (a.outbound_time ?? '99').localeCompare(b.outbound_time ?? '99') ||
      (a.students?.full_name ?? '').localeCompare(b.students?.full_name ?? '', 'ar'),
  );
}

function BookingsList({ date, universityId }: { date: string; universityId: string }) {
  const s = t.admin.pickups;
  const c = s.columns;
  const searchId = useId();
  const [search, setSearch] = useState('');
  const bookings = useQuery({
    queryKey: ['pickup-bookings', universityId, date],
    queryFn: () => fetchBookings(universityId, date),
  });
  const stopOf = (r: BookingRow) => r.stops?.name ?? r.stop_name ?? t.pickup.unknown;
  const returnStopOf = (r: BookingRow) => r.return_stop?.name ?? r.return_stop_name ?? t.pickup.unknown;

  const exportRows = (rows: BookingRow[]) =>
    exportSheet(
      `${s.sheet}-${date}`,
      rows.map((r) => ({
        [c.name]: r.students?.full_name ?? '',
        [c.transport]: r.students?.transport_number ?? '',
        [c.outboundTime]: clockOr(r.outbound_time),
        [c.outboundStop]: stopOf(r),
        [c.returnTime]: clockOr(r.return_time),
        [c.returnStop]: returnStopOf(r),
      })),
    );

  return (
    <QueryState query={bookings}>
      {(all) => {
        const q = foldArabic(search);
        const rows = q
          ? all.filter((r) => foldArabic(`${r.students?.full_name ?? ''} ${r.students?.transport_number ?? ''}`).includes(q))
          : all;
        return (
          <div className="space-y-3" data-testid="pickup-bookings">
            <div className="flex flex-wrap items-end gap-3">
              <Field label={s.search} htmlFor={searchId} className="min-w-[220px] flex-1">
                <div className="relative">
                  <Input id={searchId} placeholder={s.search} value={search} onChange={(e) => setSearch(e.target.value)} className="ps-9" data-testid="pickup-bookings-search" />
                  <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
                </div>
              </Field>
              <Button variant="outline" onClick={() => exportRows(rows)} disabled={!rows.length} data-testid="pickup-bookings-export">
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                {s.export}
              </Button>
            </div>
            {rows.length ? (
              <DataList
                rows={rows}
                rowKey={(r) => r.student_id}
                cardTitle={(r) => r.students?.full_name}
                columns={[
                  { key: 'name', header: c.name, cell: (r) => r.students?.full_name, mobileHidden: true },
                  {
                    key: 'transport',
                    header: c.transport,
                    cell: (r) => (
                      <span className="num font-mono" dir="ltr">
                        {r.students?.transport_number}
                      </span>
                    ),
                  },
                  { key: 'outboundTime', header: c.outboundTime, cell: (r) => <span className="num">{clockOr(r.outbound_time)}</span> },
                  { key: 'outboundStop', header: c.outboundStop, cell: stopOf },
                  { key: 'returnTime', header: c.returnTime, cell: (r) => <span className="num">{clockOr(r.return_time)}</span> },
                  { key: 'returnStop', header: c.returnStop, cell: returnStopOf },
                ]}
              />
            ) : (
              <p className="text-sm text-muted">{s.noMatch}</p>
            )}
          </div>
        );
      }}
    </QueryState>
  );
}
