import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useScope, type University } from '@/app/auth';
import { Dialog, useToast } from '@/components/ui/overlay';
import { Button, Card, Field, Input, Select, Switch } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { LOGO_BUCKET, signedUrl, supabase, unwrap } from '@/lib/supabase';
import { ActiveBadge, useAreas, useColleges, useIsAdmin, WithUniversity, type Named } from './common';

function LogoThumb({ path }: { path: string | null }) {
  const q = useQuery({ queryKey: ['logo', path], enabled: Boolean(path), queryFn: () => signedUrl(LOGO_BUCKET, path) });
  if (!path || !q.data) return <span className="inline-block h-10 w-10 rounded bg-surface" aria-hidden />;
  return <img src={q.data} alt={t.university.logo} className="h-10 w-10 rounded object-contain" />;
}

export function UniversitiesPage() {
  const isAdmin = useIsAdmin();
  const { universities, loading } = useScope();
  const [editing, setEditing] = useState<University | 'new' | null>(null);
  return (
    <div>
      <PageHeader
        title={t.nav.universities}
        actions={
          isAdmin ? (
            <Button variant="secondary" onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              {t.university.add}
            </Button>
          ) : undefined
        }
      />
      <QueryState
        query={{ isLoading: loading, isError: false, error: null, data: universities, refetch: () => undefined }}
        empty={(rows) => (rows.length ? null : <EmptyState title={t.university.noneYet} />)}
      >
        {(rows) => (
          <DataList
            rows={rows}
            rowKey={(u) => u.id}
            cardTitle={(u) => u.name}
            columns={[
              { key: 'logo', header: t.university.logo, cell: (u) => <LogoThumb path={u.logo_path} /> },
              { key: 'name', header: t.university.name, cell: (u) => u.name, mobileHidden: true },
              { key: 'prefix', header: t.university.prefix, cell: (u) => <span className="num font-mono">{u.transport_prefix}</span> },
              { key: 'week', header: t.university.weekStart, cell: (u) => t.days[u.week_start_dow] },
              { key: 'status', header: t.common.status, cell: (u) => <ActiveBadge active={u.is_active} /> },
              {
                key: 'actions',
                header: t.common.actions,
                cell: (u) => (
                  <Button size="sm" onClick={() => setEditing(u)}>
                    <Pencil className="h-4 w-4" aria-hidden />
                    {t.common.edit}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </QueryState>
      {editing ? <UniversityDialog university={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function UniversityDialog({ university, onClose }: { university: University | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = useIsAdmin();
  const [name, setName] = useState(university?.name ?? '');
  const [prefix, setPrefix] = useState(university?.transport_prefix ?? '');
  const [dow, setDow] = useState(university?.week_start_dow ?? 6);
  const [active, setActive] = useState(university?.is_active ?? true);
  const [logo, setLogo] = useState<File | null>(null);
  const ids = { name: useId(), prefix: useId(), dow: useId(), logo: useId() };
  const prefixValid = /^[A-Z0-9]{1,10}$/.test(prefix);

  const save = useMutation({
    mutationFn: async () => {
      const row = { name: name.trim(), transport_prefix: prefix, week_start_dow: dow, is_active: active };
      const saved = university
        ? unwrap(await supabase.from('universities').update(row).eq('id', university.id).select('id').single())
        : unwrap(await supabase.from('universities').insert(row).select('id').single());
      if (logo) {
        const form = new FormData();
        form.append('logo', logo);
        await api.post(`/universities/${(saved as unknown as { id: string }).id}/logo`, form);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['universities'] });
      void qc.invalidateQueries({ queryKey: ['logo'] });
      toast.success(t.common.success);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && prefixValid) save.mutate();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={university ? t.university.edit : t.university.add}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={t.university.name} htmlFor={ids.name}>
          <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field
          label={t.university.prefix}
          htmlFor={ids.prefix}
          hint={t.university.prefixHint}
          error={prefix && !prefixValid ? t.errors.prefixInvalid : undefined}
        >
          <Input
            id={ids.prefix}
            dir="ltr"
            className="text-start font-mono uppercase"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value.toUpperCase().trim())}
            required
          />
        </Field>
        <Field label={t.university.weekStart} htmlFor={ids.dow}>
          <Select id={ids.dow} value={dow} onChange={(e) => setDow(Number(e.target.value))}>
            {t.weekStartOptions.map((d) => (
              <option key={d} value={d}>
                {t.days[d]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t.university.logo} htmlFor={ids.logo}>
          <Input id={ids.logo} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setLogo(e.target.files?.[0] ?? null)} />
        </Field>
        {isAdmin ? (
          <label className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">{t.common.active}</span>
            <Switch checked={active} onCheckedChange={setActive} />
          </label>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={save.isPending || !name.trim() || !prefixValid}>
            {save.isPending ? t.common.saving : t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NamedItemsPage({
  table,
  title,
  addLabel,
  nameLabel,
  emptyLabel,
  useItems,
  extraActions,
}: {
  table: 'colleges' | 'areas';
  title: string;
  addLabel: string;
  nameLabel: string;
  emptyLabel: string;
  useItems: typeof useColleges;
  extraActions?: React.ReactNode;
}) {
  return (
    <WithUniversity>
      {(universityId) => (
        <NamedItemsBody
          universityId={universityId}
          table={table}
          title={title}
          addLabel={addLabel}
          nameLabel={nameLabel}
          emptyLabel={emptyLabel}
          useItems={useItems}
          extraActions={extraActions}
        />
      )}
    </WithUniversity>
  );
}

function NamedItemsBody({
  universityId,
  table,
  title,
  addLabel,
  nameLabel,
  emptyLabel,
  useItems,
  extraActions,
}: {
  universityId: string;
  table: 'colleges' | 'areas';
  title: string;
  addLabel: string;
  nameLabel: string;
  emptyLabel: string;
  useItems: typeof useColleges;
  extraActions?: React.ReactNode;
}) {
  const query = useItems(universityId);
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<Named | 'new' | null>(null);
  const [name, setName] = useState('');
  const inputId = useId();

  const save = useMutation({
    mutationFn: async (item: { id?: string; name?: string; is_active?: boolean }) => {
      if (item.id) unwrap(await supabase.from(table).update({ name: item.name, is_active: item.is_active }).eq('id', item.id));
      else unwrap(await supabase.from(table).insert({ university_id: universityId, name: item.name }));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [table, universityId] });
      setEditing(null);
      toast.success(t.common.success);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const open = (item: Named | 'new') => {
    setEditing(item);
    setName(item === 'new' ? '' : item.name);
  };

  return (
    <div>
      <PageHeader
        title={title}
        actions={
          <>
            {extraActions}
            <Button variant="secondary" onClick={() => open('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              {addLabel}
            </Button>
          </>
        }
      />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={emptyLabel} />)}>
        {(rows) => (
          <DataList
            rows={rows}
            rowKey={(r) => r.id}
            cardTitle={(r) => r.name}
            columns={[
              { key: 'name', header: nameLabel, cell: (r) => r.name, mobileHidden: true },
              {
                key: 'active',
                header: t.common.status,
                cell: (r) => (
                  <Switch
                    checked={r.is_active}
                    aria-label={t.common.active}
                    onCheckedChange={(v) => save.mutate({ id: r.id, name: r.name, is_active: v })}
                  />
                ),
              },
              {
                key: 'actions',
                header: t.common.actions,
                cell: (r) => (
                  <Button size="sm" onClick={() => open(r)}>
                    <Pencil className="h-4 w-4" aria-hidden />
                    {t.common.edit}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </QueryState>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? addLabel : t.common.edit}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim() || editing === null) return;
            save.mutate(editing === 'new' ? { name: name.trim() } : { id: editing.id, name: name.trim(), is_active: editing.is_active });
          }}
        >
          <Field label={nameLabel} htmlFor={inputId}>
            <Input id={inputId} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(null)}>{t.common.cancel}</Button>
            <Button type="submit" variant="secondary" disabled={save.isPending || !name.trim()}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

export function CollegesPage() {
  const c = t.admin.colleges;
  return (
    <NamedItemsPage table="colleges" title={c.title} addLabel={c.add} nameLabel={c.name} emptyLabel={c.empty} useItems={useColleges} />
  );
}

export function AreasPage() {
  const a = t.admin.areas;
  return (
    <NamedItemsPage
      table="areas"
      title={a.title}
      addLabel={a.add}
      nameLabel={a.name}
      emptyLabel={a.empty}
      useItems={useAreas}
      extraActions={
        <Button asChild>
          <Link to="/admin/areas/mapping">{a.mappingLink}</Link>
        </Button>
      }
    />
  );
}

type Candidate = { area_other_text: string; student_count: number };

export function AreaMappingPage() {
  return <WithUniversity>{(universityId) => <AreaMappingBody universityId={universityId} />}</WithUniversity>;
}

function AreaMappingBody({ universityId }: { universityId: string }) {
  const m = t.admin.mapping;
  const qc = useQueryClient();
  const toast = useToast();
  const areas = useAreas(universityId);
  const query = useQuery({
    queryKey: ['area-mapping', universityId],
    queryFn: async () =>
      unwrap(await supabase.rpc('area_mapping_candidates', { p_university_id: universityId })) as Candidate[],
  });
  const [choice, setChoice] = useState<Record<string, string>>({});

  const map = useMutation({
    mutationFn: async ({ text, areaId }: { text: string; areaId: string | 'new' }) => {
      let id = areaId;
      if (areaId === 'new') {
        const created = unwrap(
          await supabase.from('areas').insert({ university_id: universityId, name: text }).select('id').single(),
        ) as { id: string };
        id = created.id;
      }
      return unwrap(
        await supabase.rpc('map_area_other_text', { p_university_id: universityId, p_other_text: text, p_area_id: id }),
      ) as number;
    },
    onSuccess: (n) => {
      toast.success(m.mapped(n));
      void qc.invalidateQueries({ queryKey: ['area-mapping', universityId] });
      void qc.invalidateQueries({ queryKey: ['areas', universityId] });
      void qc.invalidateQueries({ queryKey: ['students'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div>
      <PageHeader title={m.title} subtitle={m.intro} />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={m.empty} hint={m.emptyHint} />)}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((r) => {
              const value = choice[r.area_other_text] ?? '';
              return (
                <li key={r.area_other_text}>
                  <Card className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[160px] flex-1">
                      <p className="text-xs text-muted">{m.text}</p>
                      <p className="font-bold">{r.area_other_text}</p>
                      <p className="text-xs text-muted">
                        {m.count}: <span className="num">{r.student_count}</span>
                      </p>
                    </div>
                    <Select
                      aria-label={m.mapTo}
                      className="w-full sm:w-64"
                      value={value}
                      onChange={(e) => setChoice((c) => ({ ...c, [r.area_other_text]: e.target.value }))}
                    >
                      <option value="">{m.mapTo}</option>
                      <option value="new">{m.createNew}</option>
                      {(areas.data ?? [])
                        .filter((a) => a.is_active)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </Select>
                    <Button
                      variant="secondary"
                      disabled={!value || map.isPending}
                      onClick={() => map.mutate({ text: r.area_other_text, areaId: value })}
                    >
                      {m.map}
                    </Button>
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
