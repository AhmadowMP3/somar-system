import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Clock, MapPinned } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDate } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { SearchPicker } from '@/components/SearchPicker';
import { useToast } from '@/components/ui/overlay';
import { Button, Card, CardTitle } from '@/components/ui/primitives';
import { ListSkeleton, PageHeader } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useStopLibrary } from './StudentPages';

type PickupWindow = { open: boolean; opens_at: string; today: string; service_date: string };
type Choice = { service_date: string; stop_id: string; stops: { name: string } | null };

/** Weekday name + date, e.g. «الثلاثاء 06/10/2026». */
function dayLabel(date: string): string {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
  return `${t.days[dow]} ${formatDate(date)}`;
}

/** Server clock decides when the page opens (18:00 Damascus); re-checked every minute. */
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
          .select('service_date, stop_id, stops(name)')
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
  const open = win.data.open;
  return (
    <Link
      to="/pickup"
      className={cn(
        'flex min-h-touch items-center justify-between gap-3 rounded-xl border p-4',
        open && !tomorrow ? 'border-brand bg-brand/10' : 'border-border bg-bg',
      )}
      data-testid="pickup-home"
    >
      <span className="flex items-center gap-3">
        <MapPinned className={cn('h-6 w-6 shrink-0', open && !tomorrow ? 'text-brand' : 'text-brand-ink')} aria-hidden />
        <span>
          <span className="block font-bold">{t.nav.myPickup}</span>
          <span className="block text-sm text-muted">
            {!open ? t.pickup.opensAt : tomorrow?.stops ? t.pickup.homeChosen(tomorrow.stops.name) : t.pickup.homeOpen}
          </span>
        </span>
      </span>
      <ChevronLeft className="h-5 w-5 shrink-0 text-muted" aria-hidden />
    </Link>
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
  const [stopId, setStopId] = useState('');

  const today = choices.data?.find((c) => c.service_date === win.data?.today);
  const tomorrow = choices.data?.find((c) => c.service_date === win.data?.service_date);
  useEffect(() => {
    if (tomorrow) setStopId(tomorrow.stop_id);
  }, [tomorrow]);

  const save = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('choose_my_pickup', { p_stop_id: stopId })),
    onSuccess: () => {
      toast.success(p.saved);
      void qc.invalidateQueries({ queryKey: ['my-pickups'] });
    },
    onError: (e) => {
      toast.error(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['pickup-window'] });
    },
  });

  if (win.isLoading || !win.data) return <ListSkeleton rows={3} />;
  const items = (stops.data ?? []).filter((s) => s.is_active).map((s) => ({ id: s.id, name: s.name }));

  return (
    <div className="space-y-4">
      <PageHeader title={p.title} subtitle={win.data.open ? `${p.intro} ${p.forDate(dayLabel(win.data.service_date))}` : undefined} />

      {win.data.open ? (
        <Card className="space-y-4" data-testid="pickup-open">
          <div className="rounded-lg bg-surface p-3 text-sm">
            <span className="text-muted">{p.current}: </span>
            <span className="font-bold" data-testid="pickup-current">
              {tomorrow?.stops?.name ?? p.none}
            </span>
          </div>
          <div>
            <CardTitle>{p.stop}</CardTitle>
            <SearchPicker items={items} value={stopId} onChange={setStopId} placeholder={p.search} label={p.stop} emptyText={p.noStops} testId="pickup-stop" />
          </div>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!stopId || stopId === tomorrow?.stop_id || save.isPending}
            onClick={() => save.mutate()}
            data-testid="pickup-save"
          >
            {save.isPending ? t.common.saving : tomorrow ? p.change : p.save}
          </Button>
          <p className="text-xs text-muted">{p.changeUntil}</p>
        </Card>
      ) : (
        <Card className="flex flex-col items-center gap-3 py-8 text-center" data-testid="pickup-closed">
          <Clock className="h-12 w-12 text-brand-ink" aria-hidden />
          <p className="text-lg font-extrabold">{p.closedTitle}</p>
          <p className="text-sm text-muted">{p.opensAt}</p>
        </Card>
      )}

      <Card className="text-sm">
        <span className="text-muted">
          {p.todayChoice} ({dayLabel(win.data.today)}):{' '}
        </span>
        <span className="font-bold">{today?.stops?.name ?? p.noTodayChoice}</span>
      </Card>
    </div>
  );
}
