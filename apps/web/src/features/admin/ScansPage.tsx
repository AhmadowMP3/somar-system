import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, List, Map as MapIcon, MapPin, XCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { damascusDate, formatDateTime } from '@somar/shared';
import { DirectionBadge } from '@/components/common';
import { Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { exportSheet } from '@/lib/exportSheet';
import { supabase, unwrap } from '@/lib/supabase';
import { useColleges, WithUniversity } from './common';

type ScanLogRow = {
  id: string;
  scanned_at: string;
  service_date: string;
  direction: string;
  method: string;
  lat: number | null;
  lng: number | null;
  accuracy_m: number | null;
  geo_denied: boolean;
  offday_override: boolean;
  override_reason: string | null;
  remaining_after: number;
  cancelled_at: string | null;
  cancel_reason: string | null;
  student: { full_name: string; transport_number: string; college_id: string; colleges: { name: string } | null } | null;
  supervisor: { full_name: string; login_code: string } | null;
};

export default function ScansPage() {
  return <WithUniversity>{(universityId) => <ScansBody universityId={universityId} />}</WithUniversity>;
}

function ScansBody({ universityId }: { universityId: string }) {
  const sc = t.admin.scans;
  const today = damascusDate();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [supervisor, setSupervisor] = useState('');
  const [college, setCollege] = useState('');
  const [direction, setDirection] = useState('');
  const [overrideOnly, setOverrideOnly] = useState(false);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [cancelling, setCancelling] = useState<ScanLogRow | null>(null);
  const colleges = useColleges(universityId);
  const ids = { from: useId(), to: useId(), sup: useId(), col: useId(), dir: useId() };

  const supervisors = useQuery({
    queryKey: ['scan-supervisors', universityId],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('profiles')
          .select('id, full_name, login_code')
          .or(`university_id.eq.${universityId},role.eq.admin`)
          .in('role', ['admin', 'university_supervisor', 'supervisor'])
          .order('full_name'),
      ) as { id: string; full_name: string; login_code: string }[],
  });

  const query = useQuery({
    queryKey: ['scan-log', universityId, from, to, supervisor, college, direction, overrideOnly],
    queryFn: async () => {
      let q = supabase
        .from('scans')
        .select(
          'id, scanned_at, service_date, direction, method, lat, lng, accuracy_m, geo_denied, offday_override, override_reason, remaining_after, cancelled_at, cancel_reason, student:students!inner(full_name, transport_number, college_id, colleges(name)), supervisor:profiles!scans_supervisor_id_fkey(full_name, login_code)',
        )
        .eq('university_id', universityId)
        .gte('service_date', from)
        .lte('service_date', to)
        .order('scanned_at', { ascending: false })
        .limit(1000);
      if (supervisor) q = q.eq('supervisor_id', supervisor);
      if (college) q = q.eq('student.college_id', college);
      if (direction) q = q.eq('direction', direction);
      if (overrideOnly) q = q.eq('offday_override', true);
      return unwrap(await q) as unknown as ScanLogRow[];
    },
  });

  const exportRows = () =>
    exportSheet(
      `${sc.exportName}-${from}-${to}`,
      (query.data ?? []).map((r) => ({
        [t.common.date]: formatDateTime(r.scanned_at),
        [t.student.transportNumber]: r.student?.transport_number ?? '',
        [sc.student]: r.student?.full_name ?? '',
        [t.student.college]: r.student?.colleges?.name ?? '',
        [sc.supervisor]: r.supervisor?.full_name ?? '',
        [sc.direction]: r.direction === 'outbound' ? t.student.outbound : t.student.return,
        [sc.method]: sc.methods[r.method] ?? r.method,
        [sc.override]: r.offday_override ? r.override_reason ?? t.common.yes : '',
        [sc.remainingAfter]: r.remaining_after,
        [sc.lat]: r.lat ?? '',
        [sc.lng]: r.lng ?? '',
        [sc.cancelled]: r.cancelled_at ? r.cancel_reason ?? t.common.yes : '',
      })),
    );

  return (
    <div className="space-y-4">
      <PageHeader
        title={sc.title}
        actions={
          <>
            <Button size="sm" onClick={() => setView(view === 'list' ? 'map' : 'list')}>
              {view === 'list' ? <MapIcon className="h-4 w-4" aria-hidden /> : <List className="h-4 w-4" aria-hidden />}
              {view === 'list' ? sc.mapView : sc.listView}
            </Button>
            <Button size="sm" variant="secondary" onClick={exportRows} disabled={!query.data?.length}>
              <Download className="h-4 w-4" aria-hidden />
              {t.common.export}
            </Button>
          </>
        }
      />
      <Card className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Field label={t.common.from} htmlFor={ids.from}>
          <Input id={ids.from} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={t.common.to} htmlFor={ids.to}>
          <Input id={ids.to} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label={sc.supervisor} htmlFor={ids.sup}>
          <Select id={ids.sup} value={supervisor} onChange={(e) => setSupervisor(e.target.value)}>
            <option value="">{t.common.all}</option>
            {(supervisors.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.student.college} htmlFor={ids.col}>
          <Select id={ids.col} value={college} onChange={(e) => setCollege(e.target.value)}>
            <option value="">{t.common.all}</option>
            {(colleges.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={sc.direction} htmlFor={ids.dir}>
          <Select id={ids.dir} value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="">{t.common.all}</option>
            <option value="outbound">{t.student.outbound}</option>
            <option value="return">{t.student.return}</option>
          </Select>
        </Field>
        <label className="flex items-end gap-2 pb-3 text-sm font-semibold">
          <input type="checkbox" className="h-5 w-5" checked={overrideOnly} onChange={(e) => setOverrideOnly(e.target.checked)} />
          {sc.overrideOnly}
        </label>
      </Card>
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={sc.empty} />)}>
        {(rows) =>
          view === 'map' ? (
            <ScanMap rows={rows.filter((r) => r.lat !== null && r.lng !== null && !r.cancelled_at)} />
          ) : (
            <DataList
              rows={rows}
              rowKey={(r) => r.id}
              cardTitle={(r) => (
                <span className="flex items-center justify-between gap-2">
                  <span>{r.student?.full_name}</span>
                  <DirectionBadge direction={r.direction} />
                </span>
              )}
              columns={[
                { key: 'time', header: t.common.time, cell: (r) => <span className="num">{formatDateTime(r.scanned_at)}</span> },
                {
                  key: 'student',
                  header: sc.student,
                  mobileHidden: true,
                  cell: (r) => (
                    <span>
                      {r.student?.full_name}
                      <span className="num block font-mono text-xs text-muted">{r.student?.transport_number}</span>
                    </span>
                  ),
                },
                { key: 'supervisor', header: sc.supervisor, cell: (r) => r.supervisor?.full_name ?? t.common.none },
                { key: 'dir', header: sc.direction, cell: (r) => <DirectionBadge direction={r.direction} />, mobileHidden: true },
                { key: 'method', header: sc.method, cell: (r) => sc.methods[r.method] ?? r.method },
                {
                  key: 'flags',
                  header: t.common.status,
                  cell: (r) => (
                    <span className="flex flex-wrap gap-1">
                      {r.offday_override ? <Badge tone="warning" title={r.override_reason ?? undefined}>{sc.override}</Badge> : null}
                      {r.cancelled_at ? <Badge tone="danger" title={r.cancel_reason ?? undefined}>{sc.cancelled}</Badge> : null}
                      <Badge>
                        <span className="num">{r.remaining_after}</span>
                      </Badge>
                    </span>
                  ),
                },
                {
                  key: 'loc',
                  header: sc.location,
                  cell: (r) =>
                    r.lat !== null && r.lng !== null ? (
                      <a
                        className="inline-flex items-center gap-1 text-brand-ink underline"
                        href={`https://www.google.com/maps?q=${r.lat},${r.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <MapPin className="h-4 w-4" aria-hidden />
                        {sc.openMap}
                      </a>
                    ) : (
                      <span className="text-muted">{r.geo_denied ? sc.geoDenied : sc.noLocation}</span>
                    ),
                },
                {
                  key: 'actions',
                  header: t.common.actions,
                  cell: (r) =>
                    r.cancelled_at ? null : (
                      <Button size="sm" onClick={() => setCancelling(r)}>
                        <XCircle className="h-4 w-4" aria-hidden />
                        {sc.cancel}
                      </Button>
                    ),
                },
              ]}
            />
          )
        }
      </QueryState>
      {cancelling ? <CancelDialog row={cancelling} onClose={() => setCancelling(null)} /> : null}
    </div>
  );
}

function CancelDialog({ row, onClose }: { row: ScanLogRow; onClose: () => void }) {
  const sc = t.admin.scans;
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const id = useId();
  const run = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('cancel_scan', { p_scan_id: row.id, p_reason: reason.trim() })),
    onSuccess: () => {
      toast.success(sc.cancelDone);
      void qc.invalidateQueries({ queryKey: ['scan-log'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={sc.cancelTitle} description={sc.cancelBody}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim()) run.mutate();
        }}
      >
        <p className="text-sm">
          {row.student?.full_name} · <DirectionBadge direction={row.direction} /> · <span className="num">{formatDateTime(row.scanned_at)}</span>
        </p>
        <Field label={sc.cancelReason} htmlFor={id}>
          <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Field>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="danger" disabled={!reason.trim() || run.isPending}>
            {sc.cancel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ScanMap({ rows }: { rows: ScanLogRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current || !rows.length) return;
    let disposed = false;
    let cleanup = () => undefined as void;
    void Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]).then(([L]) => {
      if (disposed || !ref.current) return;
      const map = L.map(ref.current);
      map.attributionControl.setPrefix(false);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
      }).addTo(map);
      const points: [number, number][] = [];
      for (const r of rows) {
        const p: [number, number] = [Number(r.lat), Number(r.lng)];
        points.push(p);
        L.circleMarker(p, {
          radius: 7,
          color: r.direction === 'outbound' ? '#2B2F36' : '#12805C',
          fillOpacity: 0.8,
        })
          .bindPopup(`${r.student?.full_name ?? ''}<br/>${formatDateTime(r.scanned_at)}`)
          .addTo(map);
      }
      map.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 16 });
      cleanup = () => map.remove();
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [rows]);
  if (!rows.length) return <EmptyState title={t.admin.scans.mapEmpty} />;
  return <div ref={ref} className="h-[60vh] w-full overflow-hidden rounded-xl border border-border" role="region" aria-label={t.admin.scans.mapView} />;
}
