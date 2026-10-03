import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BellRing,
  CalendarClock,
  Download,
  IdCard,
  ChevronDown,
  ChevronLeft,
  KeyRound,
  List as ListIcon,
  LogOut,
  Map as MapIcon,
  MapPinned,
  Navigation,
  Package as PackageIcon,
  ScanLine,
} from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { formatClock, formatDate, formatDateTime, formatPhoneDisplay, formatTime } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { DirectionBadge } from '@/components/common';
import { QrCode } from '@/components/QrCode';
import { RouteMap } from '@/components/RouteMap';
import { cardVariant, CardFace, downloadCard, toDataUri, type CardValues } from '@/components/StudentCard';
import { PickupHomeCard } from './PickupPage';
import { Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, CardTitle, Field, Select, Skeleton } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currentPushState, enablePush } from '@/lib/push';
import { PHOTO_BUCKET, signedUrl, supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';

export type Dashboard = {
  student: {
    id: string;
    full_name: string;
    transport_number: string;
    qr_token: string;
    college: string | null;
    photo_path: string | null;
    phone_e164: string | null;
    university_student_no: string | null;
    work_days: number[];
    shift_start: string | null;
    residence_text: string | null;
    is_active: boolean;
    /** Doctors and university employees ride without a package (unlimited trips). */
    kind?: 'student' | 'doctor' | 'employee';
    job_title?: string | null;
    work_hours_text?: string | null;
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
  const { canScan } = useAuth();
  const [qrOpen, setQrOpen] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  return (
    <QueryState query={query} skeleton={<HomeSkeleton />}>
      {(d) => (
        <div className="space-y-4">
          {canScan ? (
            <Button asChild variant="primary" size="lg" className="h-16 w-full text-lg">
              <Link to="/scan">
                <ScanLine className="h-6 w-6" aria-hidden />
                {t.nav.scan}
              </Link>
            </Button>
          ) : null}
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
            <Button variant="secondary" className="w-full" onClick={() => setCardOpen(true)} data-testid="my-card">
              <IdCard className="h-5 w-5" aria-hidden />
              {t.cards.myCard}
            </Button>
          </Card>

          <PickupHomeCard />

          <Card>
            {d.student.kind && d.student.kind !== 'student' ? (
              <>
                <p className="text-3xl font-extrabold text-success" data-testid="remaining">
                  {t.student.unlimited}
                </p>
                <p className="mt-2 text-sm text-muted">{t.student.unlimitedHint}</p>
              </>
            ) : d.subscription ? (
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

          {d.student.kind && d.student.kind !== 'student' ? null : (
            <Link to="/packages" className="flex min-h-touch items-center justify-between rounded-xl border border-border bg-bg p-4">
              <span className="flex items-center gap-2 font-semibold">
                <PackageIcon className="h-5 w-5 text-brand-ink" aria-hidden />
                {t.nav.packages}
              </span>
              <ChevronLeft className="h-5 w-5 text-muted" aria-hidden />
            </Link>
          )}

          <Dialog
            open={cardOpen}
            onOpenChange={setCardOpen}
            title={t.cards.myCard}
            description={t.cards.myCardHint}
            className="sm:max-w-2xl"
          >
            {cardOpen ? <MyCard student={d.student} /> : null}
          </Dialog>

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

/** The student's own transport card on the owner's design, downloadable as an image. */
function MyCard({ student }: { student: Dashboard['student'] }) {
  const toast = useToast();
  const photo = useQuery({
    queryKey: ['card-photo', student.photo_path],
    queryFn: async () => toDataUri(await signedUrl(PHOTO_BUCKET, student.photo_path)),
    staleTime: 5 * 60_000,
  });
  const card: CardValues = {
    variant: cardVariant(student.kind),
    full_name: student.full_name,
    transport_number: student.transport_number,
    college: student.college ?? student.job_title ?? (student.kind ? (t.student.kind[student.kind] ?? '') : ''),
    qr_token: student.qr_token,
    photo: photo.data ?? null,
  };
  const download = useMutation({
    mutationFn: () => downloadCard(card),
    onSuccess: () => toast.success(t.cards.downloaded),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="space-y-4">
      {photo.isLoading ? <Skeleton className={cardVariant(student.kind) === 'doctor' ? 'aspect-[1230/749] w-full' : 'aspect-[1034/652] w-full'} /> : <CardFace card={card} className="w-full shadow-md" />}
      <Button
        variant="primary"
        size="lg"
        className="w-full"
        disabled={photo.isLoading || download.isPending}
        onClick={() => download.mutate()}
        data-testid="download-card"
      >
        <Download className="h-5 w-5" aria-hidden />
        {download.isPending ? t.cards.downloading : t.cards.download}
      </Button>
    </div>
  );
}

export function TripsPage() {
  const query = useDashboard();
  return (
    <div>
      <PageHeader title={t.student.tripsTitle} />
      <QueryState
        query={query}
        empty={(d) => (d.recent_scans.length ? null : <EmptyState title={t.student.noTrips} hint={t.student.noTripsHint} />)}
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
                      {t.student.price}: <span className="num font-bold">{Number(p.price).toLocaleString('en-US')}</span> {t.currency}
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
/** A stop on a route: per-route order and time, with name/location coming from the stop library. */
export type StopRow = {
  id: string;
  seq: number;
  stop_id: string | null;
  name: string;
  maps_url: string | null;
  lat: number | null;
  lng: number | null;
  departure_time: string | null;
  area_id: string | null;
};
type LibraryStopRef = { name: string; maps_url: string | null; lat: number | null; lng: number | null; area_id: string | null };
type RawRouteStop = Omit<StopRow, 'name' | 'maps_url' | 'lat' | 'lng' | 'area_id'> &
  Partial<LibraryStopRef> & { stop: LibraryStopRef | null };

export function useRoutes(universityId: string | null | undefined, onlyActive: boolean) {
  return useQuery({
    queryKey: ['routes', universityId, onlyActive],
    enabled: Boolean(universityId),
    queryFn: async () => {
      let q = supabase
        .from('routes')
        .select(
          'id, name, direction, departure_time, active_days, notes, is_active, route_stops(id, seq, stop_id, departure_time, name, maps_url, lat, lng, area_id, stop:stops(name, maps_url, lat, lng, area_id))',
        )
        .eq('university_id', universityId as string)
        .order('departure_time', { nullsFirst: false })
        .order('seq', { referencedTable: 'route_stops' });
      if (onlyActive) q = q.eq('is_active', true);
      const rows = unwrap(await q) as unknown as (Omit<RouteRow, 'route_stops'> & { route_stops: RawRouteStop[] })[];
      return rows.map((r) => ({
        ...r,
        route_stops: r.route_stops.map((s) => ({
          id: s.id,
          seq: s.seq,
          stop_id: s.stop_id,
          departure_time: s.departure_time,
          name: s.stop?.name ?? s.name ?? '',
          maps_url: s.stop?.maps_url ?? s.maps_url ?? null,
          lat: s.stop?.lat ?? s.lat ?? null,
          lng: s.stop?.lng ?? s.lng ?? null,
          area_id: s.stop?.area_id ?? s.area_id ?? null,
        })),
      })) as RouteRow[];
    },
  });
}

export type LibraryStop = LibraryStopRef & { id: string; is_active: boolean };

export function useStopLibrary(universityId: string | null | undefined) {
  return useQuery({
    queryKey: ['stops', universityId],
    enabled: Boolean(universityId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('stops')
          .select('id, name, maps_url, lat, lng, area_id, is_active')
          .eq('university_id', universityId as string)
          .order('name'),
      ) as LibraryStop[],
  });
}

/** Outbound routes first, then return routes; a route running both ways is listed in both. */
const ROUTE_GROUPS = ['outbound', 'return'] as const;

/** Map view: pick a route (grouped outbound / return), see its stops and the path on the map. */
function RoutesMapView({ rows, selectedId, onSelect }: { rows: RouteRow[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const pickId = useId();
  const withStops = rows.filter((r) => r.route_stops.length);
  const byTime = (x: RouteRow, y: RouteRow) => (x.departure_time ?? '99').localeCompare(y.departure_time ?? '99') || x.name.localeCompare(y.name, 'ar');
  const route = withStops.find((r) => r.id === selectedId) ?? withStops.sort(byTime)[0];
  if (!route) return <EmptyState title={t.student.noRoutes} />;
  return (
    <div className="space-y-3">
      <Field label={t.routeMap.pickRoute} htmlFor={pickId}>
        <Select id={pickId} value={route.id} onChange={(e) => onSelect(e.target.value)} data-testid="map-route-select">
          {ROUTE_GROUPS.map((group) => (
            <optgroup key={group} label={t.student.routeGroups[group]}>
              {withStops
                .filter((r) => r.direction === group || r.direction === 'both')
                .sort(byTime)
                .map((r) => (
                  <option key={`${group}:${r.id}`} value={r.id}>
                    {r.name}
                    {r.departure_time ? ` — ${formatClock(r.departure_time)}` : ''}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <RouteMap key={route.id} route={route} />
    </div>
  );
}

export function RoutesPage() {
  const { me } = useAuth();
  const query = useRoutes(me?.student?.university_id, true);
  const [stop, setStop] = useState<{ route: RouteRow; stop: StopRow } | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [view, setView] = useState<'list' | 'map'>('list');
  const [mapRouteId, setMapRouteId] = useState<string | null>(null);
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div>
      <PageHeader
        title={t.student.routesTitle}
        actions={
          <div role="tablist" aria-label={t.routeMap.viewMode} className="flex rounded-lg border border-border p-1">
            {(['list', 'map'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn('flex min-h-[36px] items-center gap-1 rounded-md px-3 text-sm font-semibold', view === v ? 'bg-brand-ink text-on-ink' : '')}
                data-testid={`routes-view-${v}`}
              >
                {v === 'list' ? <ListIcon className="h-4 w-4" aria-hidden /> : <MapIcon className="h-4 w-4" aria-hidden />}
                {t.routeMap[v]}
              </button>
            ))}
          </div>
        }
      />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={t.student.noRoutes} />)}>
        {(rows) =>
          view === 'map' ? (
            <RoutesMapView rows={rows} selectedId={mapRouteId} onSelect={setMapRouteId} />
          ) : (
          <div className="space-y-6">
            {ROUTE_GROUPS.map((group) => {
              const list = rows
                .filter((r) => r.direction === group || r.direction === 'both')
                .sort((x, y) => (x.departure_time ?? '99').localeCompare(y.departure_time ?? '99') || x.name.localeCompare(y.name, 'ar'));
              return (
                <section key={group} aria-labelledby={`routes-${group}`} data-testid={`routes-${group}`}>
                  <h2 id={`routes-${group}`} className="mb-2 flex items-center gap-2 text-lg font-extrabold text-brand-ink">
                    {t.student.routeGroups[group]}
                    <Badge>
                      <span className="num">{list.length}</span>
                    </Badge>
                  </h2>
                  {list.length ? (
                    <ul className="space-y-3">
                      {list.map((r) => {
                        const key = `${group}:${r.id}`;
                        return (
                          <li key={key}>
                            <Card className="p-3">
                              <button
                                type="button"
                                className="flex min-h-touch w-full items-center justify-between gap-2 text-start"
                                aria-expanded={openIds.has(key)}
                                onClick={() => toggle(key)}
                                data-testid="route-toggle"
                              >
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="font-bold">{r.name}</span>
                                  <Badge tone="info">{t.admin.routes.directions[r.direction]}</Badge>
                                  {r.departure_time ? (
                                    <span className="num flex items-center gap-1 text-sm font-semibold">
                                      <CalendarClock className="h-4 w-4" aria-hidden />
                                      {formatClock(r.departure_time)}
                                    </span>
                                  ) : null}
                                </span>
                                <ChevronDown
                                  className={cn('h-5 w-5 shrink-0 text-muted transition-transform', openIds.has(key) && 'rotate-180')}
                                  aria-hidden
                                />
                              </button>
                              {!openIds.has(key) ? null : r.notes ? <p className="my-2 text-sm text-muted">{r.notes}</p> : null}
                              {openIds.has(key) && r.route_stops.length ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="my-2"
                                  onClick={() => {
                                    setMapRouteId(r.id);
                                    setView('map');
                                  }}
                                  data-testid="route-show-map"
                                >
                                  <MapIcon className="h-4 w-4" aria-hidden />
                                  {t.routeMap.showOnMap}
                                </Button>
                              ) : null}
                              {!openIds.has(key) ? null : r.route_stops.length ? (
                                <ol className="space-y-1">
                                  {r.route_stops.map((s) => (
                                    <li key={s.id}>
                                      <button
                                        type="button"
                                        className="flex min-h-touch w-full items-center justify-between gap-2 rounded-lg px-2 text-start hover:bg-surface"
                                        onClick={() => setStop({ route: r, stop: s })}
                                        data-testid="stop-button"
                                      >
                                        <span className="flex min-w-0 items-center gap-2">
                                          <MapPinned className="h-5 w-5 shrink-0 text-brand-ink" aria-hidden />
                                          <span className="min-w-0 break-words">{s.name}</span>
                                        </span>
                                        <span className="num shrink-0 font-semibold text-muted">{formatClock(s.departure_time)}</span>
                                      </button>
                                    </li>
                                  ))}
                                </ol>
                              ) : (
                                <p className="text-sm text-muted">{t.student.noStops}</p>
                              )}
                            </Card>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted">{t.student.noRoutesInGroup}</p>
                  )}
                </section>
              );
            })}
          </div>
          )
        }
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
                {d.student.kind && d.student.kind !== 'student' ? (
                  <>
                    <dt className="text-muted">{t.student.jobTitle}</dt>
                    <dd>{d.student.job_title ?? t.student.kind[d.student.kind]}</dd>
                  </>
                ) : (
                  <>
                    <dt className="text-muted">{t.student.college}</dt>
                    <dd>{d.student.college}</dd>
                    <dt className="text-muted">{t.student.universityNo}</dt>
                    <dd className="num">{d.student.university_student_no}</dd>
                  </>
                )}
                {d.student.phone_e164 ? (
                  <>
                    <dt className="text-muted">{t.student.phone}</dt>
                    <dd className="num">{formatPhoneDisplay(d.student.phone_e164)}</dd>
                  </>
                ) : null}
                <dt className="text-muted">{t.student.workDays}</dt>
                <dd>{d.student.work_days.map((w) => t.days[w]).join(t.listSeparator)}</dd>
                {d.student.shift_start ? (
                  <>
                    <dt className="text-muted">{t.student.shiftStart}</dt>
                    <dd className="num">{formatClock(d.student.shift_start)}</dd>
                  </>
                ) : null}
                {d.student.residence_text ? (
                  <>
                    <dt className="text-muted">{t.student.residence}</dt>
                    <dd>{d.student.residence_text}</dd>
                  </>
                ) : null}
                <dt className="text-muted">{t.student.package}</dt>
                <dd>{d.student.kind && d.student.kind !== 'student' ? t.student.unlimited : (d.subscription?.package_name ?? t.common.none)}</dd>
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
