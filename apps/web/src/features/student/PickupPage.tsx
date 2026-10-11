import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Clock, Lock, MapPinned, UserRound } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatClock, formatDate, OUTBOUND_SLOTS, RETURN_SLOTS } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { SearchPicker } from '@/components/SearchPicker';
import { ConfirmDialog, useToast } from '@/components/ui/overlay';
import { Button, Card, CardTitle, Field, Input, Select } from '@/components/ui/primitives';
import { ListSkeleton, PageHeader } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useStopLibrary } from './StudentPages';

type PickupWindow = {
  open: boolean;
  phase: 'before' | 'open' | 'after';
  opens_at: string;
  closes_at: string;
  today: string;
  service_date: string;
};
type Choice = {
  service_date: string;
  outbound_time: string | null;
  return_time: string | null;
  /** Names saved with the booking: the stop may have been deleted since. */
  stop_name: string | null;
  return_stop_name: string | null;
  stops: { name: string } | null;
  return_stop: { name: string } | null;
};
/** What a summary shows: a saved booking, or the one about to be confirmed. */
type Booking = { outbound_time: string | null; stop: string | null; return_time: string | null; return_stop: string | null };
/** A patient's seat as the student fills it in (dentistry students bring patients). */
type PatientDraft = { full_name: string; phone: string; outbound_time: string; stop_id: string; return_time: string; return_stop_id: string };
type SavedPatient = Booking & { seq: number; full_name: string; phone: string };
type PatientRow = {
  seq: number;
  full_name: string;
  phone: string;
  outbound_time: string;
  return_time: string;
  stop_name: string | null;
  return_stop_name: string | null;
  stops: { name: string } | null;
  return_stop: { name: string } | null;
};

const MAX_PATIENTS = 5;
const emptyPatient = (): PatientDraft => ({ full_name: '', phone: '', outbound_time: '', stop_id: '', return_time: '', return_stop_id: '' });
const patientComplete = (x: PatientDraft) =>
  x.full_name.trim().length >= 2 &&
  /^\+?[0-9]{7,15}$/.test(x.phone.replace(/[\s\-().]/g, '')) &&
  Boolean(x.outbound_time && x.stop_id && x.return_time && x.return_stop_id);

const toBooking = (c: Choice): Booking => ({
  outbound_time: c.outbound_time,
  stop: c.stops?.name ?? c.stop_name,
  return_time: c.return_time,
  return_stop: c.return_stop?.name ?? c.return_stop_name,
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
            'service_date, outbound_time, return_time, stop_name, return_stop_name, stops!pickup_choices_stop_id_fkey(name), return_stop:stops!pickup_choices_return_stop_id_fkey(name)',
          )
          .in('service_date', [win?.today as string, win?.service_date as string]),
      ) as unknown as Choice[],
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
              'seq, full_name, phone, outbound_time, return_time, stop_name, return_stop_name, stops!pickup_patients_stop_id_fkey(name), return_stop:stops!pickup_patients_return_stop_id_fkey(name)',
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
          return_time: r.return_time,
          return_stop: r.return_stop?.name ?? r.return_stop_name,
        }),
      ),
  });
}

