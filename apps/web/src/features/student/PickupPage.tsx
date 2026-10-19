import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, ChevronLeft, Clock, Lock, MapPinned, Pencil, Search, UserRound } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { foldArabic, formatClock, formatDate, OUTBOUND_SLOTS } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { ConfirmDialog, useToast } from '@/components/ui/overlay';
import { Button, Card, CardTitle, Field, Input, Select } from '@/components/ui/primitives';
import { ListSkeleton, PageHeader } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type PickupWindow = {
  open: boolean;
  phase: 'before' | 'open' | 'after';
  opens_at: string;
  closes_at: string;
  today: string;
  service_date: string;
};
/** One bookable stop: a stop on a line of a trip (pickup_options), with the bus's time there. */
type Option = {
  slot: string;
  route_id: string;
  route_name: string;
  route_departure: string | null;
  stop_id: string;
  stop_name: string;
  stop_seq: number;
  stop_time: string;
};
type Choice = {
  service_date: string;
  outbound_time: string | null;
  stop_id: string | null;
  outbound_route_id: string | null;
  /** Names and time saved with the booking: the stop or line may have changed since. */
  stop_name: string | null;
  outbound_route_name: string | null;
  outbound_stop_time: string | null;
  stops: { name: string } | null;
};
/** What a summary shows: a saved seat, or the one about to be confirmed. */
type Booking = { outbound_time: string | null; stop: string | null; line: string | null; stop_time: string | null };
/** A patient's seat as the student fills it in (dentistry students bring patients). */
type PatientDraft = { full_name: string; phone: string; outbound_time: string; option: string };
type SavedPatient = Booking & { seq: number; full_name: string; phone: string; option?: string };
type PatientRow = {
  seq: number;
  stop_id: string | null;
  outbound_route_id: string | null;
  full_name: string;
  phone: string;
  outbound_time: string;
  stop_name: string | null;
  outbound_route_name: string | null;
  outbound_stop_time: string | null;
  stops: { name: string } | null;
};

const MAX_PATIENTS = 5;
const emptyPatient = (): PatientDraft => ({ full_name: '', phone: '', outbound_time: '', option: '' });
const patientComplete = (x: PatientDraft) =>
  x.full_name.trim().length >= 2 && /^\+?[0-9]{7,15}$/.test(x.phone.replace(/[\s\-().]/g, '')) && Boolean(x.outbound_time && x.option);

/** An option is picked by line and stop together: the same stop can be on two lines of one trip. */
const optionKey = (o: Pick<Option, 'route_id' | 'stop_id'>) => `${o.route_id}|${o.stop_id}`;
const splitKey = (key: string) => {
  const [route_id = '', stop_id = ''] = key.split('|');
  return { route_id, stop_id };
};

const toBooking = (c: Choice): Booking => ({
  outbound_time: c.outbound_time,
  stop: c.stops?.name ?? c.stop_name,
  line: c.outbound_route_name,
  stop_time: c.outbound_stop_time,
});
const optionBooking = (slot: string, o: Option | undefined): Booking => ({
  outbound_time: slot || null,
  stop: o?.stop_name ?? null,
  line: o?.route_name ?? null,
  stop_time: o?.stop_time ?? null,
});

const hhmm = (time: string | null | undefined) => (time ? time.slice(0, 5) : '');

/** Weekday name + date, e.g. «الثلاثاء 06/10/2026». */
function dayLabel(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return `${t.days[dow]} ${formatDate(date)}`;
}

/** The server clock and the settings decide when the booking is open; re-checked every minute. */
function usePickupWindow() {
  return useQuery({
    queryKey: ['pickup-window'],
    queryFn: async () => unwrap(await supabase.rpc('pickup_window')) as PickupWindow,
    refetchInterval: 60_000,
  });
}

function useMyChoices(win: PickupWindow | undefined) {
  return useQuery({
    queryKey: ['my-pickups', win?.today],
    enabled: Boolean(win),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('pickup_choices')
          .select(
            'service_date, outbound_time, stop_id, outbound_route_id, stop_name, outbound_route_name, outbound_stop_time, stops!pickup_choices_stop_id_fkey(name)',
          )
          .in('service_date', [win?.today as string, win?.service_date as string]),
      ) as unknown as Choice[],
  });
}

