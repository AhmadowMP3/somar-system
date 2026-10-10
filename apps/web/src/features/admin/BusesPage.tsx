import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { damascusDate, formatTime } from '@somar/shared';
import { DirectionBadge } from '@/components/common';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Button, Card, Field, Input, Switch } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { ActiveBadge, WithUniversity } from './common';

/** One bus with its boardings on the chosen day (bus_day_stats). */
type BusStat = {
  bus_id: string;
  bus_number: string;
  plate_number: string;
  seats: number;
  is_active: boolean;
  outbound_count: number;
  return_count: number;
};

type Rider = {
  id: string;
  scanned_at: string;
  direction: string;
  student: { full_name: string; transport_number: string } | null;
};

export default function BusesPage() {
  return <WithUniversity>{(universityId) => <BusesBody universityId={universityId} />}</WithUniversity>;
}

function BusesBody({ universityId }: { universityId: string }) {
  const b = t.admin.buses;
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(damascusDate());
  const [editing, setEditing] = useState<BusStat | 'new' | null>(null);
  const [deleting, setDeleting] = useState<BusStat | null>(null);
  const dateId = useId();

  const query = useQuery({
    queryKey: ['bus-stats', universityId, date],
    enabled: Boolean(date),
    queryFn: async () =>
      unwrap(await supabase.rpc('bus_day_stats', { p_university_id: universityId, p_date: date })) as BusStat[],
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['bus-stats', universityId] });
    void qc.invalidateQueries({ queryKey: ['scan-buses'] });
    void qc.invalidateQueries({ queryKey: ['buses', universityId] });
  };
  const toggle = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) =>
      unwrap(await supabase.from('buses').update({ is_active: active }).eq('id', id)),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async (bus: BusStat) => unwrap(await supabase.from('buses').delete().eq('id', bus.bus_id)),
    onSuccess: (_res, bus) => {
      toast.success(b.deleted(bus.bus_number));
      setDeleting(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-4">
      <PageHeader
        title={b.title}
        subtitle={b.intro}
        actions={
          <Button variant="secondary" onClick={() => setEditing('new')} data-testid="bus-add">
            <Plus className="h-4 w-4" aria-hidden />
            {b.add}
          </Button>
        }
      />
      <Card className="p-4">
        <Field label={b.day} htmlFor={dateId}>
          <Input id={dateId} type="date" className="max-w-xs" value={date} onChange={(e) => setDate(e.target.value)} data-testid="bus-date" />
        </Field>
      </Card>
      <QueryState query={query} empty={(rows) => (rows.length ? null : <EmptyState title={b.empty} hint={b.emptyHint} />)}>
        {(rows) => (
          <ul className="grid gap-3 md:grid-cols-2" data-testid="bus-list">
            {rows.map((bus) => (
              <li key={bus.bus_id}>
                <BusCard
                  bus={bus}
                  date={date}
                  onToggle={(active) => toggle.mutate({ id: bus.bus_id, active })}
                  onEdit={() => setEditing(bus)}
                  onDelete={() => setDeleting(bus)}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryState>
      {editing ? <BusDialog universityId={universityId} bus={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={b.deleteTitle}
        body={deleting ? b.deleteConfirm(deleting.bus_number) : ''}
        confirmLabel={t.common.delete}
        danger
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function BusCard({
  bus,
  date,
  onToggle,
  onEdit,
  onDelete,
}: {
  bus: BusStat;
  date: string;
  onToggle: (active: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const b = t.admin.buses;
  const [open, setOpen] = useState(false);
  const total = bus.outbound_count + bus.return_count;
  return (
    <Card className={cn('space-y-3 p-4', !bus.is_active && 'opacity-70')} data-testid="bus-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-lg font-extrabold">
            <Bus className="h-5 w-5 shrink-0 text-brand-ink" aria-hidden />
            <span className="num truncate">{bus.bus_number}</span>
          </p>
          <p className="text-sm text-muted">
            {b.plateNumber}: <span className="num font-mono">{bus.plate_number}</span> · {b.seats}: <span className="num">{bus.seats}</span>
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <ActiveBadge active={bus.is_active} />
          <Switch checked={bus.is_active} aria-label={t.common.active} onCheckedChange={onToggle} />
        </span>
      </div>
      <div className="space-y-2">
        <OccupancyBar label={b.outbound} count={bus.outbound_count} seats={bus.seats} />
        <OccupancyBar label={b.return} count={bus.return_count} seats={bus.seats} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setOpen(!open)} aria-expanded={open} disabled={!total} data-testid="bus-riders-toggle">
          <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
          {open ? b.hideRiders : b.showRiders(total)}
        </Button>
        <Button size="sm" onClick={onEdit} data-testid="bus-edit">
          <Pencil className="h-4 w-4" aria-hidden />
          {t.common.edit}
        </Button>
        <Button size="sm" variant="outline" className="text-danger" onClick={onDelete} data-testid="bus-delete">
          <Trash2 className="h-4 w-4" aria-hidden />
          {t.common.delete}
        </Button>
      </div>
      {open && total ? <RiderList busId={bus.bus_id} date={date} /> : null}
    </Card>
  );
}

function OccupancyBar({ label, count, seats }: { label: string; count: number; seats: number }) {
  const pct = Math.min(100, Math.round((count / seats) * 100));
  const over = count > seats;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="font-semibold">{label}</span>
        <span className={cn('num', over ? 'font-bold text-danger' : 'text-muted')}>{t.admin.buses.seatsOf(count, seats)}</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={seats}
        aria-valuenow={count}
      >
        <div className={cn('h-full rounded-full', over ? 'bg-danger' : 'bg-brand-ink')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function RiderList({ busId, date }: { busId: string; date: string }) {
  const b = t.admin.buses;
  const query = useQuery({
    queryKey: ['bus-riders', busId, date],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('scans')
          .select('id, scanned_at, direction, student:students(full_name, transport_number)')
          .eq('bus_id', busId)
          .eq('service_date', date)
          .is('cancelled_at', null)
          .order('scanned_at'),
      ) as unknown as Rider[],
  });
  return (
    <QueryState query={query} empty={(rows) => (rows.length ? null : <p className="text-sm text-muted">{b.noRiders}</p>)}>
      {(rows) => (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto rounded-xl border border-border text-sm" data-testid="bus-riders">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-semibold">{r.student?.full_name}</span>
                <span className="num font-mono text-xs text-muted">{r.student?.transport_number}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <DirectionBadge direction={r.direction} />
                <span className="num text-muted">{formatTime(r.scanned_at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  );
}

function BusDialog({
  universityId,
  bus,
  onClose,
  onSaved,
}: {
  universityId: string;
  bus: BusStat | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const b = t.admin.buses;
  const toast = useToast();
  const [form, setForm] = useState({
    bus_number: bus?.bus_number ?? '',
    plate_number: bus?.plate_number ?? '',
    seats: bus ? String(bus.seats) : '',
    is_active: bus?.is_active ?? true,
  });
  const ids = { number: useId(), plate: useId(), seats: useId() };
  const seats = Number(form.seats);
  const valid =
    form.bus_number.trim().length > 0 &&
    form.bus_number.trim().length <= 30 &&
    form.plate_number.trim().length > 0 &&
    form.plate_number.trim().length <= 30 &&
    Number.isInteger(seats) &&
    seats >= 1 &&
    seats <= 200;
  const save = useMutation({
    mutationFn: async () => {
      const row = {
        university_id: universityId,
        bus_number: form.bus_number.trim(),
        plate_number: form.plate_number.trim(),
        seats,
        is_active: form.is_active,
      };
      if (bus) unwrap(await supabase.from('buses').update(row).eq('id', bus.bus_id));
      else unwrap(await supabase.from('buses').insert(row));
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
    if (valid) save.mutate();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={bus ? b.editTitle : b.add}>
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={b.busNumber} htmlFor={ids.number}>
            <Input
              id={ids.number}
              value={form.bus_number}
              maxLength={30}
              onChange={(e) => setForm({ ...form, bus_number: e.target.value })}
              required
              data-testid="bus-number"
            />
          </Field>
          <Field label={b.seats} htmlFor={ids.seats}>
            <Input
              id={ids.seats}
              type="number"
              min={1}
              max={200}
              inputMode="numeric"
              value={form.seats}
              onChange={(e) => setForm({ ...form, seats: e.target.value })}
              required
              data-testid="bus-seats"
            />
          </Field>
        </div>
        <Field label={b.plateNumber} htmlFor={ids.plate}>
          <Input
            id={ids.plate}
            dir="auto"
            value={form.plate_number}
            maxLength={30}
            onChange={(e) => setForm({ ...form, plate_number: e.target.value })}
            required
            data-testid="bus-plate"
          />
        </Field>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">{t.common.active}</span>
          <Switch checked={form.is_active} onCheckedChange={(v) => setForm({ ...form, is_active: v })} />
        </label>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose}>{t.common.cancel}</Button>
          <Button type="submit" variant="secondary" disabled={!valid || save.isPending} data-testid="bus-save">
            {save.isPending ? t.common.saving : t.common.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
