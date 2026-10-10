import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Printer } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { damascusDate, formatClock, formatDate } from '@somar/shared';
import { Button, Select } from '@/components/ui/primitives';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states';
import { WEEK_DAYS } from '@/features/admin/common';
import { useRoutes, type RouteRow } from '@/features/student/StudentPages';
import { t } from '@/i18n/ar';
import { supabase, unwrap } from '@/lib/supabase';

/** Brand colours, fixed so the PDF looks the same whatever theme the screen uses. */
const BRAND = { red: '#B5121B', ink: '#2B2F36', silver: '#C9CDD3', zebra: '#F4F5F7', muted: '#5B616B' };
/** Outbound tables are crimson, return tables green (header, row labels, label background). */
const TONE = {
  outbound: { head: BRAND.red, label: BRAND.red, labelBg: '#FBE9EA', bar: BRAND.ink },
  return: { head: '#137F5B', label: '#137F5B', labelBg: '#E6F4EE', bar: '#137F5B' },
} as const;

const PRINT_CSS = `
  @page {
    size: A4 landscape;
    margin: 10mm 10mm 14mm;
    @bottom-left { content: "صفحة " counter(page) " من " counter(pages); font-size: 7.5pt; color: #5B616B; }
  }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; background: #fff !important; }
    .timetable-sheet { box-shadow: none !important; margin: 0 !important; padding: 0 !important; width: auto !important; }
  }
  .line-card { break-inside: avoid; }
  .section-bar { break-after: avoid; }
`;

type DirectionFilter = 'all' | 'outbound' | 'return';
type Direction = 'outbound' | 'return';
/** One line: routes of the same direction riding the same stops in the same order; each route is a trip (a table row). */
type Line = { key: string; title: string; stops: string[]; trips: RouteRow[]; notes: string[]; days: number[] | null };

