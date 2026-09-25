import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, CalendarClock, ChevronLeft, KeyRound, LogOut, MapPinned, Navigation, Package as PackageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatClock, formatDate, formatDateTime, formatPhoneDisplay, formatTime } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { DirectionBadge } from '@/components/common';
import { QrCode } from '@/components/QrCode';
import { Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currentPushState, enablePush } from '@/lib/push';
import { PHOTO_BUCKET, signedUrl, supabase, unwrap } from '@/lib/supabase';

export type Dashboard = {
  student: {
    id: string;
    full_name: string;
    transport_number: string;
    qr_token: string;
    college: string | null;
    photo_path: string | null;
    phone_e164: string;
    university_student_no: string;
    work_days: number[];
    shift_start: string;
    residence_text: string | null;
    is_active: boolean;
  };
  university: { id: string; name: string; logo_path: string | null; week_start_dow: number } | null;
  balance: { week_start: string; quota: number; used: number; remaining: number };
  subscription: {
    id: string;
    package_id: string;
    package_name: string;
    trips_per_week: number;
    starts_on: string;
    ends_on: string;
    status: string;
  } | null;
  recent_scans: { id: string; scanned_at: string; service_date: string; direction: string; method: string; offday_override: boolean }[];
  unread_count: number;
  latest_notification: { id: string; title: string; body: string; created_at: string } | null;
  today: string;
};

export function useDashboard() {
  return useQuery({
    queryKey: ['student-dashboard'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('student_dashboard');
      if (error) throw error;
      return data as Dashboard;
    },
  });
}

function HomeSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label={t.common.loading}>
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

export function StudentHome() {
  const query = useDashboard();
  const [qrOpen, setQrOpen] = useState(false);
  return (
    <QueryState query={query} skeleton={<HomeSkeleton />}>
      {(d) => (
        <div className="space-y-4">
          <Card className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted">{t.student.transportNumber}</p>
            <p className="num font-mono text-3xl font-extrabold tracking-wider text-brand-ink" data-testid="transport-number">
              {d.student.transport_number}
            </p>
            <button
              type="button"
              className="rounded-xl border border-border p-2"
              onClick={() => setQrOpen(true)}
              aria-label={t.student.tapToEnlarge}
            >
              <QrCode token={d.student.qr_token} className="h-52 w-52" label={t.student.showQrHint} />
            </button>
            <p className="text-xs text-muted">{t.student.showQrHint}</p>
          </Card>

          <Card>
            {d.subscription ? (
              <>
                <p className="text-sm text-muted">{t.student.remaining}</p>
                <p className="mt-1 text-4xl font-extrabold text-brand-ink" data-testid="remaining">
                  <span className="num">{Math.max(d.balance.remaining, 0)}</span>
                  <span className="text-lg font-bold text-muted">
                    {' '}
                    {t.common.of} <span className="num">{d.balance.quota}</span>
                  </span>
                </p>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface" aria-hidden>
                  <div
                    className="h-full rounded-full bg-success"
                    style={{ width: `${d.balance.quota ? Math.max(0, Math.min(100, (d.balance.remaining / d.balance.quota) * 100)) : 0}%` }}
                  />
                </div>
                <div className="mt-3 flex flex-wrap justify-between gap-2 text-sm">
                  <span className="text-muted">{t.student.weekStarts(formatDate(d.balance.week_start))}</span>
                  <span>
                    {t.student.subscriptionEnds}: <span className="num font-semibold">{formatDate(d.subscription.ends_on)}</span>
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted">{t.student.tripExplain}</p>
              </>
            ) : (
              <p className="text-sm font-semibold text-warning">{t.student.noSubscription}</p>
            )}
          </Card>

          <Card>
            <CardTitle className="flex items-center gap-2">
              <BellRing className="h-5 w-5 text-brand-ink" aria-hidden />
              {t.student.latestNotification}
            </CardTitle>
            {d.latest_notification ? (
              <Link to="/notifications" className="block">
                <p className="font-bold">{d.latest_notification.title}</p>
                <p className="mt-1 text-sm text-muted">{d.latest_notification.body}</p>
                <p className="num mt-1 text-xs text-muted">{formatDateTime(d.latest_notification.created_at)}</p>
              </Link>
            ) : (
              <p className="text-sm text-muted">{t.student.noNotifications}</p>
            )}
          </Card>

          <Link to="/packages" className="flex min-h-touch items-center justify-between rounded-xl border border-border bg-bg p-4">
            <span className="flex items-center gap-2 font-semibold">
              <PackageIcon className="h-5 w-5 text-brand-ink" aria-hidden />
              {t.nav.packages}
            </span>
            <ChevronLeft className="h-5 w-5 text-muted" aria-hidden />
          </Link>

          <Dialog open={qrOpen} onOpenChange={setQrOpen} title={d.student.transport_number}>
            <div className="flex justify-center">
              <QrCode token={d.student.qr_token} className="w-full max-w-sm" label={t.student.showQrHint} />
            </div>
          </Dialog>
        </div>
      )}
    </QueryState>
  );
}