/** Tomorrow's lines and stops for each outbound time. */
function usePickupOptions(enabled: boolean) {
  return useQuery({
    queryKey: ['pickup-options'],
    enabled,
    queryFn: async () => (unwrap(await supabase.rpc('pickup_options')) as Option[]).map((o) => ({ ...o, slot: hhmm(o.slot) })),
  });
}

/** Suggested booking: the student's weekly outbound time for that weekday and their nearest stop. */
function useBookingDefaults(studentId: string | undefined, serviceDate: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['pickup-defaults', studentId, serviceDate],
    enabled: enabled && Boolean(studentId && serviceDate),
    queryFn: async () => {
      const dow = new Date(`${serviceDate}T00:00:00Z`).getUTCDay() || 7;
      const [student, schedule] = await Promise.all([
        supabase.from('students').select('home_stop_id').eq('id', studentId as string).maybeSingle(),
        supabase.from('student_schedule').select('outbound_time').eq('student_id', studentId as string).eq('dow', dow).maybeSingle(),
      ]);
      const home = unwrap(student) as { home_stop_id: string | null } | null;
      const day = unwrap(schedule) as { outbound_time: string } | null;
      return { stopId: home?.home_stop_id ?? '', outbound: hhmm(day?.outbound_time) };
    },
  });
}

/** Students of a college the staff flagged (dentistry) may also book seats for their patients. */
function usePatientsAllowed(studentId: string | undefined) {
  return useQuery({
    queryKey: ['my-college-patients', studentId],
    enabled: Boolean(studentId),
    queryFn: async () => {
      const row = unwrap(
        await supabase.from('students').select('colleges(allows_patients)').eq('id', studentId as string).maybeSingle(),
      ) as unknown as { colleges: { allows_patients: boolean } | null } | null;
      return Boolean(row?.colleges?.allows_patients);
    },
  });
}

function useMyPatients(serviceDate: string | undefined) {
  return useQuery({
    queryKey: ['my-patients', serviceDate],
    enabled: Boolean(serviceDate),
    queryFn: async () =>
      (
        unwrap(
          await supabase
            .from('pickup_patients')
            .select(
              'seq, full_name, phone, outbound_time, stop_id, outbound_route_id, stop_name, outbound_route_name, outbound_stop_time, stops!pickup_patients_stop_id_fkey(name)',
            )
            .eq('service_date', serviceDate as string)
            .order('seq'),
        ) as unknown as PatientRow[]
      ).map(
        (r): SavedPatient => ({
          seq: r.seq,
          full_name: r.full_name,
          phone: r.phone,
          outbound_time: r.outbound_time,
          stop: r.stops?.name ?? r.stop_name,
          line: r.outbound_route_name,
          stop_time: r.outbound_stop_time,
          option: r.outbound_route_id && r.stop_id ? optionKey({ route_id: r.outbound_route_id, stop_id: r.stop_id }) : '',
        }),
      ),
  });
}

/** Home-screen entry: tells the student whether tomorrow's booking is open, and what they booked. */
export function PickupHomeCard() {
  const win = usePickupWindow();
  const choices = useMyChoices(win.data);
  if (!win.data) return null;
  const tomorrow = choices.data?.find((c) => c.service_date === win.data.service_date);
  const booked = tomorrow ? toBooking(tomorrow) : null;
  const waiting = win.data.open && !tomorrow;
  return (
    <Link
      to="/pickup"
      className={cn(
        'flex min-h-touch items-center justify-between gap-3 rounded-xl border p-4',
        waiting ? 'border-brand bg-brand/10' : 'border-border bg-bg',
      )}
      data-testid="pickup-home"
    >
      <span className="flex items-center gap-3">
        <MapPinned className={cn('h-6 w-6 shrink-0', waiting ? 'text-brand' : 'text-brand-ink')} aria-hidden />
        <span>
          <span className="block font-bold">{t.nav.myPickup}</span>
          <span className="block text-sm text-muted">
            {booked
              ? t.pickup.homeChosen(formatClock(booked.outbound_time) || t.pickup.unknown, booked.stop ?? t.pickup.unknown)
              : win.data.open
                ? t.pickup.homeOpen
                : t.pickup.opensAt(formatClock(win.data.opens_at), formatClock(win.data.closes_at))}
          </span>
        </span>
      </span>
      <ChevronLeft className="h-5 w-5 shrink-0 text-muted" aria-hidden />
    </Link>
  );
}

