import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, PlusCircle } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { damascusDate, formatDate } from '@somar/shared';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Badge, Button, Field, Input, Select, Switch, Textarea } from '@/components/ui/primitives';
import { DataList, EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { ActiveBadge, useIsAdmin, usePackages, WithUniversity, type PackageRow } from './common';

export default function PackagesPage() {
  return <WithUniversity>{(universityId) => <PackagesBody universityId={universityId} />}</WithUniversity>;
}

function useSubscriberCounts(universityId: string) {
  return useQuery({
    queryKey: ['package-subscribers', universityId],
    queryFn: async () => {
      const rows = unwrap(
        await supabase
          .from('subscriptions')
          .select('package_id, packages!inner(university_id)')
          .eq('status', 'active')
          .eq('packages.university_id', universityId),
      ) as { package_id: string }[];
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.package_id] = (counts[r.package_id] ?? 0) + 1;
      return counts;
    },
  });
}

function PackagesBody({ universityId }: { universityId: string }) {
  const isAdmin = useIsAdmin();
  const query = usePackages(universityId);
  const counts = useSubscriberCounts(universityId);
  const [editing, setEditing] = useState<PackageRow | 'new' | null>(null);
  const [bulk, setBulk] = useState<PackageRow | null>(null);
  const p = t.admin.packages;
  return (
    <div>
      <PageHeader
        title={p.title}
        subtitle={isAdmin ? undefined : p.readOnly}
        actions={
          isAdmin ? (
            <Button variant="secondary" onClick={() => setEditing('new')}>
              <Plus className="h-4 w-4" aria-hidden />
              {p.add}
            </Button>
          ) : undefined
        }
      />
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={p.empty} />)}>
        {(rows) => (
          <DataList
            rows={rows}
            rowKey={(r) => r.id}
            cardTitle={(r) => r.name}
            columns={[
              { key: 'name', header: p.name, cell: (r) => r.name, mobileHidden: true },
              { key: 'trips', header: p.tripsPerWeek, cell: (r) => <span className="num">{r.trips_per_week}</span> },
              {
                key: 'price',
                header: p.price,
                cell: (r) => (r.price === null ? t.common.none : <span><span className="num">{Number(r.price).toLocaleString('en-US')}</span> {t.currency}</span>),
              },
              {
                key: 'semester',
                header: t.student.semester,
                cell: (r) => (
                  <span className="num">
                    {formatDate(r.semester_start)} — {formatDate(r.semester_end)}
                  </span>
                ),
              },
              { key: 'subs', header: p.subscribers, cell: (r) => <Badge tone="info">{counts.data?.[r.id] ?? 0}</Badge> },
              { key: 'status', header: t.common.status, cell: (r) => <ActiveBadge active={r.is_active} /> },
              ...(isAdmin
                ? [
                    {
                      key: 'actions',
                      header: t.common.actions,
                      cell: (r: PackageRow) => (
                        <div className="flex flex-wrap gap-3">
                          <Button size="sm" onClick={() => setEditing(r)}>
                            <Pencil className="h-4 w-4" aria-hidden />
                            {t.common.edit}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setBulk(r)} data-testid={`bulk-${r.id}`}>
                            <PlusCircle className="h-4 w-4" aria-hidden />
                            {p.bulkAdjust}
                          </Button>
                        </div>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </QueryState>
      {editing ? (
        <PackageDialog universityId={universityId} pkg={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      {bulk ? <BulkAdjustDialog pkg={bulk} count={counts.data?.[bulk.id] ?? 0} onClose={() => setBulk(null)} /> : null}
    </div>
  );
}

function PackageDialog({ universityId, pkg, onClose }: { universityId: string; pkg: PackageRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const p = t.admin.packages;
  const today = damascusDate();
  const [form, setForm] = useState({
    name: pkg?.name ?? '',
    trips_per_week: pkg?.trips_per_week ?? 5,
    price: pkg?.price === null || pkg?.price === undefined ? '' : String(pkg.price),
    semester_start: pkg?.semester_start ?? today,
    semester_end: pkg?.semester_end ?? today,
    is_active: pkg?.is_active ?? true,
  });
  const ids = { name: useId(), trips: useId(), price: useId(), start: useId(), end: useId() };
  const save = useMutation({
    mutationFn: async () => {
      const row = {
        university_id: universityId,
        name: form.name.trim(),
        trips_per_week: Number(form.trips_per_week),
        price: form.price === '' ? null : Number(form.price),
        semester_start: form.semester_start,
        semester_end: form.semester_end,
        is_active: form.is_active,
      };
      if (pkg) unwrap(await supabase.from('packages').update(row).eq('id', pkg.id));
      else unwrap(await supabase.from('packages').insert(row));
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['packages', universityId] });
      toast.success(t.common.success);
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const valid = form.name.trim() && Number(form.trips_per_week) > 0 && form.semester_end >= form.semester_start;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={pkg ? t.common.edit : p.add}>
      <form className="space-y-4" onSubmit={submit}>
        <Field label={p.name} htmlFor={ids.name}>
          <Input id={ids.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={p.tripsPerWeek} htmlFor={ids.trips}>
            <Input
              id={ids.trips}
              type="number"
              min={1}
              max={7}
              inputMode="numeric"
              value={form.trips_per_week}
              onChange={(e) => setForm({ ...form, trips_per_week: Number(e.target.value) })}
            />
          </Field>
          <Field label={p.price} htmlFor={ids.price}>
            <Input id={ids.price} type="number" min={0} inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          </Field>
          <Field label={p.semesterStart} htmlFor={ids.start}>
            <Input id={ids.start} type="date" value={form.semester_start} onChange={(e) => setForm({ ...form, semester_start: e.target.value })} />
          </Field>
          <Field label={p.semesterEnd} htmlFor={ids.end}>
            <Input id={ids.end} type="date" value={form.semester_end} onChange={(e) => setForm({ ...form, semester_end: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">{t.common.active}</span>
          <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
        </label>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={!valid || save.isPending}>
            {t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function BulkAdjustDialog({ pkg, count, onClose }: { pkg: PackageRow; count: number; onClose: () => void }) {
  const p = t.admin.packages;
  const qc = useQueryClient();
  const toast = useToast();
  const [scope, setScope] = useState<'this_week' | 'week' | 'permanent'>('this_week');
  const [weekDate, setWeekDate] = useState(damascusDate());
  const [delta, setDelta] = useState(2);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const ids = { scope: useId(), week: useId(), delta: useId(), reason: useId() };
  const run = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase.rpc('bulk_adjust_package', {
          p_package_id: pkg.id,
          p_scope: scope,
          p_delta: delta,
          p_week_date: scope === 'week' ? weekDate : null,
          p_reason: reason.trim() || null,
        }),
      ) as number,
    onSuccess: (n) => {
      toast.success(p.bulkDone(n));
      void qc.invalidateQueries();
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <Dialog open={!confirming} onOpenChange={(o) => !o && onClose()} title={p.bulkTitle} description={pkg.name}>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (delta !== 0) setConfirming(true);
          }}
        >
          <Field label={p.scope} htmlFor={ids.scope}>
            <Select id={ids.scope} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="this_week">{p.scopeThisWeek}</option>
              <option value="week">{p.scopeWeek}</option>
              <option value="permanent">{p.scopePermanent}</option>
            </Select>
          </Field>
          {scope === 'week' ? (
            <Field label={p.weekDate} htmlFor={ids.week}>
              <Input id={ids.week} type="date" value={weekDate} onChange={(e) => setWeekDate(e.target.value)} />
            </Field>
          ) : null}
          <Field label={p.delta} htmlFor={ids.delta}>
            <Input id={ids.delta} type="number" inputMode="numeric" value={delta} onChange={(e) => setDelta(Number(e.target.value))} data-testid="bulk-delta" />
          </Field>
          <Field label={t.common.reason} htmlFor={ids.reason}>
            <Textarea id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-3">
            <Button onClick={onClose}>{t.common.cancel}</Button>
            <Button type="submit" variant="secondary" disabled={delta === 0} data-testid="bulk-next">
              {t.common.next}
            </Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(o) => {
          if (!o) setConfirming(false);
        }}
        title={p.bulkTitle}
        body={p.confirmBulk(count, delta)}
        busy={run.isPending}
        onConfirm={() => run.mutate()}
      />
    </>
  );
}