/** Suggested booking: the student's weekly times for that weekday and their nearest stop. */
function useBookingDefaults(studentId: string | undefined, serviceDate: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['pickup-defaults', studentId, serviceDate],
    enabled: enabled && Boolean(studentId && serviceDate),
    queryFn: async () => {
      const dow = new Date(`${serviceDate}T00:00:00Z`).getUTCDay() || 7;
      const [student, schedule] = await Promise.all([
        supabase.from('students').select('home_stop_id').eq('id', studentId as string).maybeSingle(),
        supabase
          .from('student_schedule')
          .select('outbound_time, return_time')
          .eq('student_id', studentId as string)
          .eq('dow', dow)
          .maybeSingle(),
      ]);
      const home = unwrap(student) as { home_stop_id: string | null } | null;
      const day = unwrap(schedule) as { outbound_time: string; return_time: string } | null;
      return { stopId: home?.home_stop_id ?? '', outbound: hhmm(day?.outbound_time), ret: hhmm(day?.return_time) };
    },
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

function ChoiceSummary({ booking, testId }: { booking: Booking; testId?: string }) {
  const p = t.pickup;
  const line = (time: string | null, stop: string | null) => p.at(formatClock(time) || p.unknown, stop ?? p.unknown);
  return (
    <dl className="grid gap-2 text-sm" data-testid={testId}>
      <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-surface p-3">
        <dt className="text-muted">{p.outbound}</dt>
        <dd className="num font-bold" data-testid="pickup-current">
          {line(booking.outbound_time, booking.stop)}
        </dd>
      </div>
      {booking.return_time ? (
        <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-surface p-3">
          <dt className="text-muted">{p.return}</dt>
          <dd className="num font-bold" data-testid="pickup-current-return">
            {line(booking.return_time, booking.return_stop)}
          </dd>
        </div>
      ) : null}
    </dl>
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

/** One row of slot radio buttons; a slot that cannot be picked is disabled. */
function SlotPicker({
  slots,
  value,
  onChange,
  label,
  isEnabled = () => true,
  testId,
}: {
  slots: readonly string[];
  value: string;
  onChange: (slot: string) => void;
  label: string;
  isEnabled?: (slot: string) => boolean;
  testId: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-3" data-testid={testId}>
      {slots.map((slot) => (
        <button
          key={slot}
          type="button"
          role="radio"
          aria-checked={value === slot}
          disabled={!isEnabled(slot)}
          onClick={() => onChange(slot)}
          className={cn(
            'num min-h-touch rounded-lg border px-4 text-base font-bold disabled:cursor-not-allowed disabled:opacity-40',
            value === slot ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
          )}
        >
          {formatClock(slot)}
        </button>
      ))}
    </div>
  );
}

const isSlot = (slots: readonly string[], value: string | undefined) => (value && slots.includes(value) ? value : '');

/** The seat of one patient: name, phone, then the same four choices as the student's own seat. */
function PatientForm({
  index,
  value,
  onChange,
  items,
}: {
  index: number;
  value: PatientDraft;
  onChange: (next: PatientDraft) => void;
  items: { id: string; name: string }[];
}) {
  const p = t.pickup;
  const nameId = useId();
  const phoneId = useId();
  const set = (patch: Partial<PatientDraft>) => onChange({ ...value, ...patch });
  const returnAllowed = (slot: string) => !value.outbound_time || slot > value.outbound_time;
  const n = index + 1;
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
          slots={OUTBOUND_SLOTS}
          value={value.outbound_time}
          onChange={(slot) => set({ outbound_time: slot, return_time: value.return_time > slot ? value.return_time : '' })}
          label={`${p.patientTitle(n)} — ${p.outboundTime}`}
          testId={`pickup-patient-${n}-outbound-times`}
        />
      </div>
      <SearchPicker
        items={items}
        value={value.stop_id}
        onChange={(id) => set({ stop_id: id })}
        placeholder={p.search}
        label={p.outboundStop}
        emptyText={p.noStops}
        testId={`pickup-patient-${n}-stop`}
      />
      <div className="space-y-2">
        <p className="text-sm font-bold">{p.returnTime}</p>
        <SlotPicker
          slots={RETURN_SLOTS}
          value={value.return_time}
          onChange={(slot) => set({ return_time: slot })}
          label={`${p.patientTitle(n)} — ${p.returnTime}`}
          isEnabled={returnAllowed}
          testId={`pickup-patient-${n}-return-times`}
        />
      </div>
      <SearchPicker
        items={items}
        value={value.return_stop_id}
        onChange={(id) => set({ return_stop_id: id })}
        placeholder={p.search}
        label={p.returnStop}
        emptyText={p.noStops}
        testId={`pickup-patient-${n}-return-stop`}
      />
    </fieldset>
  );
}

export function PickupPage() {
  const p = t.pickup;
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const win = usePickupWindow();
  const choices = useMyChoices(win.data);
  const stops = useStopLibrary(me?.student?.university_id);
  const tomorrow = choices.data?.find((c) => c.service_date === win.data?.service_date);
  const defaults = useBookingDefaults(me?.student?.id, win.data?.service_date, Boolean(win.data?.open) && choices.isSuccess && !tomorrow);
  // null = not touched yet: the suggestion from the weekly schedule shows until the student picks
  const [outboundPick, setOutboundTime] = useState<string | null>(null);
  const [stopPick, setStopId] = useState<string | null>(null);
  const [returnPick, setReturnTime] = useState<string | null>(null);
  const [returnStopPick, setReturnStopId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patientsAllowed = usePatientsAllowed(me?.student?.id);
  const myPatients = useMyPatients(win.data?.service_date);
  const todayPatients = useMyPatients(win.data?.today);
  const [withPatients, setWithPatients] = useState(false);
  const [patients, setPatients] = useState<PatientDraft[]>([emptyPatient()]);
  const countId = useId();
  const sentPatients = withPatients && patientsAllowed.data ? patients : [];

  const items = (stops.data ?? []).filter((s) => s.is_active).map((s) => ({ id: s.id, name: s.name }));
  const homeStop = items.some((s) => s.id === defaults.data?.stopId) ? (defaults.data?.stopId ?? '') : '';
  const outboundTime = outboundPick ?? isSlot(OUTBOUND_SLOTS, defaults.data?.outbound);
  const stopId = stopPick ?? homeStop;
  const returnAllowed = (slot: string) => !outboundTime || slot > outboundTime;
  const wantedReturn = returnPick ?? isSlot(RETURN_SLOTS, defaults.data?.ret);
  // a return no later than the chosen outbound is dropped
  const returnTime = wantedReturn && returnAllowed(wantedReturn) ? wantedReturn : '';
  const returnStopId = returnStopPick ?? homeStop;
  const suggested = Boolean(defaults.data && (defaults.data.outbound || homeStop));

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase.rpc('choose_my_pickup', {
          p_outbound_time: outboundTime,
          p_stop_id: stopId,
          p_return_time: returnTime,
          p_return_stop_id: returnStopId,
          p_patients: sentPatients.map((x) => ({ ...x, full_name: x.full_name.trim(), phone: x.phone.trim() })),
        }),
      ),
    onSuccess: () => {
      toast.success(p.saved);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['my-pickups'] });
      void qc.invalidateQueries({ queryKey: ['my-patients'] });
    },
    onError: (e) => {
      setConfirming(false);
      setError(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['pickup-window'] });
      void qc.invalidateQueries({ queryKey: ['my-pickups'] });
    },
  });

  if (win.isLoading || !win.data || choices.isLoading) return <ListSkeleton rows={3} />;
  const w = win.data;
  const today = choices.data?.find((c) => c.service_date === w.today);
  const nameOf = (id: string) => items.find((s) => s.id === id)?.name ?? null;

  const submit = () => {
    if (!outboundTime || !stopId || !returnTime || !returnStopId) {
      setError(p.missing);
      return;
    }
    const incomplete = sentPatients.findIndex((x) => !patientComplete(x));
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

      {tomorrow ? (
        <Card className="space-y-3" data-testid="pickup-locked">
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5 text-brand-ink" aria-hidden />
            {p.lockedTitle}
          </CardTitle>
          <ChoiceSummary booking={toBooking(tomorrow)} />
          <PatientsSummary patients={myPatients.data ?? []} testId="pickup-locked-patients" />
          <p className="text-xs text-muted">{p.lockedNote}</p>
        </Card>
      ) : w.open ? (
        <Card className="space-y-5" data-testid="pickup-open">
          <p className="text-sm text-muted">{p.intro}</p>
          {suggested ? <p className="rounded-lg bg-brand/10 p-3 text-sm">{p.fromSchedule}</p> : null}
          <div className="space-y-2">
            <CardTitle className="mb-0">1. {p.outboundTime}</CardTitle>
            <SlotPicker slots={OUTBOUND_SLOTS} value={outboundTime} onChange={setOutboundTime} label={p.outboundTime} testId="pickup-outbound-times" />
          </div>
          <div>
            <CardTitle>2. {p.outboundStop}</CardTitle>
            <SearchPicker items={items} value={stopId} onChange={setStopId} placeholder={p.search} label={p.outboundStop} emptyText={p.noStops} testId="pickup-stop" />
          </div>
          <div className="space-y-2">
            <CardTitle className="mb-0">3. {p.returnTime}</CardTitle>
            <SlotPicker
              slots={RETURN_SLOTS}
              value={returnTime}
              onChange={setReturnTime}
              label={p.returnTime}
              isEnabled={returnAllowed}
              testId="pickup-return-times"
            />
            <p className="text-xs text-muted">{p.returnAfterOutbound}</p>
          </div>
          <div>
            <CardTitle>4. {p.returnStop}</CardTitle>
            <SearchPicker
              items={items}
              value={returnStopId}
              onChange={setReturnStopId}
              placeholder={p.search}
              label={p.returnStop}
              emptyText={p.noStops}
              testId="pickup-return-stop"
            />
          </div>
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
                      items={items}
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
            {p.save}
          </Button>
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
        title={p.confirmTitle}
        body={p.confirmBody}
        busy={save.isPending}
        onConfirm={() => save.mutate()}
      >
        <ChoiceSummary
          booking={{ outbound_time: outboundTime, stop: nameOf(stopId), return_time: returnTime, return_stop: nameOf(returnStopId) }}
          testId="pickup-confirm-summary"
        />
        <div className="mt-3">
          <PatientsSummary
            patients={sentPatients.map((x, i) => ({
              seq: i + 1,
              full_name: x.full_name.trim(),
              phone: x.phone.trim(),
              outbound_time: x.outbound_time,
              stop: nameOf(x.stop_id),
              return_time: x.return_time,
              return_stop: nameOf(x.return_stop_id),
            }))}
            testId="pickup-confirm-patients"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
