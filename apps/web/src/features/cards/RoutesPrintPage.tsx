import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Printer } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { damascusDate, formatClock, formatDate } from '@somar/shared';
import { QrSvg } from '@/components/QrCode';
import { Button, Select } from '@/components/ui/primitives';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states';
import { useAreas, WEEK_DAYS } from '@/features/admin/common';
import { useRoutes, type RouteRow, type StopRow } from '@/features/student/StudentPages';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';

/** Brand colours, fixed so the PDF looks the same whatever theme the screen uses. */
const BRAND = { red: '#C1121F', ink: '#2B2F36', silver: '#C9CDD3', zebra: '#F4F5F7', muted: '#5B616B', green: '#12805C' };
const DIRECTION_COLOR: Record<string, string> = { outbound: BRAND.ink, return: BRAND.green, both: BRAND.red };

const PRINT_CSS = `
  @page { size: A4; margin: 12mm 11mm 16mm; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff !important; }
    .routes-sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; width: auto !important; }
    .routes-footer { position: fixed; bottom: -10mm; left: 0; right: 0; }
    .route-break { break-before: page; }
  }
  .route-block { break-inside: avoid; }
  .route-table thead { display: table-header-group; }
  .route-table tr { break-inside: avoid; }
`;

type DirectionFilter = 'all' | 'outbound' | 'return';
type Group = { key: 'outbound' | 'return'; routes: RouteRow[] };

