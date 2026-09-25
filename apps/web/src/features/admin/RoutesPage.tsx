import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { formatClock, parseMapsUrl } from '@somar/shared';
import { useRoutes, type RouteRow, type StopRow } from '@/features/student/StudentPages';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, Field, Input, Select, Switch, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { ActiveBadge, DayToggles, useAreas, WithUniversity } from './common';

export default function RoutesPage() {
  return <WithUniversity>{(universityId) => <RoutesBody universityId={universityId} />}</WithUniversity>;
}

type Pending = { apply: () => void } | null;

function RoutesBody({ universityId }: { universityId: string }) {
  const r = t.admin.routes;
  const query = useRoutes(universityId, false);
  const [editingRoute, setEditingRoute] = useState<RouteRow | 'new' | null>(null);
  const [editingStop, setEditingStop] = useState<{ route: RouteRow; stop: StopRow | null } | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['routes', universityId] });

  const move = useMutation({
    mutationFn: async ({ a, b }: { a: StopRow; b: StopRow }) => {
      unwrap(await supabase.from('route_stops').update({ seq: b.seq }).eq('id', a.id));
      unwrap(await supabase.from('route_stops').update({ seq: a.seq }).eq('id', b.id));
    },
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const removeStop = useMutation({
    mutationFn: async (id: string) => unwrap(await supabase.from('route_stops').delete().eq('id', id)),
    onSuccess: invalidate,
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title={r.title}
        actions={
          <Button variant="secondary" onClick={() => setEditingRoute('new')}>
            <Plus className="h-4 w-4" aria-hidden />
            {r.add}
          </Button>
        }
      />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={r.empty} />)}>
        {(rows) => (
          <ul className="space-y-4">
            {rows.map((route) => (
              <li key={route.id}>
                <Card>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-lg font-bold">{route.name}</p>
                      <Badge tone="info">{r.directions[route.direction]}</Badge>
                      {route.departure_time ? <Badge className="num">{formatClock(route.departure_time)}</Badge> : null}
                      <ActiveBadge active={route.is_active} />
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setEditingRoute(route)}>
                        <Pencil className="h-4 w-4" aria-hidden />
                        {t.common.edit}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setEditingStop({ route, stop: null })}>
                        <Plus className="h-4 w-4" aria-hidden />
                        {r.addStop}
                      </Button>
                    </div>
                  </div>
                  {route.active_days?.length ? (
                    <p className="mb-2 text-sm text-muted">
                      {r.activeDays}: {route.active_days.map((d) => t.days[d]).join('، ')}
                    </p>
                  ) : null}
                  {route.route_stops.length ? (
                    <ol className="divide-y divide-border rounded-lg border border-border">
                      {route.route_stops.map((s, i) => (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                          <span className="flex items-center gap-2">
                            <span className="num flex h-7 w-7 items-center justify-center rounded-full bg-surface text-xs font-bold">{i + 1}</span>
                            <span className="font-semibold">{s.name}</span>
                            {s.departure_time ? <span className="num text-muted">{formatClock(s.departure_time)}</span> : null}
                            {s.maps_url ? (
                              <a href={s.maps_url} target="_blank" rel="noopener noreferrer" className="text-brand-ink" aria-label={r.mapsUrl}>
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            ) : null}
                            {s.maps_url && s.lat === null ? <Badge tone="warning">{r.coordsMissing}</Badge> : null}
                          </span>
                          <span className="flex gap-1">
                            <Button size="icon" variant="ghost" aria-label={r.moveUp} disabled={i === 0 || move.isPending}
                              onClick={() => move.mutate({ a: s, b: route.route_stops[i - 1] as StopRow })}>
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" aria-label={r.moveDown} disabled={i === route.route_stops.length - 1 || move.isPending}
                              onClick={() => move.mutate({ a: s, b: route.route_stops[i + 1] as StopRow })}>
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" aria-label={t.common.edit} onClick={() => setEditingStop({ route, stop: s })}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" aria-label={t.common.delete} onClick={() => removeStop.mutate(s.id)}>
                              <Trash2 className="h-4 w-4 text-danger" />
                            </Button>
                          </span>
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
      {editingRoute ? (
        <RouteDialog universityId={universityId} route={editingRoute === 'new' ? null : editingRoute} onClose={() => setEditingRoute(null)} onSaved={invalidate} />
      ) : null}
      {editingStop ? (
        <StopDialog universityId={universityId} route={editingStop.route} stop={editingStop.stop} onClose={() => setEditingStop(null)} onSaved={invalidate} />
      ) : null}
    </div>
  );
}

function TimeChangeConfirm({ pending, onCancel }: { pending: Pending; onCancel: () => void }) {
  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(o) => !o && onCancel()}
      title={t.admin.routes.timeChangeTitle}
      body={t.admin.routes.timeChangeBody}
      onConfirm={() => pending?.apply()}
    />
  );
}

const toTime = (v: string | null | undefined) => (v ? v.slice(0, 5) : '');

function RouteDialog({ universityId, route, onClose, onSaved }: {
  universityId: string;
  route: RouteRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const r = t.admin.routes;
  const toast = useToast();
  const [form, setForm] = useState({
    name: route?.name ?? '',
    direction: route?.direction ?? 'outbound',
    departure_time: toTime(route?.departure_time),
    active_days: route?.active_days ?? [],
    notes: route?.notes ?? '',
    is_active: route?.is_active ?? true,
  });
  const [pending, setPending] = useState<Pending>(null);
  const ids = { name: useId(), dir: useId(), time: useId(), notes: useId() };
  const save = useMutation({
    mutationFn: async () => {
      const row = {
        university_id: universityId,
        name: form.name.trim(),
        direction: form.direction,
        departure_time: form.departure_time || null,
        active_days: form.active_days.length ? form.active_days : null,
        notes: form.notes.trim() || null,
        is_active: form.is_active,
      };
      if (route) unwrap(await supabase.from('routes').update(row).eq('id', route.id));
      else unwrap(await supabase.from('routes').insert(row));
    },
    onSuccess: () => {
      toast.success(t.common.success);
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const timeChanged = route && form.departure_time && form.departure_time !== toTime(route.departure_time);
    if (timeChanged) setPending({ apply: () => save.mutate() });
    else save.mutate();
  };
  return (
    <>
      <Dialog open={pending === null} onOpenChange={(o) => !o && onClose()} title={route ? t.common.edit : r.add}>
        <form className="space-y-4" onSubmit={submit}>
          <Field label={r.name} htmlFor={ids.name}>
            <Input id={ids.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={r.direction} htmlFor={ids.dir}>
              <Select id={ids.dir} value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}>
                {Object.entries(r.directions).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={r.departure} htmlFor={ids.time}>
              <Input id={ids.time} type="time" value={form.departure_time} onChange={(e) => setForm({ ...form, departure_time: e.target.value })} />
            </Field>
          </div>
          <Field label={r.activeDays}>
            <DayToggles value={form.active_days} onChange={(d) => setForm({ ...form, active_days: d })} />
          </Field>
          <Field label={r.notes} htmlFor={ids.notes}>
            <Textarea id={ids.notes} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{t.common.active}</span>
            <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
          </label>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t.common.cancel}</Button>
            <Button type="submit" variant="secondary" disabled={save.isPending}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>
      <TimeChangeConfirm pending={pending} onCancel={() => setPending(null)} />
    </>
  );
}

function StopDialog({ universityId, route, stop, onClose, onSaved }: {
  universityId: string;
  route: RouteRow;
  stop: StopRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const r = t.admin.routes;
  const toast = useToast();
  const areas = useAreas(universityId);
  const [form, setForm] = useState({
    name: stop?.name ?? '',
    maps_url: stop?.maps_url ?? '',
    departure_time: toTime(stop?.departure_time),
    area_id: stop?.area_id ?? '',
  });
  const [pending, setPending] = useState<Pending>(null);
  const ids = { name: useId(), url: useId(), time: useId(), area: useId() };
  const coords = parseMapsUrl(form.maps_url);
  const save = useMutation({
    mutationFn: async () => {
      const row = {
        route_id: route.id,
        name: form.name.trim(),
        maps_url: form.maps_url.trim() || null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        departure_time: form.departure_time || null,
        area_id: form.area_id || null,
      };
      if (stop) unwrap(await supabase.from('route_stops').update(row).eq('id', stop.id));
      else {
        const seq = Math.max(0, ...route.route_stops.map((s) => s.seq)) + 1;
        unwrap(await supabase.from('route_stops').insert({ ...row, seq }));
      }
    },
    onSuccess: () => {
      toast.success(t.common.success);
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const timeChanged = stop && form.departure_time && form.departure_time !== toTime(stop.departure_time);
    if (timeChanged) setPending({ apply: () => save.mutate() });
    else save.mutate();
  };
  return (
    <>
      <Dialog open={pending === null} onOpenChange={(o) => !o && onClose()} title={stop ? t.common.edit : r.addStop} description={route.name}>
        <form className="space-y-4" onSubmit={submit}>
          <Field label={r.stopName} htmlFor={ids.name}>
            <Input id={ids.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field
            label={r.mapsUrl}
            htmlFor={ids.url}
            hint={form.maps_url ? (coords ? `${r.coords}: ${coords.lat}, ${coords.lng}` : r.coordsMissing) : r.mapsHint}
          >
            <Input id={ids.url} dir="ltr" className="text-start" value={form.maps_url} onChange={(e) => setForm({ ...form, maps_url: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={r.departure} htmlFor={ids.time}>
              <Input id={ids.time} type="time" value={form.departure_time} onChange={(e) => setForm({ ...form, departure_time: e.target.value })} />
            </Field>
            <Field label={r.area} htmlFor={ids.area}>
              <Select id={ids.area} value={form.area_id} onChange={(e) => setForm({ ...form, area_id: e.target.value })}>
                <option value="">{t.common.none}</option>
                {(areas.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t.common.cancel}</Button>
            <Button type="submit" variant="secondary" disabled={save.isPending}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>
      <TimeChangeConfirm pending={pending} onCancel={() => setPending(null)} />
    </>
  );
}
