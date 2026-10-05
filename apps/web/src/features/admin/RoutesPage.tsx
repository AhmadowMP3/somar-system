import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, Copy, CopyPlus, ExternalLink, Map as MapIcon, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { formatClock } from '@somar/shared';
import { Link } from 'react-router-dom';
import { useRoutes, useStopLibrary, type RouteRow, type StopRow } from '@/features/student/StudentPages';
import { RouteMap } from '@/components/RouteMap';
import { SearchPicker } from '@/components/SearchPicker';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, Field, Input, Select, Switch, Textarea } from '@/components/ui/primitives';
import { TimeInput12 } from '@/components/ui/TimeInput12';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { supabase, unwrap } from '@/lib/supabase';
import { ActiveBadge, DayToggles, WithUniversity } from './common';

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
  const [copyingStop, setCopyingStop] = useState<{ route: RouteRow; stop: StopRow } | null>(null);
  const [deletingRoute, setDeletingRoute] = useState<RouteRow | null>(null);
  // its stops on the route and the cached map path go with it; the stop library is kept
  const removeRoute = useMutation({
    mutationFn: async (route: RouteRow) => unwrap(await supabase.from('routes').delete().eq('id', route.id).select('id')),
    onSuccess: (rows) => {
      if (!(rows as unknown[] | null)?.length) {
        toast.error(t.errors.FORBIDDEN ?? '');
        return;
      }
      toast.success(r.deleted);
      setDeletingRoute(null);
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [mapRoute, setMapRoute] = useState<RouteRow | null>(null);
  const toggle = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const duplicate = useMutation({
    mutationFn: async (route: RouteRow) =>
      unwrap(await supabase.rpc('duplicate_route', { p_route_id: route.id, p_name: `${route.name}${r.copySuffix}` })) as string,
    onSuccess: async (newId) => {
      toast.success(r.duplicated);
      const fresh = await query.refetch();
      const copy = fresh.data?.find((x) => x.id === newId);
      setOpenIds((prev) => new Set(prev).add(newId));
      if (copy) setEditingRoute(copy);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader
        title={r.title}
        actions={
          <>
            <Button asChild>
              <Link to="/admin/stops">{r.manageStops}</Link>
            </Button>
            <Button variant="secondary" onClick={() => setEditingRoute('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              {r.add}
            </Button>
          </>
        }
      />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={r.empty} />)}>
        {(rows) => (
          <ul className="space-y-4">
            {rows.map((route) => (
              <li key={route.id}>
                <Card>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-2 text-start"
                    aria-expanded={openIds.has(route.id)}
                    onClick={() => toggle(route.id)}
                    data-testid="route-toggle"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-bold">{route.name}</span>
                      <Badge tone="info">{r.directions[route.direction]}</Badge>
                      {route.departure_time ? <Badge className="num">{formatClock(route.departure_time)}</Badge> : null}
                      <Badge>{r.stopCount(route.route_stops.length)}</Badge>
                      <ActiveBadge active={route.is_active} />
                    </span>
                    <ChevronDown className={cn('h-5 w-5 shrink-0 transition-transform', openIds.has(route.id) && 'rotate-180')} aria-hidden />
                  </button>
                  {openIds.has(route.id) ? (
                    <div className="mt-3 space-y-3">
                      <div className="flex flex-wrap gap-3">
                        <Button size="sm" onClick={() => setEditingRoute(route)}>
                          <Pencil className="h-4 w-4" aria-hidden />
                          {t.common.edit}
                        </Button>
                        <Button size="sm" onClick={() => duplicate.mutate(route)} disabled={duplicate.isPending} data-testid={`duplicate-${route.id}`}>
                          <Copy className="h-4 w-4" aria-hidden />
                          {r.duplicate}
                        </Button>
                        {route.route_stops.length ? (
                          <Button size="sm" onClick={() => setMapRoute(route)} data-testid="admin-route-map">
                            <MapIcon className="h-4 w-4" aria-hidden />
                            {t.routeMap.map}
                          </Button>
                        ) : null}
                        <Button size="sm" onClick={() => setDeletingRoute(route)} data-testid={`delete-route-${route.id}`}>
                          <Trash2 className="h-4 w-4 text-danger" aria-hidden />
                          {r.delete}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setEditingStop({ route, stop: null })}>
                          <Plus className="h-4 w-4" aria-hidden />
                          {r.addStop}
                        </Button>
                      </div>
                  {route.active_days?.length ? (
                    <p className="mb-2 text-sm text-muted">
                      {r.activeDays}: {route.active_days.map((d) => t.days[d]).join(t.listSeparator)}
                    </p>
                  ) : null}
                  {route.route_stops.length ? (
                    <ol className="divide-y divide-border rounded-lg border border-border">
                      {route.route_stops.map((s, i) => (
                        <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-base">
                          <span className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="num flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface text-sm font-bold">{i + 1}</span>
                            <span className="min-w-0 break-words font-semibold">{s.name}</span>
                            {s.departure_time ? <span className="num text-muted">{formatClock(s.departure_time)}</span> : null}
                            {s.maps_url ? (
                              <a href={s.maps_url} target="_blank" rel="noopener noreferrer" className="text-brand-ink" aria-label={r.mapsUrl}>
                                <ExternalLink className="h-4 w-4" />
                              </a>
                            ) : null}
                            {s.maps_url && s.lat === null ? <Badge tone="warning">{r.coordsMissing}</Badge> : null}
                          </span>
                          <span className="flex shrink-0 flex-wrap gap-2">
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
                            <Button size="icon" variant="ghost" aria-label={r.copyStop} title={r.copyStop} onClick={() => setCopyingStop({ route, stop: s })} data-testid="copy-stop">
                              <CopyPlus className="h-4 w-4" />
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
                    </div>
                  ) : null}
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
      <Dialog
        open={mapRoute !== null}
        onOpenChange={(o) => (o ? undefined : setMapRoute(null))}
        title={t.routeMap.title}
        description={mapRoute?.name}
        className="sm:max-w-3xl"
      >
        {mapRoute ? <RouteMap route={mapRoute} /> : null}
      </Dialog>
      {deletingRoute ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setDeletingRoute(null)}
          title={r.deleteTitle(deletingRoute.name)}
          body={r.deleteConfirm}
          danger
          busy={removeRoute.isPending}
          onConfirm={() => removeRoute.mutate(deletingRoute)}
        />
      ) : null}
      {copyingStop ? (
        <CopyStopDialog
          source={copyingStop.route}
          stop={copyingStop.stop}
          routes={query.data ?? []}
          onClose={() => setCopyingStop(null)}
          onSaved={invalidate}
        />
      ) : null}
    </div>
  );
}

function CopyStopDialog({ source, stop, routes, onClose, onSaved }: {
  source: RouteRow;
  stop: StopRow;
  routes: RouteRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const r = t.admin.routes;
  const toast = useToast();
  const targets = routes.filter((x) => x.id !== source.id);
  const copy = useMutation({
    mutationFn: async (target: RouteRow) => {
      const seq = Math.max(0, ...target.route_stops.map((s) => s.seq)) + 1;
      unwrap(
        await supabase
          .from('route_stops')
          .insert({ route_id: target.id, stop_id: stop.stop_id, seq, departure_time: stop.departure_time }),
      );
      return target.name;
    },
    onSuccess: (name) => {
      toast.success(r.copiedTo(name));
      onSaved();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={r.copyStopTitle} description={`${stop.name} · ${r.copyStopHint}`}>
      {targets.length ? (
        <ul className="max-h-[50vh] space-y-2 overflow-y-auto" data-testid="copy-targets">
          {targets.map((target) => {
            const already = target.route_stops.some((s) => s.stop_id === stop.stop_id);
            return (
              <li key={target.id}>
                <button
                  type="button"
                  disabled={already || copy.isPending}
                  onClick={() => copy.mutate(target)}
                  className="flex min-h-touch w-full items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-start hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="font-semibold">{target.name}</span>
                  <span className="flex items-center gap-2 text-xs">
                    <Badge tone="info">{r.directions[target.direction]}</Badge>
                    {already ? <Badge>{r.alreadyInRoute}</Badge> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title={r.noOtherRoutes} />
      )}
    </Dialog>
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
              <TimeInput12 id={ids.time} value={form.departure_time} onChange={(v) => setForm({ ...form, departure_time: v })} testId="route-departure" />
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
          <div className="flex justify-end gap-3">
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
  const library = useStopLibrary(universityId);
  const [stopId, setStopId] = useState(stop?.stop_id ?? '');
  const [time, setTime] = useState(toTime(stop?.departure_time));
  const [pending, setPending] = useState<Pending>(null);
  const ids = { stop: useId(), time: useId() };
  const used = new Set(route.route_stops.filter((s) => s.id !== stop?.id).map((s) => s.stop_id));
  const options = (library.data ?? []).filter((s) => (s.is_active || s.id === stopId) && !used.has(s.id));
  const chosen = library.data?.find((s) => s.id === stopId);
  const save = useMutation({
    mutationFn: async () => {
      const row = { route_id: route.id, stop_id: stopId, departure_time: time || null };
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
    if (!stopId) return;
    const timeChanged = stop && time && time !== toTime(stop.departure_time);
    if (timeChanged) setPending({ apply: () => save.mutate() });
    else save.mutate();
  };
  return (
    <>
      <Dialog open={pending === null} onOpenChange={(o) => !o && onClose()} title={stop ? t.common.edit : r.addStop} description={route.name}>
        {library.isLoading ? null : !(library.data ?? []).length ? (
          <EmptyState
            title={r.libraryEmpty}
            action={
              <Button asChild variant="secondary">
                <Link to="/admin/stops">{r.manageStops}</Link>
              </Button>
            }
          />
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <Field label={r.pickStop} hint={chosen ? (chosen.lat !== null ? `${r.coords}: ${chosen.lat}, ${chosen.lng}` : r.coordsMissing) : undefined}>
              <SearchPicker items={options} value={stopId} onChange={setStopId} placeholder={r.searchStop} label={r.pickStop} emptyText={r.noMatches} testId="stop" />
            </Field>
            <Field label={r.departure} htmlFor={ids.time}>
              <TimeInput12 id={ids.time} value={time} onChange={setTime} testId="stop-departure" />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button asChild variant="link">
                <Link to="/admin/stops">{r.manageStops}</Link>
              </Button>
              <div className="flex gap-2">
                <Button onClick={onClose}>{t.common.cancel}</Button>
                <Button type="submit" variant="secondary" disabled={!stopId || save.isPending} data-testid="route-stop-save">
                  {t.common.save}
                </Button>
              </div>
            </div>
          </form>
        )}
      </Dialog>
      <TimeChangeConfirm pending={pending} onCancel={() => setPending(null)} />
    </>
  );
}