function mapsLink(stop: StopRow): string | null {
  if (stop.maps_url) return stop.maps_url;
  if (stop.lat != null && stop.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`;
  return null;
}

/** «يومياً» when the route runs every day, otherwise the day names in week order. */
function daysLabel(days: number[] | null): string {
  if (!days?.length || days.length === 7) return t.routesPrint.everyDay;
  return WEEK_DAYS.filter((d) => days.includes(d))
    .map((d) => t.days[d])
    .join('، ');
}

/**
 * Every transport route of a university as a branded A4 document: summary, then outbound and return
 * routes with their stops in riding order, times, areas and a QR to each stop's location.
 * «حفظ كملف PDF» in the print dialog produces the file (browsers shape Arabic correctly).
 */
export default function RoutesPrintPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const universityId = params.get('university') ?? '';
  const p = t.routesPrint;
  const ids = { direction: useId() };
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [withInactive, setWithInactive] = useState(false);
  const [withQr, setWithQr] = useState(true);
  const [pagePerRoute, setPagePerRoute] = useState(false);

  const routes = useRoutes(universityId, false);
  const areas = useAreas(universityId);
  const university = useQuery({
    queryKey: ['university-name', universityId],
    enabled: Boolean(universityId),
    queryFn: async () => (unwrap(await supabase.from('universities').select('name').eq('id', universityId).single()) as { name: string }).name,
  });
  const areaName = useMemo(() => new Map((areas.data ?? []).map((a) => [a.id, a.name])), [areas.data]);
  const today = formatDate(damascusDate());

  const shown = useMemo(
    () => (routes.data ?? []).filter((r) => withInactive || r.is_active),
    [routes.data, withInactive],
  );
  // a route running both ways is listed under both, as on the students' routes page
  const groups: Group[] = (['outbound', 'return'] as const)
    .filter((g) => direction === 'all' || direction === g)
    .map((g) => ({ key: g, routes: shown.filter((r) => r.direction === g || r.direction === 'both') }))
    .filter((g) => g.routes.length);
  const listed = new Set(groups.flatMap((g) => g.routes.map((r) => r.id)));
  // every stop has an area of its own name (DECISION 78), so the column only earns its place when some differ
  const showArea = shown.some((r) => r.route_stops.some((st) => st.area_id && areaName.get(st.area_id) && areaName.get(st.area_id) !== st.name));
  const stopCount = new Set(shown.filter((r) => listed.has(r.id)).flatMap((r) => r.route_stops.map((s) => s.stop_id ?? s.name))).size;

  const loading = routes.isLoading || university.isLoading;
  const error = routes.error ?? university.error;

  return (
    <div className="min-h-dvh bg-surface print:bg-white" dir="rtl">
      <style>{PRINT_CSS}</style>
      <div className="no-print sticky top-0 z-10 space-y-3 border-b border-border bg-bg p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            <ArrowRight className="h-4 w-4" aria-hidden />
            {t.common.back}
          </Button>
          <h1 className="text-lg font-extrabold">{p.title}</h1>
          <Button variant="secondary" className="ms-auto" disabled={!groups.length} onClick={() => window.print()} data-testid="routes-print">
            <Printer className="h-4 w-4" aria-hidden />
            {t.roster.savePdf}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label htmlFor={ids.direction} className="flex items-center gap-2">
            {p.direction}
            <Select id={ids.direction} className="w-auto" value={direction} onChange={(e) => setDirection(e.target.value as DirectionFilter)}>
              <option value="all">{p.allDirections}</option>
              <option value="outbound">{t.student.routeGroups.outbound}</option>
              <option value="return">{t.student.routeGroups.return}</option>
            </Select>
          </label>
          {(
            [
              [withQr, setWithQr, p.withQr],
              [withInactive, setWithInactive, p.withInactive],
              [pagePerRoute, setPagePerRoute, p.pagePerRoute],
            ] as const
          ).map(([value, set, label]) => (
            <label key={label} className="flex min-h-touch items-center gap-2">
              <input type="checkbox" className="h-5 w-5 accent-brand-ink" checked={value} onChange={(e) => set(e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted">{t.cards.printHint}</p>
      </div>

      {loading ? (
        <div className="p-6">
          <ListSkeleton rows={4} />
        </div>
      ) : error ? (
        <div className="p-6">
          <ErrorState error={error} onRetry={() => void routes.refetch()} />
        </div>
      ) : !groups.length ? (
        <div className="p-6">
          <EmptyState title={p.empty} />
        </div>
      ) : (
        <div className="flex justify-center p-4 print:block print:p-0">
          <article className="routes-sheet w-[210mm] max-w-full bg-white p-[12mm] text-[10.5pt] shadow-md" style={{ color: BRAND.ink }} data-ready="true">
            <header className="mb-5 flex items-center justify-between gap-4 pb-4" style={{ borderBottom: `3px solid ${BRAND.red}` }}>
              <div className="min-w-0">
                <p className="text-[9pt] font-bold tracking-wide" style={{ color: BRAND.red }}>
                  {t.brand}
                </p>
                <h2 className="mt-1 text-[20pt] font-extrabold leading-tight">{p.title}</h2>
                <p className="mt-1 text-[11pt]">{university.data}</p>
                <p className="mt-1 text-[9pt]" style={{ color: BRAND.muted }}>
                  {t.roster.date}: <span className="num">{today}</span>
                </p>
              </div>
              <img src="/icons/logo.png" alt={t.brand} className="h-[24mm] w-auto shrink-0" />
            </header>

            <dl className="mb-6 grid grid-cols-4 gap-3 text-center">
              {[
                [p.routesCount, listed.size],
                [t.student.routeGroups.outbound, groups.find((g) => g.key === 'outbound')?.routes.length ?? 0],
                [t.student.routeGroups.return, groups.find((g) => g.key === 'return')?.routes.length ?? 0],
                [p.stopsCount, stopCount],
              ].map(([label, n]) => (
                <div key={label} className="rounded-lg px-2 py-3" style={{ background: BRAND.zebra, border: `1px solid ${BRAND.silver}` }}>
                  <dd className="num text-[18pt] font-extrabold leading-none" style={{ color: BRAND.red }}>
                    {n}
                  </dd>
                  <dt className="mt-1 text-[9pt] font-semibold" style={{ color: BRAND.muted }}>
                    {label}
                  </dt>
                </div>
              ))}
            </dl>

            {groups.map((group, gi) => (
              <section key={group.key} className={gi > 0 ? 'route-break pt-2' : undefined}>
                <h3
                  className="mb-4 rounded-md px-4 py-2 text-[14pt] font-extrabold text-white"
                  style={{ background: group.key === 'outbound' ? BRAND.ink : BRAND.green }}
                >
                  {t.student.routeGroups[group.key]} <span className="num text-[10pt] font-semibold opacity-80">({group.routes.length})</span>
                </h3>
                <div className="space-y-5">
                  {group.routes.map((route, ri) => (
                    <RouteBlock
                      key={route.id}
                      route={route}
                      areaName={areaName}
                      withQr={withQr}
                      showArea={showArea}
                      breakBefore={pagePerRoute && ri > 0}
                    />
                  ))}
                </div>
              </section>
            ))}

            <footer
              className="routes-footer mt-6 flex justify-between px-[11mm] pt-2 text-[8pt] print:px-0"
              style={{ borderTop: `1px solid ${BRAND.silver}`, color: BRAND.muted, background: '#fff' }}
            >
              <span>
                {t.brand} · {university.data}
              </span>
              <span className="num">{today}</span>
            </footer>
          </article>
        </div>
      )}
    </div>
  );
}

function RouteBlock({
  route,
  areaName,
  withQr,
  showArea,
  breakBefore,
}: {
  route: RouteRow;
  areaName: Map<string, string>;
  withQr: boolean;
  showArea: boolean;
  breakBefore: boolean;
}) {
  const p = t.routesPrint;
  const color = DIRECTION_COLOR[route.direction] ?? BRAND.ink;
  const stops = [...route.route_stops].sort((a, b) => a.seq - b.seq);
  return (
    <div
      className={`route-block overflow-hidden rounded-lg${breakBefore ? ' route-break' : ''}`}
      style={{ border: `1px solid ${BRAND.silver}`, borderInlineStart: `5px solid ${color}` }}
      data-testid="routes-print-route"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 px-4 py-3" style={{ background: BRAND.zebra }}>
        <div className="min-w-0">
          <p className="text-[13pt] font-extrabold leading-tight">
            {route.name}
            {!route.is_active ? (
              <span className="ms-2 rounded px-1.5 py-0.5 text-[8pt] font-bold text-white" style={{ background: BRAND.muted }}>
                {t.common.inactive}
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-[9pt]" style={{ color: BRAND.muted }}>
            {p.days}: {daysLabel(route.active_days)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[9pt] font-bold">
          <span className="rounded-full px-2.5 py-1 text-white" style={{ background: color }}>
            {t.admin.routes.directions[route.direction]}
          </span>
          {route.departure_time ? (
            <span className="num rounded-full px-2.5 py-1" style={{ border: `1px solid ${color}`, color }}>
              {p.departure}: {formatClock(route.departure_time)}
            </span>
          ) : null}
          <span className="rounded-full px-2.5 py-1" style={{ border: `1px solid ${BRAND.silver}` }}>
            {t.admin.routes.stopCount(stops.length)}
          </span>
        </div>
      </div>

      {stops.length ? (
        <table className="route-table w-full border-collapse text-start">
          <thead>
            <tr className="text-[8.5pt]" style={{ color: BRAND.muted, borderBottom: `1px solid ${BRAND.silver}` }}>
              <th className="w-[12mm] px-2 py-1.5 text-center font-bold">#</th>
              <th className="px-2 py-1.5 text-start font-bold">{p.stop}</th>
              {showArea ? <th className="px-2 py-1.5 text-start font-bold">{t.admin.routes.area}</th> : null}
              <th className="w-[22mm] px-2 py-1.5 text-center font-bold">{p.time}</th>
              {withQr ? <th className="w-[20mm] px-2 py-1.5 text-center font-bold">{p.location}</th> : null}
            </tr>
          </thead>
          <tbody>
            {stops.map((stop, i) => {
              const link = mapsLink(stop);
              const area = stop.area_id ? areaName.get(stop.area_id) : undefined;
              return (
                <tr key={stop.id} style={{ background: i % 2 ? BRAND.zebra : '#fff', borderBottom: `1px solid ${BRAND.silver}` }}>
                  <td className="px-2 py-1.5 text-center">
                    <span
                      className="num inline-flex h-[6.5mm] w-[6.5mm] items-center justify-center rounded-full text-[8.5pt] font-bold text-white"
                      style={{ background: color }}
                    >
                      {i + 1}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-semibold">{stop.name}</td>
                  {showArea ? (
                    <td className="px-2 py-1.5 text-[9pt]" style={{ color: BRAND.muted }}>
                      {area && area !== stop.name ? area : '—'}
                    </td>
                  ) : null}
                  <td className="num px-2 py-1.5 text-center font-bold">{stop.departure_time ? formatClock(stop.departure_time) : '—'}</td>
                  {withQr ? (
                    <td className="px-2 py-1 text-center">
                      {link ? <QrSvg value={link} className="mx-auto h-[15mm] w-[15mm]" label={`${p.location} ${stop.name}`} /> : '—'}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="px-4 py-3 text-[9pt]" style={{ color: BRAND.muted }}>
          {p.noStops}
        </p>
      )}

      {route.notes ? (
        <p className="px-4 py-2 text-[9pt]" style={{ borderTop: `1px solid ${BRAND.silver}` }}>
          <span className="font-bold">{t.admin.routes.notes}: </span>
          {route.notes}
        </p>
      ) : null}
    </div>
  );
}
