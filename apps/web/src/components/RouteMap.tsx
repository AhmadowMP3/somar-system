import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { formatClock } from '@somar/shared';
import type { RouteRow } from '@/features/student/StudentPages';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type PathResponse = { source: 'road' | 'straight'; points: [number, number][]; stops: number };

const COLORS: Record<string, string> = { outbound: '#2B2F36', return: '#12805C', both: '#B0121D' };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function directionsUrl(stop: RouteRow['route_stops'][number]): string {
  if (stop.maps_url) return stop.maps_url;
  return `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}`;
}

/**
 * One route on a map: numbered stops in riding order and the path the bus takes between them.
 * The path comes from the API (road-following, cached on the server); when road routing is
 * unavailable the stops are joined by straight dashed lines instead.
 */
export function RouteMap({ route, className }: { route: RouteRow; className?: string }) {
  const m = t.routeMap;
  const ref = useRef<HTMLDivElement>(null);
  const stops = [...route.route_stops].sort((a, b) => a.seq - b.seq);
  const located = stops.filter((s) => s.lat != null && s.lng != null);
  const missing = stops.filter((s) => s.lat == null || s.lng == null);
  const stopsKey = located.map((s) => `${s.lat},${s.lng}`).join(';');

  const path = useQuery({
    queryKey: ['route-path', route.id, stopsKey],
    enabled: located.length >= 2,
    queryFn: () => api.get<PathResponse>(`/routes/${route.id}/path`),
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (!ref.current || !located.length) return;
    let disposed = false;
    let cleanup = () => undefined as void;
    void Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([L]) => {
      if (disposed || !ref.current) return;
      const map = L.map(ref.current, { zoomControl: true });
      map.attributionControl.setPrefix(false);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
      const color = COLORS[route.direction] ?? COLORS.outbound;

      const line = path.data?.points.length ? path.data.points : located.map((s) => [Number(s.lat), Number(s.lng)] as [number, number]);
      const straight = !path.data || path.data.source === 'straight';
      if (line.length >= 2) {
        L.polyline(line, { color: '#ffffff', weight: 9, opacity: 0.9 }).addTo(map);
        L.polyline(line, { color, weight: 5, opacity: 0.9, dashArray: straight ? '8 8' : undefined, className: 'route-path' }).addTo(map);
      }

      const bounds: [number, number][] = [...line];
      stops.forEach((s, i) => {
        if (s.lat == null || s.lng == null) return;
        const p: [number, number] = [Number(s.lat), Number(s.lng)];
        bounds.push(p);
        const last = i === stops.length - 1;
        const icon = L.divIcon({
          className: 'route-stop',
          html: `<span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:9999px;background:${i === 0 ? '#12805C' : last ? '#B0121D' : color};color:#fff;font:700 13px/1 system-ui,sans-serif;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)">${i + 1}</span>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        });
        const time = s.departure_time ? ` — <b>${escapeHtml(formatClock(s.departure_time))}</b>` : '';
        L.marker(p, { icon, title: s.name })
          .bindPopup(
            `<div dir="rtl" style="font-family:inherit;text-align:right"><b>${i + 1}. ${escapeHtml(s.name)}</b>${time}<br/>` +
              `<a href="${escapeHtml(directionsUrl(s))}" target="_blank" rel="noopener">${escapeHtml(m.directions)}</a></div>`,
          )
          .addTo(map);
      });
      map.fitBounds(L.latLngBounds(bounds), { padding: [36, 36], maxZoom: 16 });
      cleanup = () => map.remove();
    });
    return () => {
      disposed = true;
      cleanup();
    };
    // re-draw when the route's stops or the computed path change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id, stopsKey, path.data]);

  if (!located.length) return <p className="rounded-lg bg-surface p-4 text-sm text-muted">{m.noLocations}</p>;
  return (
    <div className="space-y-2">
      <div
        ref={ref}
        dir="ltr"
        className={cn('h-[60vh] min-h-[320px] w-full overflow-hidden rounded-xl border border-border', className)}
        role="region"
        aria-label={`${m.title}: ${route.name}`}
        data-testid="route-map"
        data-path-source={path.data?.source ?? (located.length < 2 ? 'straight' : 'loading')}
      />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-success" aria-hidden /> {m.start}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-danger" aria-hidden /> {m.end}
        </span>
        <span>{path.isLoading ? m.loading : path.data?.source === 'road' ? m.road : m.straight}</span>
      </div>
      {missing.length ? (
        <p className="text-xs text-warning" data-testid="route-map-missing">
          {m.missing(missing.map((s) => s.name).join(t.listSeparator))}
        </p>
      ) : null}
    </div>
  );
}