/** «الباص يصل إلى دوار الكرة الساعة 7:40 ص (الخط 4)» — the reason the line's stop times are asked for. */
function ArrivalNote({ booking, testId }: { booking: Booking; testId?: string }) {
  if (!booking.stop || !booking.stop_time) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg bg-brand/10 p-3 text-sm font-semibold" data-testid={testId}>
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-brand-ink" aria-hidden />
      <span className="num">{t.pickup.arrivalNote(booking.stop, formatClock(booking.stop_time), booking.line ?? '')}</span>
    </p>
  );
}

function ChoiceSummary({ booking, testId }: { booking: Booking; testId?: string }) {
  const p = t.pickup;
  return (
    <div className="space-y-2" data-testid={testId}>
      <dl className="grid gap-2 text-sm">
        <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-surface p-3">
          <dt className="text-muted">{p.outbound}</dt>
          <dd className="num font-bold" data-testid="pickup-current">
            {p.at(formatClock(booking.outbound_time) || p.unknown, booking.stop ?? p.unknown)}
          </dd>
        </div>
        {booking.line ? (
          <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-surface p-3">
            <dt className="text-muted">{p.line}</dt>
            <dd className="font-bold" data-testid="pickup-current-line">
              {booking.line}
            </dd>
          </div>
        ) : null}
      </dl>
      <ArrivalNote booking={booking} />
    </div>
  );
}

function PatientsSummary({ patients, testId }: { patients: SavedPatient[]; testId?: string }) {
  const p = t.pickup;
  if (!patients.length) return null;
  return (
    <div className="space-y-2" data-testid={testId}>
      <p className="text-sm font-bold">
        {p.patientsSummary} (<span className="num">{patients.length}</span>)
      </p>
      {patients.map((x) => (
        <div key={x.seq} className="space-y-2 rounded-lg border border-border p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
            <UserRound className="h-4 w-4 text-brand-ink" aria-hidden />
            {p.patientTitle(x.seq)}: {x.full_name}
            <span className="num font-normal text-muted" dir="ltr">
              {x.phone}
            </span>
          </p>
          <ChoiceSummary booking={x} />
        </div>
      ))}
    </div>
  );
}

/** One row of slot radio buttons. */
function SlotPicker({ value, onChange, label, testId }: { value: string; onChange: (slot: string) => void; label: string; testId: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-3" data-testid={testId}>
      {OUTBOUND_SLOTS.map((slot) => (
        <button
          key={slot}
          type="button"
          role="radio"
          aria-checked={value === slot}
          onClick={() => onChange(slot)}
          className={cn(
            'num min-h-touch rounded-lg border px-4 text-base font-bold',
            value === slot ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
          )}
        >
          {formatClock(slot)}
        </button>
      ))}
    </div>
  );
}

/**
 * The stops of the chosen trip, grouped by line in riding order with the bus's time at each stop; the
 * student picks the line and the stop together. Searchable by stop or line name.
 */