const ORDINALS = ['الأولى', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة'];
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const arabicNumber = (n: number) => String(n).replace(/\d/g, (d) => ARABIC_DIGITS[Number(d)] ?? d);

const sortedStops = (route: RouteRow) => [...route.route_stops].sort((a, b) => a.seq - b.seq);
const byDeparture = (a: RouteRow, b: RouteRow) =>
  (a.departure_time ?? '99').localeCompare(b.departure_time ?? '99') || a.name.localeCompare(b.name, 'ar');

// not \b: in JS it is an ASCII word boundary and never matches next to Arabic letters
const TRIP_PART = /^الرحلة(\s|$)/;
const nameParts = (name: string) => name.split(/\s+[—–-]\s+/).map((p) => p.trim());

/** «الخط 1 — الرحلة الأولى» → «الخط رقم ١»: the trip part of a route's name names the row, not the line. */
function lineName(name: string): string {
  const parts = nameParts(name).filter((p) => !TRIP_PART.test(p));
  const line = (parts.length ? parts.join(' — ') : name).trim();
  const numbered = /^الخط\s+(\d+)$/.exec(line);
  return numbered ? `${t.routesPrint.lineNumber} ${arabicNumber(Number(numbered[1]))}` : line;
}

/** The row label: the trip named in the route's name (« — الرحلة الثالثة»), else by order in the line. */
function tripLabel(route: RouteRow, index: number, direction: Direction): string {
  const named = nameParts(route.name).find((p) => TRIP_PART.test(p));
  if (named) return named;
  if (direction === 'return') return t.routesPrint.returnTrip;
  return `الرحلة ${ORDINALS[index] ?? arabicNumber(index + 1)}`;
}

/** «HH:MM» on the 24-hour clock, the way the printed timetable is read. */
const hhmm = (time: string | null) => (time ? time.slice(0, 5) : '—');

const everyDay = (days: number[] | null) => !days?.length || days.length === 7;

function daysLabel(days: number[] | null): string {
  if (everyDay(days)) return t.routesPrint.everyDay;
  return WEEK_DAYS.filter((d) => days?.includes(d))
    .map((d) => t.days[d])
    .join('، ');
}

function buildLines(routes: RouteRow[]): Line[] {
  const groups = new Map<string, RouteRow[]>();
  for (const route of [...routes].sort(byDeparture)) {
    const stops = sortedStops(route);
    if (!stops.length) continue;
    const key = stops.map((s) => s.stop_id ?? s.name).join('|');
    groups.set(key, [...(groups.get(key) ?? []), route]);
  }
  const lines = [...groups.entries()].map(([key, trips]) => {
    const names = [...new Set(trips.map((r) => lineName(r.name)))];
    return {
      key,
      title: names.length === 1 ? (names[0] as string) : '',
      stops: sortedStops(trips[0] as RouteRow).map((s) => s.name),
      trips,
      notes: [...new Set(trips.map((r) => r.notes?.trim()).filter((n): n is string => Boolean(n)))],
      days: trips[0]?.active_days ?? null,
    };
  });
  // a line whose trips carry different names gets a number instead
  let untitled = 0;
  return lines.map((line) => (line.title ? line : { ...line, title: `${t.routesPrint.lineNumber} ${arabicNumber(++untitled)}` }));
}

/**
 * The bus timetable as a branded A4 landscape document, like the owner's printed schedule: one table per line,
 * the stops across, one row per trip with each stop's time; outbound tables in crimson, return tables in green.
 * «حفظ كملف PDF» in the print dialog produces the file (browsers shape Arabic correctly).
 */
export default function RoutesPrintPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const universityId = params.get('university') ?? '';
  const p = t.routesPrint;
  const directionId = useId();
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [withInactive, setWithInactive] = useState(false);

  const routes = useRoutes(universityId, false);
  const university = useQuery({
    queryKey: ['university-name', universityId],
    enabled: Boolean(universityId),
    queryFn: async () => (unwrap(await supabase.from('universities').select('name').eq('id', universityId).single()) as { name: string }).name,
  });
  const today = formatDate(damascusDate());

  // a route running both ways is listed under both, as on the students' routes page
  const sections = useMemo(() => {
    const shown = (routes.data ?? []).filter((r) => withInactive || r.is_active);
    return (['outbound', 'return'] as const)
      .filter((d) => direction === 'all' || direction === d)
      .map((d) => {
        const lines = buildLines(shown.filter((r) => r.direction === d || r.direction === 'both'));
        return { direction: d, lines, allDaily: lines.every((l) => everyDay(l.days)) };
      })
      .filter((s) => s.lines.length);
  }, [routes.data, withInactive, direction]);

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
          <Button variant="secondary" className="ms-auto" disabled={!sections.length} onClick={() => window.print()} data-testid="routes-print">
            <Printer className="h-4 w-4" aria-hidden />
            {t.roster.savePdf}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label htmlFor={directionId} className="flex items-center gap-2">
            {p.direction}
            <Select id={directionId} className="w-auto" value={direction} onChange={(e) => setDirection(e.target.value as DirectionFilter)}>
              <option value="all">{p.allDirections}</option>
              <option value="outbound">{t.student.routeGroups.outbound}</option>
              <option value="return">{t.student.routeGroups.return}</option>
            </Select>
          </label>
          <label className="flex min-h-touch items-center gap-2">
            <input type="checkbox" className="h-5 w-5 accent-brand-ink" checked={withInactive} onChange={(e) => setWithInactive(e.target.checked)} />
            {p.withInactive}
          </label>
        </div>
        <p className="text-xs text-muted">{p.printHint}</p>
      </div>

      {loading ? (
        <div className="p-6">
          <ListSkeleton rows={4} />
        </div>
      ) : error ? (
        <div className="p-6">
          <ErrorState error={error} onRetry={() => void routes.refetch()} />
        </div>
      ) : !sections.length ? (
        <div className="p-6">
          <EmptyState title={p.empty} />
        </div>
      ) : (
        <div className="flex justify-center p-4 print:block print:p-0">
          <article
            className="timetable-sheet w-[297mm] max-w-full bg-white p-[10mm] text-[9pt] shadow-md"
            style={{ color: BRAND.ink }}
            data-ready="true"
          >
            <header className="mb-4 flex items-center justify-between gap-4 pb-3" style={{ borderBottom: `3px solid ${BRAND.red}` }}>
              <div className="min-w-0">
                <p className="text-[10pt] font-bold" style={{ color: BRAND.red }}>
                  {t.brand}
                </p>
                <h2 className="mt-0.5 text-[20pt] font-extrabold leading-tight">{p.title}</h2>
                <p className="mt-1 text-[9.5pt]" style={{ color: BRAND.muted }}>
                  {university.data} · {t.roster.date}: <span className="num">{today}</span>
                </p>
              </div>
              <img src="/icons/logo.png" alt={t.brand} className="h-[22mm] w-auto shrink-0" />
            </header>

            {sections.map((section) => (
              <section key={section.direction} className="mb-4">
                <h3
                  className="section-bar mb-3 rounded-lg px-4 py-2 text-[13pt] font-extrabold text-white"
                  style={{ background: TONE[section.direction].bar }}
                >
                  {t.student.routeGroups[section.direction]}
                </h3>
                {section.direction === 'return' && section.allDaily ? (
                  <p
                    className="mb-3 rounded-lg px-4 py-2 text-center text-[9pt] font-bold"
                    style={{ background: '#FDF6E3', border: '1px solid #EAD9A6', color: '#7A5B00' }}
                  >
                    {p.daysNote}: {p.everyDay}
                  </p>
                ) : null}
                <div className="space-y-3">
                  {section.lines.map((line) => (
                    <LineTable key={line.key} line={line} direction={section.direction} showDays={!everyDay(line.days)} />
                  ))}
                </div>
              </section>
            ))}
          </article>
        </div>
      )}
    </div>
  );
}

