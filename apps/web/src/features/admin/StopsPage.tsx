import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ExternalLink, LocateFixed, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { findPlusCode, foldArabic, parseMapsUrl } from '@somar/shared';
import { useStopLibrary, type LibraryStop } from '@/features/student/StudentPages';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Field, Input, Select, Switch } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { useAreas, WithUniversity } from './common';

export default function StopsPage() {
  return <WithUniversity>{(universityId) => <StopsBody universityId={universityId} />}</WithUniversity>;
}

function StopsBody({ universityId }: { universityId: string }) {
  const s = t.admin.stops;
  const query = useStopLibrary(universityId);
  const areas = useAreas(universityId);
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<LibraryStop | 'new' | null>(null);
  // deleting: first a plain confirmation; if the stop is on routes, a second one naming them
  const [deleting, setDeleting] = useState<{ stop: LibraryStop; routes: string[] | null } | null>(null);
  const remove = useMutation({
    mutationFn: async ({ stop, confirmRoutes }: { stop: LibraryStop; confirmRoutes: boolean }) =>
      unwrap(await supabase.rpc('delete_stop', { p_stop_id: stop.id, p_remove_from_routes: confirmRoutes })) as { deleted: boolean; routes: string[] },
    onSuccess: (res, { stop }) => {
      if (!res.deleted) {
        setDeleting({ stop, routes: res.routes });
        return;
      }
      toast.success(s.deleted(stop.name));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['stops', universityId] });
      void qc.invalidateQueries({ queryKey: ['routes', universityId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    // row-level security turns a refused update into "0 rows" without an error: count the rows so it is never silent
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const saved = unwrap(await supabase.from('stops').update({ is_active: active }).eq('id', id).select('id')) as unknown[] | null;
      if (!saved?.length) throw new Error('NOT_SAVED');
    },
    onSuccess: (_res, { active }) => toast.success(active ? s.activated : s.deactivated),
    onError: (e) => toast.error(e instanceof Error && e.message === 'NOT_SAVED' ? s.notSaved : errorMessage(e)),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['stops', universityId] }),
  });
  const areaName = (id: string | null) => areas.data?.find((a) => a.id === id)?.name ?? t.common.none;
  const [term, setTerm] = useState('');
  const searchId = useId();
  // the new order shows at once; a failure puts the old one back
  const reorder = useMutation({
    mutationFn: async (ids: string[]) => unwrap(await supabase.rpc('reorder_stops', { p_university_id: universityId, p_ids: ids })),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ['stops', universityId] });
      const prev = qc.getQueryData<LibraryStop[]>(['stops', universityId]);
      if (prev) {
        const byId = new Map(prev.map((x) => [x.id, x]));
        qc.setQueryData(['stops', universityId], ids.map((id) => byId.get(id)).filter(Boolean));
      }
      return { prev };
    },
    onError: (e, _ids, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stops', universityId], ctx.prev);
      toast.error(errorMessage(e));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['stops', universityId] }),
  });
  /** Moves a stop to a 1-based position in the whole list. */
  const moveTo = (all: LibraryStop[], id: string, position: number) => {
    const ids = all.map((x) => x.id).filter((x) => x !== id);
    ids.splice(Math.min(Math.max(position - 1, 0), ids.length), 0, id);
    if (ids.some((x, i) => x !== all[i]?.id)) reorder.mutate(ids);
  };
  const missing = (query.data ?? []).filter((x) => x.maps_url && (x.lat == null || x.lng == null)).length;
  const [report, setReport] = useState<{ failed: string[]; shared: string[][] } | null>(null);
  const resolveAll = useMutation({
    mutationFn: () =>
      api.post<{ checked: number; fixed: number; failed: string[]; shared: string[][] }>('/stops/resolve-missing', { university_id: universityId }),
    onSuccess: (res) => {
      toast.success(s.resolvedCount(res.fixed, res.checked));
      if (res.failed.length || res.shared.length) setReport({ failed: res.failed, shared: res.shared });
      void qc.invalidateQueries({ queryKey: ['stops', universityId] });
      void qc.invalidateQueries({ queryKey: ['routes', universityId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div>
      <PageHeader
        title={s.title}
        subtitle={s.intro}
        actions={
          <>
            {missing ? (
              <Button variant="primary" disabled={resolveAll.isPending} onClick={() => resolveAll.mutate()} data-testid="resolve-missing">
                <LocateFixed className="h-4 w-4" aria-hidden />
                {resolveAll.isPending ? s.resolving : s.resolveMissing(missing)}
              </Button>
            ) : null}
            <Button asChild>
              <Link to="/admin/routes">{t.nav.adminRoutes}</Link>
            </Button>
            <Button variant="secondary" onClick={() => setEditing('new')} data-testid="stop-add">
              <Plus className="h-4 w-4" aria-hidden />
              {s.add}
            </Button>
          </>
        }
      />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={s.empty} hint={s.emptyHint} />)}>
        {(all) => {
          const needle = foldArabic(term.trim());
          const rows = needle ? all.filter((x) => foldArabic(`${x.name} ${areaName(x.area_id)}`).includes(needle)) : all;
          const position = new Map(all.map((x, i) => [x.id, i + 1]));
          return (
          <div className="space-y-3">
          <div className="space-y-1">
            <div className="relative">
              <label htmlFor={searchId} className="sr-only">
                {t.common.search}
              </label>
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
              <Input
                id={searchId}
                className="ps-9"
                placeholder={s.searchPlaceholder}
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                data-testid="stops-search"
              />
            </div>
            <p className="text-xs text-muted">{s.orderHint}</p>
          </div>
          {!rows.length ? <EmptyState title={s.noMatches} /> : null}
          <DataList
            rows={rows}
            rowKey={(r) => r.id}
            cardTitle={(r) => (
              <span className="flex items-center gap-2">
                <span className="num text-sm text-muted">{position.get(r.id)}.</span>
                {r.name}
              </span>
            )}
            columns={[
              {
                key: 'order',
                header: s.order,
                cell: (r) => (
                  <OrderCell
                    position={position.get(r.id) ?? 0}
                    total={all.length}
                    busy={reorder.isPending}
                    onMove={(to) => moveTo(all, r.id, to)}
                  />
                ),
              },
              { key: 'name', header: t.admin.routes.stopName, cell: (r) => r.name, mobileHidden: true },
              { key: 'area', header: t.admin.routes.area, cell: (r) => areaName(r.area_id) },
              {
                key: 'map',
                header: t.admin.routes.mapsUrl,
                cell: (r) =>
                  r.maps_url ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <a href={r.maps_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-ink underline">
                        <ExternalLink className="h-4 w-4" aria-hidden />
                        {t.common.open}
                      </a>
                      {r.lat === null ? <Badge tone="warning">{t.admin.routes.coordsMissing}</Badge> : null}
                    </span>
                  ) : (
                    <Badge tone="warning">{s.noLink}</Badge>
                  ),
              },
              {
                key: 'active',
                header: t.common.status,
                cell: (r) => <Switch checked={r.is_active} aria-label={t.common.active} onCheckedChange={(v) => toggle.mutate({ id: r.id, active: v })} />,
              },
              {
                key: 'actions',
                header: t.common.actions,
                cell: (r) => (
                  <span className="flex flex-wrap gap-3">
                    <Button size="sm" onClick={() => setEditing(r)}>
                      <Pencil className="h-4 w-4" aria-hidden />
                      {t.common.edit}
                    </Button>
                    <Button size="sm" variant="outline" className="text-danger" onClick={() => setDeleting({ stop: r, routes: null })} data-testid="stop-delete">
                      <Trash2 className="h-4 w-4" aria-hidden />
                      {t.common.delete}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
          </div>
          );
        }}
      </QueryState>
      <Dialog open={report !== null} onOpenChange={(o) => (o ? undefined : setReport(null))} title={s.failedTitle}>
        <div className="space-y-4">
          {report?.failed.length ? (
            <section>
              <p className="mb-2 text-sm text-muted">{s.failedHint}</p>
              <ul className="list-disc space-y-1 ps-5" data-testid="resolve-failed">
                {report.failed.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {report?.shared.length ? (
            <section>
              <p className="mb-2 text-sm font-semibold text-warning">{s.sharedHint}</p>
              <ul className="list-disc space-y-1 ps-5" data-testid="resolve-shared">
                {report.shared.map((names) => (
                  <li key={names.join('|')}>{names.join(t.listSeparator)}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (o ? undefined : setDeleting(null))}
        title={deleting?.routes ? s.deleteInRoutesTitle : s.deleteTitle}
        body={deleting ? (deleting.routes ? s.deleteInRoutes(deleting.stop.name) : s.deleteConfirm(deleting.stop.name)) : ''}
        confirmLabel={deleting?.routes ? s.deleteFromRoutes : t.common.delete}
        danger
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate({ stop: deleting.stop, confirmRoutes: Boolean(deleting.routes) })}
      >
        {deleting?.routes ? (
          <ul className="mt-3 list-disc space-y-1 ps-5 font-semibold" data-testid="stop-delete-routes">
            {deleting.routes.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
      {editing ? (
        <StopFormDialog universityId={universityId} stop={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

function StopFormDialog({ universityId, stop, onClose }: { universityId: string; stop: LibraryStop | null; onClose: () => void }) {
  const s = t.admin.stops;
  const r = t.admin.routes;
  const qc = useQueryClient();
  const toast = useToast();
  const areas = useAreas(universityId);
  const [form, setForm] = useState({ name: stop?.name ?? '', maps_url: stop?.maps_url ?? '', area_id: stop?.area_id ?? '' });
  const ids = { name: useId(), url: useId(), area: useId() };
  const url = form.maps_url.trim();
  const unchanged = Boolean(stop && url === (stop.maps_url ?? '') && stop.lat != null && stop.lng != null);
  const parsed = parseMapsUrl(url);
  // share links (maps.app.goo.gl …) have no coordinates in them: the server follows them to the full address
  const needsServer = Boolean(url && !parsed && !unchanged && (/^https?:\/\//i.test(url) || findPlusCode(url)));
  const [resolved, setResolved] = useState<{ url: string; lat: number; lng: number } | { url: string; failed: true } | null>(null);
  useEffect(() => {
    if (!needsServer) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .post<{ lat: number; lng: number }>('/maps/resolve', { url, university_id: universityId })
        .then((c) => !cancelled && setResolved({ url, ...c }))
        .catch(() => !cancelled && setResolved({ url, failed: true }));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, needsServer, universityId]);
  const fromServer = resolved && resolved.url === url && !('failed' in resolved) ? resolved : null;
  const coords = unchanged && stop ? { lat: Number(stop.lat), lng: Number(stop.lng) } : (parsed ?? fromServer);
  const resolving = needsServer && (!resolved || resolved.url !== url);
  const save = useMutation({
    mutationFn: async () => {
      let found = coords;
      if (!found && needsServer) found = await api.post<{ lat: number; lng: number }>('/maps/resolve', { url, university_id: universityId }).catch(() => null);
      const row = {
        university_id: universityId,
        name: form.name.trim(),
        maps_url: url || null,
        lat: found?.lat ?? null,
        lng: found?.lng ?? null,
        area_id: form.area_id || null,
      };
      if (stop) {
        const saved = unwrap(await supabase.from('stops').update(row).eq('id', stop.id).select('id')) as unknown[] | null;
        if (!saved?.length) throw new Error('NOT_SAVED');
      }
      else unwrap(await supabase.from('stops').insert(row));
    },
    onSuccess: () => {
      toast.success(t.common.success);
      void qc.invalidateQueries({ queryKey: ['stops', universityId] });
      void qc.invalidateQueries({ queryKey: ['routes', universityId] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error && e.message === 'NOT_SAVED' ? t.admin.stops.notSaved : errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (form.name.trim()) save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={stop ? t.common.edit : s.add} description={stop ? s.editNote : undefined}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={r.stopName} htmlFor={ids.name}>
          <Input id={ids.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required data-testid="stop-name" />
        </Field>
        <Field label={r.mapsUrl} htmlFor={ids.url} hint={
            url ? (
              coords ? (
                <span data-testid="stop-coords">{`${r.coords}: ${coords.lat}, ${coords.lng}`}</span>
              ) : resolving ? (
                s.resolvingOne
              ) : (
                <span className="text-warning" data-testid="stop-coords-missing">
                  {s.coordsNotFound}
                </span>
              )
            ) : (
              r.mapsHint
            )
          }>
          <Input id={ids.url} dir="ltr" className="text-start" value={form.maps_url} onChange={(e) => setForm({ ...form, maps_url: e.target.value })} data-testid="stop-url" />
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
        <div className="flex justify-end gap-3">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={save.isPending || !form.name.trim()} data-testid="stop-save">
            {t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Up / down, or type the stop's new place in the list (applied on Enter or leaving the box). */
function OrderCell({ position, total, busy, onMove }: { position: number; total: number; busy: boolean; onMove: (to: number) => void }) {
  const s = t.admin.stops;
  const [draft, setDraft] = useState(String(position));
  useEffect(() => setDraft(String(position)), [position]);
  const commit = () => {
    const to = Number(draft);
    if (Number.isInteger(to) && to >= 1 && to !== position) onMove(Math.min(to, total));
    else setDraft(String(position));
  };
  return (
    <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <Button size="icon" variant="ghost" aria-label={t.admin.routes.moveUp} disabled={busy || position <= 1} onClick={() => onMove(position - 1)} data-testid="stop-up">
        <ArrowUp className="h-4 w-4" />
      </Button>
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        max={total}
        className="num h-10 w-16 px-2 text-center"
        aria-label={s.position}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        data-testid="stop-position"
      />
      <Button size="icon" variant="ghost" aria-label={t.admin.routes.moveDown} disabled={busy || position >= total} onClick={() => onMove(position + 1)} data-testid="stop-down">
        <ArrowDown className="h-4 w-4" />
      </Button>
    </span>
  );
}
