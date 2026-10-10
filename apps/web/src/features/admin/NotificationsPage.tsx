import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { formatDateTime } from '@somar/shared';
import { useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, CardTitle, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { PushCard } from '@/features/student/StudentPages';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { useColleges, usePackages, WithUniversity } from './common';
import { RecurringNotifications } from './RecurringNotifications';

type Broadcast = { id: string; title: string; body: string; audience: { kind: string }; recipients: number; created_at: string };
type StaffNotification = { id: string; title: string; body: string; type: string; created_at: string };

export default function NotificationsPage() {
  return <WithUniversity>{(universityId) => <NotificationsBody universityId={universityId} />}</WithUniversity>;
}

function NotificationsBody({ universityId }: { universityId: string }) {
  const n = t.admin.notifications;
  const qc = useQueryClient();
  const toast = useToast();
  const colleges = useColleges(universityId);
  const packages = usePackages(universityId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'university' | 'college' | 'package' | 'student'>('university');
  const [target, setTarget] = useState('');
  const ids = { title: useId(), body: useId(), kind: useId(), target: useId() };

  const history = useQuery({
    queryKey: ['broadcasts', universityId],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('broadcasts')
          .select('id, title, body, audience, recipients, created_at')
          .eq('university_id', universityId)
          .order('created_at', { ascending: false })
          .limit(50),
      ) as Broadcast[],
  });
  const inbox = useQuery({
    queryKey: ['staff-notifications', universityId],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('notifications')
          .select('id, title, body, type, created_at')
          .eq('university_id', universityId)
          .is('student_id', null)
          .order('created_at', { ascending: false })
          .limit(30),
      ) as StaffNotification[],
  });

  const send = useMutation({
    mutationFn: async () => {
      let audience: Record<string, string> = { kind };
      if (kind === 'college') audience = { kind, college_id: target };
      if (kind === 'package') audience = { kind, package_id: target };
      if (kind === 'student') {
        const found = unwrap(
          await supabase.from('students').select('id').eq('university_id', universityId).ilike('transport_number', target.trim()).maybeSingle(),
        ) as { id: string } | null;
        if (!found) throw new Error(n.studentNotFound);
        audience = { kind, student_id: found.id };
      }
      return api.post<{ recipients: number }>('/notifications/broadcast', { university_id: universityId, title, body, audience });
    },
    onSuccess: (res) => {
      toast.success(n.sent(res.recipients));
      setTitle('');
      setBody('');
      void qc.invalidateQueries({ queryKey: ['broadcasts', universityId] });
    },
    onError: (e) => toast.error(e instanceof Error && e.message === n.studentNotFound ? n.studentNotFound : errorMessage(e)),
  });

  const markRead = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('mark_all_notifications_read')),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['unread-count'] }),
  });

  const valid = title.trim() && body.trim() && (kind === 'university' || target.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid) send.mutate();
  };

  return (
    <div className="space-y-4">
      <PageHeader title={n.title} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>{n.compose}</CardTitle>
          <form className="space-y-4" onSubmit={submit}>
            <Field label={n.titleField} htmlFor={ids.title}>
              <Input id={ids.title} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label={n.body} htmlFor={ids.body}>
              <Textarea id={ids.body} value={body} maxLength={1000} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <Field label={n.audience} htmlFor={ids.kind}>
              <Select
                id={ids.kind}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as typeof kind);
                  setTarget('');
                }}
              >
                {Object.entries(n.audiences).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            {kind === 'college' || kind === 'package' ? (
              <Field label={n.audiences[kind]} htmlFor={ids.target}>
                <Select id={ids.target} value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="">{t.common.select}</option>
                  {(kind === 'college' ? colleges.data ?? [] : packages.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {kind === 'student' ? (
              <Field label={n.studentNumber} htmlFor={ids.target}>
                <Input id={ids.target} dir="ltr" className="text-start uppercase" value={target} onChange={(e) => setTarget(e.target.value)} />
              </Field>
            ) : null}
            <Button type="submit" variant="secondary" disabled={!valid || send.isPending}>
              <Send className="h-4 w-4" aria-hidden />
              {n.send}
            </Button>
          </form>
        </Card>
        <div className="space-y-4">
          <PushCard />
          <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
              <CardTitle className="mb-0">{n.staffInbox}</CardTitle>
              <Button size="sm" onClick={() => markRead.mutate()}>
                {t.student.markAllRead}
              </Button>
            </div>
            <QueryState query={inbox} empty={(rows) => (rows.length ? null : <p className="text-sm text-muted">{t.student.noNotifications}</p>)}>
              {(rows) => (
                <ul className="max-h-80 space-y-2 overflow-y-auto">
                  {rows.map((x) => (
                    <li key={x.id} className="rounded-lg bg-surface p-3 text-sm">
                      <p className="font-bold">{x.title}</p>
                      <p className="mt-1 whitespace-pre-line text-muted">{x.body}</p>
                      <p className="num mt-1 text-xs text-muted">{formatDateTime(x.created_at)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
          </Card>
        </div>
      </div>
      <RecurringNotifications universityId={universityId} />
      <Card>
        <CardTitle>{n.history}</CardTitle>
        <QueryState query={history} empty={(rows) => (rows.length ? null : <EmptyState title={n.empty} />)}>
          {(rows) => (
            <ul className="divide-y divide-border">
              {rows.map((b) => (
                <li key={b.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-bold">{b.title}</p>
                    <span className="flex items-center gap-2 text-xs">
                      <Badge tone="info">{n.audiences[b.audience.kind] ?? n.audienceSelected}</Badge>
                      <Badge>
                        {n.recipients}: <span className="num">{b.recipients}</span>
                      </Badge>
                      <span className="num text-muted">{formatDateTime(b.created_at)}</span>
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-line text-sm text-muted">{b.body}</p>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Card>
    </div>
  );
}
