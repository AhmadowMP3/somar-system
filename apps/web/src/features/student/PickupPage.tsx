import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Clock, Lock, MapPinned } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatClock, formatDate } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { SearchPicker } from '@/components/SearchPicker';
import { ConfirmDialog, useToast } from '@/components/ui/overlay';
import { Button, Card, CardTitle } from '@/components/ui/primitives';
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
  stop_id: string;
  return_time: string | null;
  stops: { name: string } | null;
  return_stop: { name: string } | null;
};

/** Weekday name + date, e.g. «الثلاثاء 06/10/2026». */
function dayLabel(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return `${t.days[dow]} ${formatDate(date)}`;
}

/** The server clock and the settings decide when the choice is open; re-checked every minute. */
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
          .select('service_date, stop_id, return_time, stops!pickup_choices_stop_id_fkey(name), return_stop:stops!pickup_choices_return_stop_id_fkey(name)')
          .in('service_date', [win?.today as string, win?.service_date as string]),
      ) as unknown as Choice[],
  });
}

/** Home-screen entry: tells the student whether tomorrow's choice is open, and what they picked. */
export function PickupHomeCard() {
  const win = usePickupWindow();
  const choices = useMyChoices(win.data);
  if (!win.data) return null;
  const tomorrow = choices.data?.find((c) => c.service_date === win.data.service_date);
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
            {tomorrow?.stops
              ? t.pickup.homeChosen(tomorrow.stops.name)
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

function ChoiceSummary({ choice }: { choice: Choice }) {
  const p = t.pickup;
  return (
    <dl className="grid gap-2 text-sm">
      <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-surface p-3">
        <dt className="text-muted">{p.outbound}</dt>
        <dd className="font-bold" data-testid="pickup-current">
          {choice.stops?.name}
        </dd>
      </div>
      {choice.return_time ? (
        <div className="flex flex-wrap justify-between gap-2 rounded-lg bg-surface p-3">
          <dt className="text-muted">{p.return}</dt>
          <dd className="font-bold" data-testid="pickup-current-return">
            {p.at(choice.return_stop?.name ?? '', formatClock(choice.return_time))}
          </dd>
        </div>
      ) : null}
    </dl>
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
  const returnTimes = useQuery({
    queryKey: ['pickup-return-times', win.data?.service_date],
    enabled: Boolean(win.data?.open),
    queryFn: async () => (unwrap(await supabase.rpc('pickup_return_times')) as { slot: string }[]).map((r) => r.slot),
  });
  const [stopId, setStopId] = useState('');
  const [returnTime, setReturnTime] = useState('');
  const [returnStopId, setReturnStopId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase.rpc('choose_my_pickup', {
          p_stop_id: stopId,
          p_return_time: returnTime || null,
          p_return_stop_id: returnStopId || null,
        }),
      ),
    onSuccess: () => {
      toast.success(p.saved);
      setConfirming(false);
      void qc.invalidateQueries({ queryKey: ['my-pickups'] });
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
  const tomorrow = choices.data?.find((c) => c.service_date === w.service_date);
  const items = (stops.data ?? []).filter((s) => s.is_active).map((s) => ({ id: s.id, name: s.name }));
  const times = returnTimes.data ?? [];
  const needsReturn = times.length > 0;

  const submit = () => {
    if (!stopId || (needsReturn && (!returnTime || !returnStopId))) {
      setError(p.missing);
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
          <ChoiceSummary choice={tomorrow} />
          <p className="text-xs text-muted">{p.lockedNote}</p>
        </Card>
      ) : w.open ? (
        <Card className="space-y-5" data-testid="pickup-open">
          <p className="text-sm text-muted">{p.intro}</p>
          <div>
            <CardTitle>{p.outbound}</CardTitle>
            <SearchPicker items={items} value={stopId} onChange={setStopId} placeholder={p.search} label={p.outbound} emptyText={p.noStops} testId="pickup-stop" />
          </div>
          <div className="space-y-3">
            <CardTitle className="mb-0">{p.return}</CardTitle>
            {returnTimes.isLoading ? (
              <ListSkeleton rows={1} />
            ) : needsReturn ? (
              <>
                <div role="radiogroup" aria-label={p.returnTime} className="flex flex-wrap gap-3" data-testid="pickup-return-times">
                  {times.map((slot) => (
                    <button
                      key={slot}
                      type="button"
                      role="radio"
                      aria-checked={returnTime === slot}
                      onClick={() => setReturnTime(slot)}
                      className={cn(
                        'num min-h-touch rounded-lg border px-4 text-base font-bold',
                        returnTime === slot ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
                      )}
                    >
                      {formatClock(slot)}
                    </button>
                  ))}
                </div>
                <SearchPicker
                  items={items}
                  value={returnStopId}
                  onChange={setReturnStopId}
                  placeholder={p.search}
                  label={p.returnStop}
                  emptyText={p.noStops}
                  testId="pickup-return-stop"
                />
              </>
            ) : (
              <p className="text-sm text-muted">{p.noReturnTimes}</p>
            )}
          </div>
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
        {today ? <ChoiceSummary choice={today} /> : <p className="text-sm text-muted">{p.noTodayChoice}</p>}
      </Card>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={p.confirmTitle}
        body={p.confirmBody}
        busy={save.isPending}
        onConfirm={() => save.mutate()}
      />
    </div>
  );
}