function LinePicker({
  options,
  value,
  onChange,
  label,
  testId,
}: {
  options: Option[];
  value: string;
  onChange: (key: string) => void;
  label: string;
  testId: string;
}) {
  const p = t.pickup;
  const searchId = useId();
  const [term, setTerm] = useState('');
  const needle = foldArabic(term.trim());
  const lines = useMemo(() => {
    const byLine = new Map<string, { id: string; name: string; departure: string | null; stops: Option[] }>();
    for (const o of options) {
      const line = byLine.get(o.route_id) ?? { id: o.route_id, name: o.route_name, departure: o.route_departure, stops: [] };
      line.stops.push(o);
      byLine.set(o.route_id, line);
    }
    return [...byLine.values()]
      .map((line) => ({
        ...line,
        stops: needle ? line.stops.filter((o) => foldArabic(`${o.stop_name} ${o.route_name}`).includes(needle)) : line.stops,
      }))
      .filter((line) => line.stops.length);
  }, [options, needle]);

  if (!options.length) return <p className="rounded-lg bg-warning/10 p-3 text-sm font-semibold text-warning">{p.noLines}</p>;
  return (
    <div className="space-y-2" data-testid={testId}>
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          {p.search}
        </label>
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <Input id={searchId} className="ps-9" placeholder={p.search} value={term} onChange={(e) => setTerm(e.target.value)} data-testid={`${testId}-search`} />
      </div>
      <div role="radiogroup" aria-label={label} className="max-h-96 space-y-3 overflow-y-auto rounded-xl border border-border p-2" data-testid={`${testId}-options`}>
        {lines.length ? (
          lines.map((line) => (
            <section key={line.id} aria-label={line.name}>
              <p className="sticky top-0 z-[1] flex items-center gap-2 rounded-md bg-surface px-2 py-1.5 text-sm font-extrabold">
                <Bus className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden />
                {line.name}
                {line.departure ? <span className="num text-xs font-semibold text-muted">· {p.departs(formatClock(line.departure))}</span> : null}
              </p>
              <ul className="mt-1 space-y-1">
                {line.stops.map((o) => {
                  const key = optionKey(o);
                  const on = key === value;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => onChange(key)}
                        className={cn(
                          'flex min-h-touch w-full items-center justify-between gap-2 rounded-lg border px-3 text-start',
                          on ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-transparent hover:bg-surface',
                        )}
                      >
                        <span className="font-semibold">{o.stop_name}</span>
                        <span className={cn('num shrink-0 text-sm', on ? 'text-on-ink' : 'text-muted')}>{formatClock(o.stop_time)}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        ) : (
          <p className="p-2 text-sm text-muted">{p.noStops}</p>
        )}
      </div>
    </div>
  );
}

/** The seat of one patient: name, phone, then the same choices as the student's own seat. */
function PatientForm({
  index,
  value,
  onChange,
  options,
}: {
  index: number;
  value: PatientDraft;
  onChange: (next: PatientDraft) => void;
  options: Option[];
}) {
  const p = t.pickup;
  const nameId = useId();
  const phoneId = useId();
  const set = (patch: Partial<PatientDraft>) => onChange({ ...value, ...patch });
  const n = index + 1;
  const slotOptions = options.filter((o) => o.slot === value.outbound_time);
  const chosen = slotOptions.find((o) => optionKey(o) === value.option);
  return (
    <fieldset className="space-y-4 rounded-xl border border-border p-4" data-testid={`pickup-patient-${n}`}>
      <legend className="px-1 font-extrabold text-brand-ink">{p.patientTitle(n)}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={p.patientName} htmlFor={nameId}>
          <Input id={nameId} value={value.full_name} onChange={(e) => set({ full_name: e.target.value })} autoComplete="off" data-testid={`pickup-patient-${n}-name`} />
        </Field>
        <Field label={p.patientPhone} htmlFor={phoneId}>
          <Input
            id={phoneId}
            type="tel"
            inputMode="tel"
            dir="ltr"
            className="text-start"
            value={value.phone}
            onChange={(e) => set({ phone: e.target.value })}
            data-testid={`pickup-patient-${n}-phone`}
          />
        </Field>
      </div>
      <div className="space-y-2">
        <p className="text-sm font-bold">{p.outboundTime}</p>
        <SlotPicker
          value={value.outbound_time}
          onChange={(slot) => set({ outbound_time: slot, option: '' })}
          label={`${p.patientTitle(n)} — ${p.outboundTime}`}
          testId={`pickup-patient-${n}-outbound-times`}
        />
      </div>
      {value.outbound_time ? (
        <>
          <LinePicker
            options={slotOptions}
            value={value.option}
            onChange={(key) => set({ option: key })}
            label={`${p.patientTitle(n)} — ${p.outboundStop}`}
            testId={`pickup-patient-${n}-stop`}
          />
          <ArrivalNote booking={optionBooking(value.outbound_time, chosen)} />
        </>
      ) : null}
    </fieldset>
  );
}

const isSlot = (value: string | undefined) => (value && (OUTBOUND_SLOTS as readonly string[]).includes(value) ? value : '');

export function PickupPage() {
  const p = t.pickup;
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const win = usePickupWindow();
  const choices = useMyChoices(win.data);
  const tomorrow = choices.data?.find((c) => c.service_date === win.data?.service_date);
  // a booking stays editable while booking is open
  const [editing, setEditing] = useState(false);
  const canBook = Boolean(win.data?.open) && choices.isSuccess && (!tomorrow || editing);
  const options = usePickupOptions(canBook);
  const defaults = useBookingDefaults(me?.student?.id, win.data?.service_date, canBook);
  // null = not touched yet: the suggestion from the weekly schedule shows until the student picks
  const [slotPick, setSlot] = useState<string | null>(null);
  const [optionPick, setOption] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patientsAllowed = usePatientsAllowed(me?.student?.id);
  const myPatients = useMyPatients(win.data?.service_date);
  const todayPatients = useMyPatients(win.data?.today);
  const [withPatients, setWithPatients] = useState(false);
  const [patients, setPatients] = useState<PatientDraft[]>([emptyPatient()]);
  const countId = useId();
  const sentPatients = withPatients && patientsAllowed.data ? patients : [];

  const all = options.data ?? [];
  const slot = slotPick ?? isSlot(defaults.data?.outbound);
  const slotOptions = all.filter((o) => o.slot === slot);
  // the nearest stop is preselected when a line of that trip passes it
  const homeOption = slotOptions.find((o) => o.stop_id === defaults.data?.stopId);
  const optionKeyValue = optionPick ?? (homeOption ? optionKey(homeOption) : '');
  const chosen = slotOptions.find((o) => optionKey(o) === optionKeyValue);
  const suggested = Boolean(defaults.data && (defaults.data.outbound || homeOption));
  const optionOf = (time: string, key: string) => all.find((o) => o.slot === time && optionKey(o) === key);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase.rpc('choose_my_pickup', {
          p_outbound_time: slot,
          p_route_id: chosen?.route_id,
          p_stop_id: chosen?.stop_id,
          p_patients: sentPatients.map((x) => ({
            full_name: x.full_name.trim(),
            phone: x.phone.trim(),
            outbound_time: x.outbound_time,
            ...splitKey(x.option),
          })),
        }),
      ),
    onSuccess: () => {
      toast.success(tomorrow ? p.savedEdit : p.saved);
      setConfirming(false);
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['my-pickups'] });
      void qc.invalidateQueries({ queryKey: ['my-patients'] });
    },
    onError: (e) => {
      setConfirming(false);
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['pickup-window'] });
      void qc.invalidateQueries({ queryKey: ['pickup-options'] });
      void qc.invalidateQueries({ queryKey: ['my-pickups'] });
    },
  });

  if (win.isLoading || !win.data || choices.isLoading) return <ListSkeleton rows={3} />;
  const w = win.data;
  const today = choices.data?.find((c) => c.service_date === w.today);

  /** Opens the form filled with the saved booking. */
  const startEditing = () => {
    if (!tomorrow) return;
    const saved = myPatients.data ?? [];
    setSlot(hhmm(tomorrow.outbound_time));
    setOption(tomorrow.outbound_route_id && tomorrow.stop_id ? optionKey({ route_id: tomorrow.outbound_route_id, stop_id: tomorrow.stop_id }) : '');
    setWithPatients(saved.length > 0);
    setPatients(
      saved.length
        ? saved.map((x) => ({ full_name: x.full_name, phone: x.phone, outbound_time: hhmm(x.outbound_time), option: x.option ?? '' }))
        : [emptyPatient()],
    );
    setError(null);
    setEditing(true);
  };

  const submit = () => {
    if (!slot || !chosen) {
      setError(p.missing);
      return;
    }
    const incomplete = sentPatients.findIndex((x) => !patientComplete(x) || !optionOf(x.outbound_time, x.option));
    if (incomplete >= 0) {
      setError(p.patientsMissing(incomplete + 1));
      return;
    }
    setError(null);
    setConfirming(true);
  };

  return (
    <div className="space-y-4">
      <PageHeader title={p.title} subtitle={p.forDate(dayLabel(w.service_date))} />

      {tomorrow && !editing ? (
        <Card className="space-y-3" data-testid="pickup-locked">
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-brand-ink" aria-hidden />
            {p.lockedTitle}
          </CardTitle>
          <ChoiceSummary booking={toBooking(tomorrow)} />
          <PatientsSummary patients={myPatients.data ?? []} testId="pickup-locked-patients" />
          {w.open ? (
            <>
              <p className="text-xs text-muted">{p.editUntil(formatClock(w.closes_at))}</p>
              <Button variant="secondary" className="w-full" onClick={startEditing} disabled={myPatients.isLoading} data-testid="pickup-edit">
                <Pencil className="h-4 w-4" aria-hidden />
                {p.edit}
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted">{p.lockedNote}</p>
          )}
        </Card>
      ) : w.open ? (
        <Card className="space-y-5" data-testid="pickup-open">
          <p className="text-sm text-muted">{p.intro}</p>
          {suggested ? <p className="rounded-lg bg-brand/10 p-3 text-sm">{p.fromSchedule}</p> : null}
          <div className="space-y-2">
            <CardTitle className="mb-0">1. {p.outboundTime}</CardTitle>
            <SlotPicker
              value={slot}
              onChange={(next) => {
                setSlot(next);
                setOption('');
              }}
              label={p.outboundTime}
              testId="pickup-outbound-times"
            />
          </div>
          {slot ? (
            <div className="space-y-2">
              <CardTitle className="mb-0">2. {p.outboundStop}</CardTitle>
              <p className="text-xs text-muted">{p.stopHint}</p>
              {options.isLoading ? (
                <ListSkeleton rows={2} />
              ) : (
                <LinePicker options={slotOptions} value={optionKeyValue} onChange={setOption} label={p.outboundStop} testId="pickup-stop" />
              )}
              <ArrivalNote booking={optionBooking(slot, chosen)} testId="pickup-arrival" />
            </div>
          ) : null}
          {patientsAllowed.data ? (
            <div className="space-y-4 border-t border-border pt-4" data-testid="pickup-patients">
              <label className="flex min-h-touch items-center gap-3 text-base font-bold">
                <input
                  type="checkbox"
                  className="h-6 w-6 accent-brand-ink"
                  checked={withPatients}
                  onChange={(e) => setWithPatients(e.target.checked)}
                  data-testid="pickup-has-patients"
                />
                {p.hasPatients}
              </label>
              {withPatients ? (
                <>
                  <Field label={p.patientsCount} htmlFor={countId} className="max-w-[12rem]">
                    <Select
                      id={countId}
                      value={patients.length}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        setPatients((list) => Array.from({ length: n }, (_, i) => list[i] ?? emptyPatient()));
                      }}
                      data-testid="pickup-patients-count"
                    >
                      {Array.from({ length: MAX_PATIENTS }, (_, i) => (
                        <option key={i + 1} value={i + 1}>
                          {i + 1}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {patients.map((x, i) => (
                    <PatientForm
                      key={i}
                      index={i}
                      value={x}
                      options={all}
                      onChange={(next) => setPatients((list) => list.map((old, j) => (j === i ? next : old)))}
                    />
                  ))}
                </>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">
              {error}
            </p>
          ) : null}
          <Button variant="primary" size="lg" className="w-full" disabled={save.isPending} onClick={submit} data-testid="pickup-save">
            {editing ? p.saveEdit : p.save}
          </Button>
          {editing ? (
            <Button variant="ghost" className="w-full" onClick={() => setEditing(false)} disabled={save.isPending} data-testid="pickup-edit-cancel">
              {p.cancelEdit}
            </Button>
          ) : null}
        </Card>
      ) : (
        <Card className="flex flex-col items-center gap-3 py-8 text-center" data-testid="pickup-closed">
          <Clock className="h-12 w-12 text-brand-ink" aria-hidden />
          <p className="text-lg font-extrabold">{w.phase === 'after' ? p.afterTitle : p.closedTitle}</p>
          <p className="text-sm text-muted">{p.opensAt(formatClock(w.opens_at), formatClock(w.closes_at))}</p>
        </Card>
      )}

      <Card className="space-y-2">
        <p className="text-sm font-bold">
          {p.todayChoice} ({dayLabel(w.today)})
        </p>
        {today ? <ChoiceSummary booking={toBooking(today)} /> : <p className="text-sm text-muted">{p.noTodayChoice}</p>}
        <PatientsSummary patients={todayPatients.data ?? []} />
      </Card>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={editing ? p.confirmEditTitle : p.confirmTitle}
        body={editing ? p.confirmEditBody(formatClock(w.closes_at)) : p.confirmBody(formatClock(w.closes_at))}
        busy={save.isPending}
        onConfirm={() => save.mutate()}
      >
        <ChoiceSummary booking={optionBooking(slot, chosen)} testId="pickup-confirm-summary" />
        <div className="mt-3">
          <PatientsSummary
            patients={sentPatients.map((x, i) => ({
              seq: i + 1,
              full_name: x.full_name.trim(),
              phone: x.phone.trim(),
              ...optionBooking(x.outbound_time, optionOf(x.outbound_time, x.option)),
            }))}
            testId="pickup-confirm-patients"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
