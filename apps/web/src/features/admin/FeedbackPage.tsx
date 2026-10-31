import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { foldArabic, formatDateTime } from '@somar/shared';
import { useToast } from '@/components/ui/overlay';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { FEEDBACK_COLUMNS, FeedbackImages, KindBadge, StatusBadge, type FeedbackRow, type FeedbackStatus } from '@/features/feedback/common';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { WithUniversity } from './common';

const STATUSES: FeedbackStatus[] = ['new', 'in_progress', 'resolved'];

export default function FeedbackAdminPage() {
  return <WithUniversity>{(universityId) => <FeedbackBody universityId={universityId} />}</WithUniversity>;
}

function FeedbackBody({ universityId }: { universityId: string }) {
  const f = t.feedback;
  const ids = { search: useId(), kind: useId(), author: useId() };
  const [status, setStatus] = useState<FeedbackStatus | 'all'>('new');
  const [kind, setKind] = useState('');
  const [author, setAuthor] = useState('');
  const [search, setSearch] = useState('');
  const rows = useQuery({
    queryKey: ['feedback', universityId],
    queryFn: async () =>
      unwrap(
        await supabase
          .from('feedback')
          .select(FEEDBACK_COLUMNS)
          .eq('university_id', universityId)
          .order('created_at', { ascending: false })
          .limit(500),
      ) as FeedbackRow[],
  });

  return (
    <div className="space-y-4">
      <PageHeader title={f.adminTitle} subtitle={f.adminIntro} />
      <QueryState query={rows}>
        {(all) => {
          const count = (s: FeedbackStatus) => all.filter((r) => r.status === s).length;
          const needle = foldArabic(search.trim());
          const shown = all.filter(
            (r) =>
              (status === 'all' || r.status === status) &&
              (!kind || r.kind === kind) &&
              (!author || r.author_type === author) &&
              (!needle || foldArabic(`${r.author_name} ${r.author_code ?? ''} ${r.body}`).includes(needle)),
          );
          return (
            <>
              <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={f.status}>
                {(['new', 'in_progress', 'resolved', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="tab"
                    aria-selected={status === s}
                    onClick={() => setStatus(s)}
                    className={cn(
                      'min-h-touch shrink-0 rounded-lg border px-3 text-sm font-semibold',
                      status === s ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
                    )}
                    data-testid={`feedback-tab-${s}`}
                  >
                    {s === 'all' ? f.all : f.statuses[s]} <span className="num opacity-80">({s === 'all' ? all.length : count(s)})</span>
                  </button>
                ))}
              </div>
              <Card className="grid gap-3 sm:grid-cols-3">
                <Field label={f.search} htmlFor={ids.search}>
                  <div className="relative">
                    <Input id={ids.search} className="ps-9" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={f.searchPlaceholder} />
                    <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
                  </div>
                </Field>
                <Field label={f.kind} htmlFor={ids.kind}>
                  <Select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value)}>
                    <option value="">{f.all}</option>
                    <option value="complaint">{f.kinds.complaint}</option>
                    <option value="note">{f.kinds.note}</option>
                  </Select>
                </Field>
                <Field label={f.author} htmlFor={ids.author}>
                  <Select id={ids.author} value={author} onChange={(e) => setAuthor(e.target.value)}>
                    <option value="">{f.all}</option>
                    {(['student', 'doctor', 'employee', 'supervisor'] as const).map((a) => (
                      <option key={a} value={a}>
                        {f.authors[a]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </Card>
              {shown.length ? (
                <ul className="space-y-3" data-testid="feedback-list">
                  {shown.map((row) => (
                    <li key={row.id}>
                      <FeedbackCard row={row} universityId={universityId} />
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title={f.adminEmpty} />
              )}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}

/** One submission: who, what, photos, then the status and the reply the sender will see. */
function FeedbackCard({ row, universityId }: { row: FeedbackRow; universityId: string }) {
  const f = t.feedback;
  const qc = useQueryClient();
  const toast = useToast();
  const replyId = useId();
  const statusId = useId();
  const [status, setStatus] = useState<FeedbackStatus>(row.status);
  const [reply, setReply] = useState(row.reply ?? '');
  const dirty = status !== row.status || reply.trim() !== (row.reply ?? '');
  const save = useMutation({
    mutationFn: async () =>
      unwrap(await supabase.rpc('answer_feedback', { p_id: row.id, p_status: status, p_reply: reply.trim() || null })),
    onSuccess: () => {
      toast.success(reply.trim() && reply.trim() !== (row.reply ?? '') ? f.replied : f.saved);
      void qc.invalidateQueries({ queryKey: ['feedback', universityId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card className={cn('space-y-3', row.status === 'new' && 'border-warning/60')} data-testid="feedback-item">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-extrabold">
            {row.author_name}
            <Badge>{f.authors[row.author_type]}</Badge>
          </p>
          <p className="num text-xs text-muted" dir="ltr">
            {row.author_code}
          </p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <KindBadge kind={row.kind} />
          <StatusBadge status={row.status} />
          <span className="num text-xs text-muted">{formatDateTime(row.created_at)}</span>
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6">{row.body}</p>
      <FeedbackImages paths={row.image_paths} />
      <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-[12rem_1fr]">
        <Field label={f.status} htmlFor={statusId}>
          <Select id={statusId} value={status} onChange={(e) => setStatus(e.target.value as FeedbackStatus)} data-testid="feedback-status">
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {f.statuses[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={row.author_type === 'supervisor' ? f.replySupervisor : f.replyLabel} htmlFor={replyId}>
          <Textarea id={replyId} rows={2} maxLength={2000} value={reply} onChange={(e) => setReply(e.target.value)} data-testid="feedback-reply-input" />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()} data-testid="feedback-save">
          {f.save}
        </Button>
      </div>
    </Card>
  );
}