function LineTable({ line, direction, showDays }: { line: Line; direction: Direction; showDays: boolean }) {
  const p = t.routesPrint;
  const tone = TONE[direction];
  const cell = { border: `1px solid ${BRAND.silver}` };
  // return routes print their departure in the title: their stops usually have no times
  const departure = direction === 'return' && line.trips.length === 1 ? line.trips[0]?.departure_time : null;
  return (
    <div className="line-card overflow-hidden rounded-lg" style={{ border: `1px solid ${BRAND.silver}` }} data-testid="routes-print-line">
      <div className="flex flex-wrap items-center justify-center gap-2 px-3 py-1.5 text-white" style={{ background: tone.head }}>
        <span className="text-[11pt] font-extrabold">{line.title}</span>
        {departure ? (
          <span className="num rounded-full bg-white px-2.5 py-0.5 text-[8.5pt] font-bold" style={{ color: tone.head }}>
            {p.departure}: {formatClock(departure)}
          </span>
        ) : null}
        {showDays ? <span className="text-[8.5pt] font-semibold opacity-90">· {daysLabel(line.days)}</span> : null}
      </div>
      <table className="w-full table-fixed border-collapse text-center">
        <thead>
          <tr style={{ background: BRAND.ink, color: '#fff' }}>
            <th className="w-[22mm] px-1 py-1.5 text-[8.5pt] font-bold" style={cell}>
              {p.trip}
            </th>
            {line.stops.map((name, i) => (
              <th key={`${name}-${i}`} className="px-1 py-1.5 text-[8pt] font-bold leading-tight" style={cell}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {line.trips.map((trip, ti) => {
            const stops = sortedStops(trip);
            return (
              <tr key={trip.id} style={{ background: ti % 2 ? BRAND.zebra : '#fff' }}>
                <th scope="row" className="px-1 py-1.5 text-[9pt] font-extrabold" style={{ ...cell, background: tone.labelBg, color: tone.label }}>
                  {tripLabel(trip, ti, direction)}
                  {!trip.is_active ? <span className="block text-[7pt] font-semibold" style={{ color: BRAND.muted }}>({t.common.inactive})</span> : null}
                </th>
                {line.stops.map((_, si) => (
                  <td key={si} className="num px-1 py-1.5 text-[9.5pt] font-bold" style={cell} dir="ltr">
                    {hhmm(stops[si]?.departure_time ?? null)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {line.notes.length ? (
        <p className="px-3 py-1.5 text-start text-[8.5pt]" style={{ background: '#FAFAFA', borderTop: `1px solid ${BRAND.silver}` }}>
          {line.notes.join(' · ')}
        </p>
      ) : null}
    </div>
  );
}
