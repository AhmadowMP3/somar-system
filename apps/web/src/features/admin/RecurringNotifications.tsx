import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { formatClock, formatDate } from '@somar/shared';
import { useScope } from '@/app/auth';
import { ConfirmDialog, Dialog, useToast } from '@/components/ui/overlay';
import { Button, Card, CardTitle, Field, Input, Switch, Textarea } from '@/components/ui/primitives';
import { QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type Recurring = { id: string; title: string; body: string; days: number[]; send_time: string; is_active: boolean; last_sent_on: string | null };
type Draft = { id?: string; title: string; body: string; days: number[]; send_time: string };

/** Weekly notifications to every active student, sent by the server on the chosen days at the chosen time. */
export function RecurringNotifications({ universityId }: { universityId: string }) {
  const n = t.admin.notifications;
  const qc = useQueryClient();
  const toast = useToast();
  const { university } = useScope();
  const weekStart = university?.week_start_dow ?? 6;
  const order = Array.from({ length: 7 }, (_, i) => ((weekStart - 1 + i) % 7) + 1);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Recurring | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ids = { title: useId(), body: useId(), time: useId() };
  const key = ['recurring', universityId];

  const list = useQuery({
    queryKey: key,
    queryFn: async () =>
      unwrap(
        await supabase
          .from('recurring_notifications')
          .select('id, title, body, days, send_time, is_active, last_sent_on')
          .eq('university_id', universityId)
          .order('send_time'),
      ) as Recurring[],
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  const save = useMutation({
    mutationFn: async (d: Draft) => {
      const row = { title: d.title.trim(), body: d.body.trim(), days: [...d.days].sort(), send_time: d.send_time };
      if (d.id) unwrap(await supabase.from('recurring_notifications').update(row).eq('id', d.id));
      else unwrap(await supabase.from('recurring_notifications').insert({ ...row, university_id: universityId }));
    },
    onSuccess: () => {
      toast.success(n.recurringSaved);
      setDraft(null);
      refresh();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: async (r: Recurring) => unwrap(await supabase.from('recurring_notifications').update({ is_active: !r.is_active }).eq('id', r.id)),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => unwrap(await supabase.from('recurring_notifications').delete().eq('id', id)),
    onSuccess: () => {
      toast.success(n.recurringDeleted);
      setDeleting(null);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    if (!draft.days.length) {
      setError(n.recurringNoDays);
      return;
    }
    setError(null);
    save.mutate(draft);
  };
  const dayNames = (days: number[]) =>
    order
      .filter((d) => days.includes(d))
      .map((d) => t.days[d])
      .join(t.listSeparator);

  return (
    <Card data-testid="recurring">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle className="mb-1">{n.recurringTitle}</CardTitle>
          <p className="text-sm text-muted">{n.recurringIntro}</p>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setError(null);
            setDraft({ title: '', body: '', days: [], send_time: '18:00' });
          }}
          data-testid="recurring-add"
        >
          <Plus className="h-4 w-4" aria-hidden />
          {n.recurringAdd}
        </Button>
      </div>
      <QueryState query={list} empty={(rows) => (rows.length ? null : <p className="text-sm text-muted">{n.recurringEmpty}</p>)}>
        {(rows) => (
          <ul className="divide-y divide-border" data-testid="recurring-list">
            {rows.map((r) => (
              <li key={r.id} className={cn('flex flex-wrap items-start justify-between gap-3 py-3', !r.is_active && 'opacity-60')}>
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{r.title}</p>
                  <p className="mt-1 text-sm font-semibold text-brand-ink">{n.recurringSchedule(dayNames(r.days), formatClock(r.send_time))}</p>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted">{r.body}</p>
                  {r.last_sent_on ? (
                    <p className="mt-1 text-xs text-muted">
                      {n.recurringLastSent}: <span className="num">{formatDate(r.last_sent_on)}</span>
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch checked={r.is_active} onCheckedChange={() => toggle.mutate(r)} aria-label={n.recurringActive} />
                    {r.is_active ? n.recurringActive : n.recurringPaused}
                  </label>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t.common.edit}
                    onClick={() => {
                      setError(null);
                      setDraft({ id: r.id, title: r.title, body: r.body, days: r.days, send_time: formatClock(r.send_time) });
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label={t.common.delete} onClick={() => setDeleting(r)}>
                    <Trash2 className="h-4 w-4 text-danger" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryState>

      <Dialog open={draft !== null} onOpenChange={(o) => (o ? undefined : setDraft(null))} title={draft?.id ? n.recurringEdit : n.recurringAdd}>
        {draft ? (
          <form className="space-y-4" onSubmit={submit}>
            <Field label={n.titleField} htmlFor={ids.title}>
              <Input id={ids.title} required maxLength={120} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <Field label={n.body} htmlFor={ids.body}>
              <Textarea id={ids.body} required maxLength={1000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </Field>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">{n.recurringDays}</legend>
              <div className="flex flex-wrap gap-2">
                {order.map((d) => {
                  const on = draft.days.includes(d);
                  return (
                    <label
                      key={d}
                      className={cn(
                        'flex min-h-touch cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-semibold',
                        on ? 'border-brand-ink bg-brand-ink text-white' : 'border-border bg-bg',
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={on}
                        onChange={() => setDraft({ ...draft, days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })}
                        data-testid={`recurring-day-${d}`}
                      />
                      {t.days[d]}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <Field label={n.recurringTime} htmlFor={ids.time}>
              <Input
                id={ids.time}
                type="time"
                dir="ltr"
                required
                className="max-w-[180px] text-center"
                value={draft.send_time}
                onChange={(e) => setDraft({ ...draft, send_time: e.target.value })}
                data-testid="recurring-time"
              />
            </Field>
            {error ? (
              <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                {t.common.cancel}
              </Button>
              <Button type="submit" variant="primary" disabled={save.isPending} data-testid="recurring-save">
                {save.isPending ? t.common.saving : t.common.save}
              </Button>
            </div>
          </form>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => (o ? undefined : setDeleting(null))}
        title={t.common.delete}
        body={n.recurringDeleteConfirm}
        danger
        busy={remove.isPending}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
    </Card>
  );
}
