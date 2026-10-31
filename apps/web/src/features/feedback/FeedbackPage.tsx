import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, ImagePlus, MessageSquareReply, Send, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { formatClock, formatDateTime, OUTBOUND_SLOTS, RETURN_SLOTS, servesTrip, type TripDirection } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { useToast } from '@/components/ui/overlay';
import { Button, Card, CardTitle, Field, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useRoutes } from '@/features/student/StudentPages';
import { FEEDBACK_COLUMNS, FeedbackImages, KindBadge, StatusBadge, TripLine, type FeedbackKind, type FeedbackRow } from './common';

const MAX_IMAGES = 2;
/** The server's own limit is the photo size in the settings; this only stops an obviously huge file early. */
const MAX_IMAGE_MB = 15;

/** A note or complaint to the administration, with up to two photos, and the sender's earlier ones with replies. */
export default function FeedbackPage() {
  const f = t.feedback;
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const bodyId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<FeedbackKind>('note');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const profileId = me?.profile?.id;
  // the trip a complaint is about, from the university's registered lines
  const [direction, setDirection] = useState<TripDirection | ''>('');
  const [time, setTime] = useState('');
  const [routeId, setRouteId] = useState('');
  const routes = useRoutes(me?.student?.university_id ?? me?.profile?.university_id, true);
  const lines = useMemo(
    () =>
      direction && time
        ? (routes.data ?? []).filter((r) =>
            servesTrip(
              { ...r, first_stop_time: r.route_stops.map((s) => s.departure_time).filter(Boolean).sort()[0] ?? null },
              direction,
              time,
            ),
          )
        : [],
    [routes.data, direction, time],
  );
  const slots: readonly string[] = direction === 'return' ? RETURN_SLOTS : direction === 'outbound' ? OUTBOUND_SLOTS : [];

  useEffect(() => {
    const urls = files.map((file) => URL.createObjectURL(file));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);

  const mine = useQuery({
    queryKey: ['my-feedback', profileId],
    enabled: Boolean(profileId),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('feedback')
          .select(FEEDBACK_COLUMNS)
          .eq('author_profile_id', profileId as string)
          .order('created_at', { ascending: false })
          .limit(50),
      ) as FeedbackRow[],
  });

  const send = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append('kind', kind);
      form.append('body', body.trim());
      if (kind === 'complaint') {
        form.append('trip_direction', direction);
        form.append('trip_time', time);
        if (routeId) form.append('route_id', routeId);
      }
      files.forEach((file, i) => form.append(`image${i + 1}`, file));
      return api.post('/feedback', form);
    },
    onSuccess: () => {
      toast.success(kind === 'complaint' ? f.sentComplaint : f.sentNote);
      setBody('');
      setFiles([]);
      setDirection('');
      setTime('');
      setRouteId('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['my-feedback'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const picked = [...list].filter((file) => file.type.startsWith('image/'));
    if (picked.some((file) => file.size > MAX_IMAGE_MB * 1024 * 1024)) {
      setError(f.imageTooBig(MAX_IMAGE_MB));
      return;
    }
    setError(null);
    setFiles((old) => [...old, ...picked].slice(0, MAX_IMAGES));
  };

  const submit = () => {
    if (kind === 'complaint' && (!direction || !time || (lines.length > 0 && !routeId))) {
      setError(f.tripMissing);
      return;
    }
    if (body.trim().length < 3) {
      setError(f.bodyMissing);
      return;
    }
    send.mutate();
  };

  return (
    <div className="space-y-4">
      <PageHeader title={f.title} subtitle={f.intro} />
      <Card className="space-y-4" data-testid="feedback-form">
        <div role="radiogroup" aria-label={f.kind} className="grid grid-cols-2 gap-2">
          {(['note', 'complaint'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                'min-h-touch rounded-lg border px-3 font-bold',
                kind === k ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
              )}
              data-testid={`feedback-kind-${k}`}
            >
              {f.kinds[k]}
            </button>
          ))}
        </div>
        {kind === 'complaint' ? (
          <div className="space-y-3 rounded-xl border border-border p-3" data-testid="feedback-trip-picker">
            <p className="text-sm font-bold">{f.tripTitle}</p>
            <ChoiceRow
              label={f.direction}
              options={(['outbound', 'return'] as const).map((d) => ({ value: d, label: f.directions[d] ?? d }))}
              value={direction}
              onChange={(d) => {
                setDirection(d as TripDirection);
                setTime('');
                setRouteId('');
                setError(null);
              }}
              testId="feedback-direction"
            />
            {direction ? (
              <ChoiceRow
                label={f.time}
                options={slots.map((s) => ({ value: s, label: formatClock(s) }))}
                value={time}
                onChange={(s) => {
                  setTime(s);
                  setRouteId('');
                  setError(null);
                }}
                testId="feedback-time"
                numeric
              />
            ) : null}
            {direction && time ? (
              lines.length ? (
                <div role="radiogroup" aria-label={f.line} className="space-y-1" data-testid="feedback-lines">
                  <p className="text-xs text-muted">{f.line}</p>
                  {lines.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      role="radio"
                      aria-checked={routeId === r.id}
                      onClick={() => {
                        setRouteId(r.id);
                        setError(null);
                      }}
                      className={cn(
                        'flex min-h-touch w-full items-center gap-2 rounded-lg border px-3 text-start font-semibold',
                        routeId === r.id ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
                      )}
                    >
                      <Bus className="h-4 w-4 shrink-0" aria-hidden />
                      {r.name}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">{routes.isLoading ? f.linesLoading : f.noLines}</p>
              )
            ) : null}
          </div>
        ) : null}
        <Field label={kind === 'complaint' ? f.bodyComplaint : f.bodyNote} htmlFor={bodyId}>
          <Textarea
            id={bodyId}
            rows={5}
            maxLength={2000}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={f.bodyPlaceholder}
            data-testid="feedback-body"
          />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-bold">{f.images}</p>
          <div className="flex flex-wrap gap-2">
            {previews.map((url, i) => (
              <div key={url} className="relative">
                <img src={url} alt="" className="h-24 w-24 rounded-lg border border-border object-cover" />
                <button
                  type="button"
                  className="absolute -end-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full bg-danger text-white shadow"
                  onClick={() => setFiles((old) => old.filter((_, j) => j !== i))}
                  aria-label={f.removeImage(i + 1)}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
            {files.length < MAX_IMAGES ? (
              <button
                type="button"
                className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border text-xs font-semibold text-muted"
                onClick={() => fileRef.current?.click()}
                data-testid="feedback-add-image"
              >
                <ImagePlus className="h-6 w-6" aria-hidden />
                {f.addImage}
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
            data-testid="feedback-file"
          />
          <p className="text-xs text-muted">{f.imagesHint(MAX_IMAGES)}</p>
        </div>
        {error ? (
          <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">
            {error}
          </p>
        ) : null}
        <Button variant="primary" size="lg" className="w-full" onClick={submit} disabled={send.isPending} data-testid="feedback-send">
          <Send className="h-5 w-5" aria-hidden />
          {send.isPending ? f.sending : f.send}
        </Button>
      </Card>

      <h2 className="text-lg font-extrabold text-brand-ink">{f.mine}</h2>
      <QueryState query={mine} empty={(rows) => (rows.length ? null : <EmptyState title={f.mineEmpty} />)}>
        {(rows) => (
          <ul className="space-y-3" data-testid="feedback-mine">
            {rows.map((row) => (
              <li key={row.id}>
                <Card className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <KindBadge kind={row.kind} />
                      <StatusBadge status={row.status} />
                    </span>
                    <span className="num text-xs text-muted">{formatDateTime(row.created_at)}</span>
                  </div>
                  <TripLine row={row} />
                  <p className="whitespace-pre-wrap text-sm leading-6">{row.body}</p>
                  <FeedbackImages paths={row.image_paths} />
                  {row.reply ? (
                    <div className="rounded-lg bg-brand/10 p-3 text-sm" data-testid="feedback-reply">
                      <CardTitle className="mb-1 flex items-center gap-2 text-sm">
                        <MessageSquareReply className="h-4 w-4 text-brand-ink" aria-hidden />
                        {f.replyTitle}
                      </CardTitle>
                      <p className="whitespace-pre-wrap leading-6">{row.reply}</p>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </QueryState>
    </div>
  );
}

/** A row of radio buttons (direction, time). */
function ChoiceRow({
  label,
  options,
  value,
  onChange,
  testId,
  numeric = false,
}: {
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  testId: string;
  numeric?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted">{label}</p>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2" data-testid={testId}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              'min-h-touch rounded-lg border px-4 font-bold',
              numeric && 'num',
              value === o.value ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