export function TripsPage() {
  const query = useDashboard();
  return (
    <div>
      <PageHeader title={t.student.tripsTitle} />
      <QueryState
        query={query}
        empty={(d) =>
          d.recent_scans.length ? null : <EmptyState title={t.student.noTrips} hint={t.student.noTripsHint} />
        }
      >
        {(d) => {
          const days = new Map<string, Dashboard['recent_scans']>();
          for (const s of d.recent_scans) days.set(s.service_date, [...(days.get(s.service_date) ?? []), s]);
          return (
            <ul className="space-y-3">
              {[...days.entries()].map(([day, scans]) => (
                <li key={day}>
                  <Card className="p-3">
                    <p className="num mb-2 font-bold">
                      {t.days[new Date(`${day}T12:00:00Z`).getUTCDay() || 7]} · {formatDate(day)}
                    </p>
                    <ul className="space-y-2">
                      {[...scans].reverse().map((s) => (
                        <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                          <span className="flex items-center gap-2">
                            <DirectionBadge direction={s.direction} />
                            {s.method === 'manual' ? <Badge>{t.student.manual}</Badge> : null}
                            {s.offday_override ? <Badge tone="warning">{t.student.override}</Badge> : null}
                          </span>
                          <span className="num text-muted">{formatTime(s.scanned_at)}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                </li>
              ))}
            </ul>
          );
        }}
      </QueryState>
    </div>
  );
}

type PackageRow = { id: string; name: string; trips_per_week: number; price: number | null; semester_start: string; semester_end: string };

export function PackagesPage() {
  const { me } = useAuth();
  const universityId = me?.student?.university_id;
  const query = useQuery({
    queryKey: ['packages', universityId, 'active'],
    enabled: Boolean(universityId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('packages')
          .select('id, name, trips_per_week, price, semester_start, semester_end')
          .eq('university_id', universityId as string)
          .eq('is_active', true)
          .order('trips_per_week'),
      ) as PackageRow[],
  });
  return (
    <div>
      <PageHeader title={t.student.packagesTitle} />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={t.student.noPackages} />)}>
        {(rows) => (
          <ul className="grid gap-3 sm:grid-cols-2">
            {rows.map((p) => (
              <li key={p.id}>
                <Card>
                  <p className="text-lg font-bold">{p.name}</p>
                  <p className="mt-1 text-sm text-brand-ink">{t.student.tripsPerWeek(p.trips_per_week)}</p>
                  {p.price !== null ? (
                    <p className="mt-2 text-sm">
                      {t.student.price}: <span className="num font-bold">{Number(p.price).toLocaleString('en-US')}</span>
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted">
                    {t.student.semester}: <span className="num">{formatDate(p.semester_start)}</span> —{' '}
                    <span className="num">{formatDate(p.semester_end)}</span>
                  </p>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

export type RouteRow = {
  id: string;
  name: string;
  direction: string;
  departure_time: string | null;
  active_days: number[] | null;
  notes: string | null;
  is_active: boolean;
  route_stops: StopRow[];
};
export type StopRow = {
  id: string;
  seq: number;
  name: string;
  maps_url: string | null;
  lat: number | null;
  lng: number | null;
  departure_time: string | null;
  area_id: string | null;
};

export function useRoutes(universityId: string | null | undefined, onlyActive: boolean) {
  return useQuery({
    queryKey: ['routes', universityId, onlyActive],
    enabled: Boolean(universityId),
    queryFn: async () => {
      let q = supabase
        .from('routes')
        .select('id, name, direction, departure_time, active_days, notes, is_active, route_stops(id, seq, name, maps_url, lat, lng, departure_time, area_id)')
        .eq('university_id', universityId as string)
        .order('departure_time', { nullsFirst: false })
        .order('seq', { referencedTable: 'route_stops' });
      if (onlyActive) q = q.eq('is_active', true);
      return unwrap(await q) as RouteRow[];
    },
  });
}

export function RoutesPage() {
  const { me } = useAuth();
  const query = useRoutes(me?.student?.university_id, true);
  const [stop, setStop] = useState<{ route: RouteRow; stop: StopRow } | null>(null);
  return (
    <div>
      <PageHeader title={t.student.routesTitle} />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={t.student.noRoutes} />)}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.id}>
                <Card className="p-3">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="font-bold">{r.name}</p>
                    <span className="flex items-center gap-2 text-sm">
                      <Badge tone="info">{t.admin.routes.directions[r.direction]}</Badge>
                      {r.departure_time ? (
                        <span className="num flex items-center gap-1 font-semibold">
                          <CalendarClock className="h-4 w-4" aria-hidden />
                          {formatClock(r.departure_time)}
                        </span>
                      ) : null}
                    </span>
                  </div>
                  {r.notes ? <p className="mb-2 text-sm text-muted">{r.notes}</p> : null}
                  {r.route_stops.length ? (
                    <ol className="space-y-1">
                      {r.route_stops.map((s) => (
                        <li key={s.id}>
                          <button
                            type="button"
                            className="flex min-h-touch w-full items-center justify-between gap-2 rounded-lg px-2 text-start hover:bg-surface"
                            onClick={() => setStop({ route: r, stop: s })}
                            data-testid="stop-button"
                          >
                            <span className="flex items-center gap-2">
                              <MapPinned className="h-4 w-4 text-brand-ink" aria-hidden />
                              {s.name}
                            </span>
                            <span className="num text-sm text-muted">{formatClock(s.departure_time)}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-muted">{t.student.noStops}</p>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      <Dialog open={Boolean(stop)} onOpenChange={(o) => !o && setStop(null)} title={stop?.stop.name ?? ''} description={stop?.route.name}>
        {stop ? (
          <div className="space-y-3">
            {stop.stop.departure_time ? (
              <p className="text-sm">
                {t.student.departure}: <span className="num font-bold">{formatClock(stop.stop.departure_time)}</span>
              </p>
            ) : null}
            {stop.stop.maps_url ? (
              <Button asChild variant="secondary" size="lg" className="w-full">
                <a href={stop.stop.maps_url} target="_blank" rel="noopener noreferrer" data-testid="maps-link">
                  <Navigation className="h-5 w-5" aria-hidden />
                  {t.student.directions}
                </a>
              </Button>
            ) : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

type NotificationRow = { id: string; title: string; body: string; type: string; created_at: string; notification_reads: { profile_id: string }[] };

export function PushCard() {
  const toast = useToast();
  const [state, setState] = useState<'unsupported' | 'denied' | 'enabled' | 'disabled' | null>(null);
  useEffect(() => {
    void currentPushState().then(setState);
  }, []);
  const enable = useMutation({
    mutationFn: enablePush,
    onSuccess: (s) => setState(s),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const test = useMutation({
    mutationFn: () => api.post('/push/test'),
    onError: (e) => toast.error(errorMessage(e)),
    onSuccess: () => toast.success(t.common.success),
  });
  if (state === null) return null;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm">
        {state === 'enabled'
          ? t.student.pushEnabled
          : state === 'denied'
            ? t.student.pushDenied
            : state === 'unsupported'
              ? t.student.pushUnsupported
              : t.student.enablePush}
      </p>
      {state === 'disabled' ? (
        <Button variant="secondary" size="sm" disabled={enable.isPending} onClick={() => enable.mutate()}>
          <BellRing className="h-4 w-4" aria-hidden />
          {t.student.enablePush}
        </Button>
      ) : null}
      {state === 'enabled' ? (
        <Button size="sm" disabled={test.isPending} onClick={() => test.mutate()}>
          {t.student.testPush}
        </Button>
      ) : null}
    </Card>
  );
}

export function NotificationsPage() {
  const { me, session } = useAuth();
  const qc = useQueryClient();
  const studentId = me?.student?.id;
  const query = useQuery({
    queryKey: ['notifications', studentId],
    enabled: Boolean(studentId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('notifications')
          .select('id, title, body, type, created_at, notification_reads(profile_id)')
          .eq('student_id', studentId as string)
          .order('created_at', { ascending: false })
          .limit(100),
      ) as NotificationRow[],
  });
  const markAll = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('mark_all_notifications_read');
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['unread-count'] });
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      void qc.invalidateQueries({ queryKey: ['student-dashboard'] });
    },
  });
  const uid = session?.user.id;
  return (
    <div className="space-y-4">
      <PageHeader
        title={t.nav.notifications}
        actions={
          <Button size="sm" onClick={() => markAll.mutate()} disabled={markAll.isPending}>
            {t.student.markAllRead}
          </Button>
        }
      />
      <PushCard />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={t.student.noNotifications} />)}>
        {(rows) => (
          <ul className="space-y-2">
            {rows.map((n) => {
              const unread = !n.notification_reads.some((r) => r.profile_id === uid);
              return (
                <li key={n.id}>
                  <Card className={unread ? 'border-brand-ink/40 bg-surface p-3' : 'p-3'}>
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-bold">{n.title}</p>
                      {unread ? <Badge tone="info">{t.student.unread}</Badge> : null}
                    </div>
                    <p className="mt-1 whitespace-pre-line text-sm text-text">{n.body}</p>
                    <p className="num mt-1 text-xs text-muted">{formatDateTime(n.created_at)}</p>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

export function AccountPage() {
  const query = useDashboard();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const photo = useQuery({
    queryKey: ['photo-url', query.data?.student.photo_path],
    enabled: Boolean(query.data?.student.photo_path),
    queryFn: () => signedUrl(PHOTO_BUCKET, query.data?.student.photo_path),
  });
  return (
    <div className="space-y-4">
      <PageHeader title={t.student.accountTitle} />
      <QueryState query={query}>
        {(d) => (
          <>
            <Card className="flex items-center gap-4">
              {photo.data ? (
                <img src={photo.data} alt={t.student.photo} className="h-24 w-24 rounded-xl object-cover" />
              ) : (
                <Skeleton className="h-24 w-24" />
              )}
              <div className="min-w-0">
                <p className="text-lg font-bold">{d.student.full_name}</p>
                <p className="num font-mono text-brand-ink">{d.student.transport_number}</p>
                <p className="mt-1 text-xs text-muted">{t.student.photoLocked}</p>
              </div>
            </Card>
            <Card>
              <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted">{t.student.university}</dt>
                <dd>{d.university?.name}</dd>
                <dt className="text-muted">{t.student.college}</dt>
                <dd>{d.student.college}</dd>
                <dt className="text-muted">{t.student.universityNo}</dt>
                <dd className="num">{d.student.university_student_no}</dd>
                <dt className="text-muted">{t.student.phone}</dt>
                <dd className="num">{formatPhoneDisplay(d.student.phone_e164)}</dd>
                <dt className="text-muted">{t.student.workDays}</dt>
                <dd>{d.student.work_days.map((w) => t.days[w]).join('، ')}</dd>
                <dt className="text-muted">{t.student.shiftStart}</dt>
                <dd className="num">{formatClock(d.student.shift_start)}</dd>
                {d.student.residence_text ? (
                  <>
                    <dt className="text-muted">{t.student.residence}</dt>
                    <dd>{d.student.residence_text}</dd>
                  </>
                ) : null}
                <dt className="text-muted">{t.student.package}</dt>
                <dd>{d.subscription?.package_name ?? t.common.none}</dd>
              </dl>
              <p className="mt-3 text-xs text-muted">{t.student.readOnlyNote}</p>
            </Card>
            <PushCard />
            <div className="grid gap-2 sm:grid-cols-2">
              <Button asChild size="lg">
                <Link to="/password">
                  <KeyRound className="h-5 w-5" aria-hidden />
                  {t.nav.password}
                </Link>
              </Button>
              <Button
                size="lg"
                variant="ghost"
                onClick={async () => {
                  await signOut();
                  navigate('/login', { replace: true });
                }}
              >
                <LogOut className="h-5 w-5" aria-hidden />
                {t.auth.logout}
              </Button>
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}
