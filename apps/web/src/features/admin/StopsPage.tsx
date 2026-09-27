import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pencil, Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { parseMapsUrl } from '@somar/shared';
import { useStopLibrary, type LibraryStop } from '@/features/student/StudentPages';
import { Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Field, Input, Select, Switch } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
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
  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      unwrap(await supabase.from('stops').update({ is_active: active }).eq('id', id)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['stops', universityId] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const areaName = (id: string | null) => areas.data?.find((a) => a.id === id)?.name ?? t.common.none;
  return (
    <div>
      <PageHeader
        title={s.title}
        subtitle={s.intro}
        actions={
          <>
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
        {(rows) => (
          <DataList
            rows={rows}
            rowKey={(r) => r.id}
            cardTitle={(r) => r.name}
            columns={[
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
                  <Button size="sm" onClick={() => setEditing(r)}>
                    <Pencil className="h-4 w-4" aria-hidden />
                    {t.common.edit}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </QueryState>
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
  const coords = parseMapsUrl(form.maps_url);
  const save = useMutation({
    mutationFn: async () => {
      const row = {
        university_id: universityId,
        name: form.name.trim(),
        maps_url: form.maps_url.trim() || null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        area_id: form.area_id || null,
      };
      if (stop) unwrap(await supabase.from('stops').update(row).eq('id', stop.id));
      else unwrap(await supabase.from('stops').insert(row));
    },
    onSuccess: () => {
      toast.success(t.common.success);
      void qc.invalidateQueries({ queryKey: ['stops', universityId] });
      void qc.invalidateQueries({ queryKey: ['routes', universityId] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
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
        <Field label={r.mapsUrl} htmlFor={ids.url} hint={form.maps_url ? (coords ? `${r.coords}: ${coords.lat}, ${coords.lng}` : r.coordsMissing) : r.mapsHint}>
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
