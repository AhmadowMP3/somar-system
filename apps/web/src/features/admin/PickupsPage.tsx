import { useQuery } from '@tanstack/react-query';
import { Bus, ChevronDown, FileSpreadsheet, MapPin, Search } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { foldArabic, formatClock, formatDate, OUTBOUND_SLOTS, RETURN_SLOTS } from '@somar/shared';
import { Badge, Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { exportSheet } from '@/lib/exportSheet';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { WithUniversity } from './common';

type DayRow = { service_date: string; students: number };
type PassengerType = 'student' | 'supervisor' | 'doctor' | 'employee' | 'patient';
type Direction = 'outbound' | 'return';

/** One leg of one booked seat (pickup_passengers): who, when, where, and the line that carries it. */
type Leg = {
  seat_id: string;
  passenger_type: PassengerType;
  full_name: string;
  phone: string | null;
  transport_number: string | null;
  booked_by_name: string | null;
  booked_by_transport: string | null;
  direction: Direction;
  slot: string | null;
  stop_id: string | null;
  stop_name: string | null;
  area_id: string | null;
  area_name: string | null;
  route_id: string | null;
  route_name: string | null;
  route_departure: string | null;
  stop_seq: number | null;
  stop_time: string | null;
};

/** A seat with both legs, for the full list. */
type Seat = { id: string; outbound: Leg | null; return: Leg | null; base: Leg };
type StopGroup = { key: string; name: string; area: string | null; time: string | null; seq: number; legs: Leg[] };
type LineGroup = { key: string; name: string; departure: string | null; legs: Leg[]; stops: StopGroup[] };

const TYPE_TONE: Record<PassengerType, 'info' | 'success' | 'warning' | 'neutral' | 'danger'> = {
  student: 'neutral',
  supervisor: 'info',
  doctor: 'success',
  employee: 'success',
  patient: 'warning',
};

function dayLabel(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return `${t.days[dow]} ${formatDate(date)}`;
}

const clockOr = (time: string | null) => formatClock(time) || t.pickup.unknown;
const hhmm = (time: string | null) => (time ? time.slice(0, 5) : null);

/** «الرحلة الأولى — ذهاب 8:00 ص»: each booked time is one trip (8 → first, 10 → second, 12 → third). */
function tripTitle(direction: Direction, slot: string | null): string {
  const s = t.admin.pickups;
  if (!slot) return s.noTime;
  const slots: readonly string[] = direction === 'outbound' ? OUTBOUND_SLOTS : RETURN_SLOTS;
  const ordinal = s.tripOrdinals[slots.indexOf(hhmm(slot) ?? '')];
  return direction === 'outbound' ? s.outboundTrip(ordinal, formatClock(slot)) : s.returnTrip(ordinal, formatClock(slot));
}
const typeLabel = (leg: Leg) => t.admin.pickups.types[leg.passenger_type] ?? leg.passenger_type;

const PAGE = 1000;

/** Every booked leg of the day (paged past the API's row cap). */
async function fetchLegs(universityId: string, date: string): Promise<Leg[]> {
  const all: Leg[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(
      await supabase.rpc('pickup_passengers', { p_university_id: universityId, p_date: date }).range(from, from + PAGE - 1),
    ) as Leg[];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return all;
}

/** Lines in departure order, each with its stops in riding order; legs no line serves go last. */
function groupByLine(legs: Leg[]): LineGroup[] {
  const lines = new Map<string, LineGroup>();
  for (const leg of legs) {
    const key = leg.route_id ?? '';
    const line = lines.get(key) ?? {
      key,
      name: leg.route_name ?? t.admin.pickups.noLine,
      departure: leg.route_departure,
      legs: [],
      stops: [],
    };
    line.legs.push(leg);
    lines.set(key, line);
  }
  for (const line of lines.values()) {
    const stops = new Map<string, StopGroup>();
    for (const leg of line.legs) {
      const key = leg.stop_id ?? `deleted:${leg.stop_name}`;
      const stop = stops.get(key) ?? {
        key,
        name: leg.stop_name ?? t.pickup.unknown,
        area: leg.area_name,
        time: leg.stop_time,
        seq: leg.stop_seq ?? Number.MAX_SAFE_INTEGER,
        legs: [],
      };
      stop.legs.push(leg);
      stops.set(key, stop);
    }
    line.stops = [...stops.values()].sort((a, b) => a.seq - b.seq || b.legs.length - a.legs.length || a.name.localeCompare(b.name, 'ar'));
  }
  return [...lines.values()].sort(
    (a, b) =>
      Number(a.key === '') - Number(b.key === '') ||
      (a.departure ?? '99').localeCompare(b.departure ?? '99') ||
      a.name.localeCompare(b.name, 'ar'),
  );
}

function toSeats(legs: Leg[]): Seat[] {
  const seats = new Map<string, Seat>();
  for (const leg of legs) {
    const seat = seats.get(leg.seat_id) ?? { id: leg.seat_id, outbound: null, return: null, base: leg };
    seat[leg.direction] = leg;
    seats.set(leg.seat_id, seat);
  }
  return [...seats.values()].sort(
    (a, b) =>
      (a.outbound?.slot ?? '99').localeCompare(b.outbound?.slot ?? '99') ||
      Number(a.base.passenger_type === 'patient') - Number(b.base.passenger_type === 'patient') ||
      a.base.full_name.localeCompare(b.base.full_name, 'ar'),
  );
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

  const legs = useQuery({
    queryKey: ['pickup-passengers', universityId, date],
    enabled: Boolean(date),
    queryFn: () => fetchLegs(universityId, date as string),
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

      <QueryState query={legs}>
        {(rows) => {
          if (!rows.length || !date) return <EmptyState title={s.empty} hint={s.emptyHint} />;
          const seats = toSeats(rows);
          const riders = seats.filter((x) => x.base.passenger_type !== 'patient').length;
          const patients = seats.length - riders;
          return (
            <div className="space-y-4">
              <Card className="space-y-2">
                <p className="font-semibold" data-testid="pickup-summary">
                  {dayLabel(date)} · {s.chosen(riders, active.data ?? 0)}
                  {patients ? ` ${s.patientsCount(patients)}` : ''}
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface" aria-hidden>
                  <div className="h-full rounded-full bg-success" style={{ width: `${active.data ? Math.min(100, (riders / active.data) * 100) : 0}%` }} />
                </div>
              </Card>
              <div>
                <h2 className="text-lg font-extrabold text-brand-ink">{s.byLines}</h2>
                <p className="text-sm text-muted">{s.linesHint}</p>
              </div>
              {/* outbound only: return seats are no longer booked (migration 0036) */}
              {(['outbound'] as const).map((direction) => {
                const legs = rows.filter((r) => r.direction === direction);
                // one section per trip (booked time), old bookings without a time last
                const slots = [...new Set(legs.map((r) => r.slot))].sort((a, b) => (a ?? '99').localeCompare(b ?? '99'));
                return (
                  <section key={direction} className="space-y-4" data-testid={`pickup-lines-${direction}`}>
                    <h3 className="text-base font-extrabold">{direction === 'outbound' ? s.outboundLines : s.returnLines}</h3>
                    {slots.length ? (
                      slots.map((slot) => {
                        const tripLegs = legs.filter((r) => r.slot === slot);
                        return (
                          <div key={slot ?? 'none'} className="space-y-3 rounded-2xl border border-border bg-surface/60 p-3" data-testid="pickup-trip">
                            <p className="flex flex-wrap items-center justify-between gap-2 font-extrabold text-brand-ink">
                              <span className="num">{tripTitle(direction, slot)}</span>
                              <Badge tone="info">
                                <span className="num">{s.seats(tripLegs.length)}</span>
                              </Badge>
                            </p>
                            <ul className="grid gap-4 lg:grid-cols-2">
                              {groupByLine(tripLegs).map((line) => (
                                <li key={line.key}>
                                  <LineCard line={line} />
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })
                    ) : (
                      <p className="text-sm text-muted">{s.noSeats}</p>
                    )}
                  </section>
                );
              })}
              <h2 className="pt-2 text-lg font-extrabold text-brand-ink">{s.list}</h2>
              <BookingsList seats={seats} date={date} />
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}

function LineCard({ line }: { line: LineGroup }) {
  const s = t.admin.pickups;
  const offLine = line.key === '';
  return (
    <Card className={cn(offLine && 'border-warning/60')} data-testid="pickup-line">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-lg font-extrabold">
            <Bus className={cn('h-5 w-5 shrink-0', offLine ? 'text-warning' : 'text-brand-ink')} aria-hidden />
            {line.name}
          </p>
          {offLine ? <p className="text-xs text-muted">{s.noLineHint}</p> : null}
          {line.departure ? <p className="num text-xs text-muted">{s.departs(formatClock(line.departure))}</p> : null}
        </div>
        <Badge tone="info">
          <span className="num">{s.seats(line.legs.length)}</span>
        </Badge>
      </div>
      <ol className="divide-y divide-border">
        {line.stops.map((stop, i) => (
          <StopRow key={stop.key} stop={stop} index={offLine ? null : i + 1} />
        ))}
      </ol>
    </Card>
  );
}

/** A stop on the line with its count; the passengers show when opened. */
function StopRow({ stop, index }: { stop: StopGroup; index: number | null }) {
  const s = t.admin.pickups;
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <button
        type="button"
        className="flex min-h-touch w-full items-center justify-between gap-2 text-start"
        aria-expanded={open}
        aria-label={`${stop.name} — ${open ? s.hidePeople : s.showPeople}`}
        onClick={() => setOpen((o) => !o)}
        data-testid="pickup-stop-row"
      >
        <span className="flex min-w-0 items-center gap-2">
          {index ? (
            <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-ink text-xs font-bold text-on-ink">
              {index}
            </span>
          ) : (
            <MapPin className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          )}
          <span className="min-w-0">
            <span className="block font-semibold">{stop.name}</span>
            {stop.time || (stop.area && stop.area !== stop.name) ? (
              <span className="num block text-xs text-muted">
                {[stop.time ? formatClock(stop.time) : null, stop.area && stop.area !== stop.name ? stop.area : null].filter(Boolean).join(' · ')}
              </span>
            ) : null}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="num text-lg font-extrabold text-brand-ink">{stop.legs.length}</span>
          <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
        </span>
      </button>
      {open ? (
        <ul className="mt-1 space-y-1 text-sm" data-testid="pickup-stop-people">
          {[...stop.legs]
            .sort((a, b) => (a.slot ?? '').localeCompare(b.slot ?? '') || a.full_name.localeCompare(b.full_name, 'ar'))
            .map((leg) => (
              <li key={`${leg.seat_id}-${leg.direction}`} className="flex flex-wrap items-center justify-between gap-2 rounded bg-surface px-2 py-1.5">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge tone={TYPE_TONE[leg.passenger_type]}>{typeLabel(leg)}</Badge>
                  <span className="font-semibold">{leg.full_name}</span>
                  {leg.passenger_type === 'patient' && leg.booked_by_name ? (
                    <span className="text-xs text-muted">{s.withStudent(leg.booked_by_name)}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  <span className="num">{s.booked(clockOr(leg.slot))}</span>
                  <span className="num font-mono" dir="ltr">
                    {leg.transport_number ?? leg.phone}
                  </span>
                </span>
              </li>
            ))}
        </ul>
      ) : null}
    </li>
  );
}

function BookingsList({ seats, date }: { seats: Seat[]; date: string }) {
  const s = t.admin.pickups;
  const c = s.columns;
  const searchId = useId();
  const [search, setSearch] = useState('');
  const lineOf = (leg: Leg | null) => leg?.route_name ?? (leg ? s.noLine : t.pickup.unknown);
  const who = (x: Seat) => (x.base.passenger_type === 'patient' ? x.base.booked_by_name ?? '' : '');

  const exportRows = (rows: Seat[]) =>
    exportSheet(
      `${s.sheet}-${date}`,
      rows.map((x) => ({
        [c.name]: x.base.full_name,
        [c.type]: typeLabel(x.base),
        [c.bookedBy]: who(x),
        [c.transport]: x.base.transport_number ?? '',
        [c.phone]: x.base.phone ?? '',
        [c.outboundTime]: clockOr(x.outbound?.slot ?? null),
        [c.outboundStop]: x.outbound?.stop_name ?? '',
        [c.outboundLine]: lineOf(x.outbound),
      })),
    );

  const q = foldArabic(search);
  const rows = q
    ? seats.filter((x) =>
        foldArabic(`${x.base.full_name} ${x.base.transport_number ?? ''} ${x.base.booked_by_name ?? ''} ${x.base.booked_by_transport ?? ''}`).includes(q),
      )
    : seats;
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
          rowKey={(x) => x.id}
          cardTitle={(x) => x.base.full_name}
          columns={[
            { key: 'name', header: c.name, cell: (x) => x.base.full_name, mobileHidden: true },
            {
              key: 'type',
              header: c.type,
              cell: (x) => (
                <span className="flex flex-wrap items-center gap-1">
                  <Badge tone={TYPE_TONE[x.base.passenger_type]}>{typeLabel(x.base)}</Badge>
                  {who(x) ? <span className="text-xs text-muted">{s.withStudent(who(x))}</span> : null}
                </span>
              ),
            },
            {
              key: 'transport',
              header: c.transport,
              cell: (x) => (
                <span className="num font-mono" dir="ltr">
                  {x.base.transport_number ?? x.base.phone}
                </span>
              ),
            },
            {
              key: 'outbound',
              header: c.outboundTime,
              cell: (x) => (
                <span>
                  <span className="num">{clockOr(x.outbound?.slot ?? null)}</span> — {x.outbound?.stop_name ?? t.pickup.unknown}
                  <span className="block text-xs text-muted">{lineOf(x.outbound)}</span>
                </span>
              ),
            },
          ]}
        />
      ) : (
        <p className="text-sm text-muted">{s.noMatch}</p>
      )}
    </div>
  );
}
