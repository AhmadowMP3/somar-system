import { useQuery } from '@tanstack/react-query';
import { Bus } from 'lucide-react';
import { useState } from 'react';
import { formatClock } from '@somar/shared';
import { Dialog } from '@/components/ui/overlay';
import { Badge } from '@/components/ui/primitives';
import { t } from '@/i18n/ar';
import { supabase } from '@/lib/supabase';

export const FEEDBACK_BUCKET = 'feedback-images';

export type FeedbackKind = 'note' | 'complaint';
export type FeedbackStatus = 'new' | 'in_progress' | 'resolved';
export type FeedbackRow = {
  id: string;
  university_id: string;
  author_name: string;
  author_code: string | null;
  author_type: 'student' | 'doctor' | 'employee' | 'supervisor';
  kind: FeedbackKind;
  body: string;
  image_paths: string[];
  status: FeedbackStatus;
  reply: string | null;
  replied_at: string | null;
  created_at: string;
  trip_direction: 'outbound' | 'return' | null;
  trip_time: string | null;
  route_name: string | null;
};

export const FEEDBACK_COLUMNS =
  'id, university_id, author_name, author_code, author_type, kind, body, image_paths, status, reply, replied_at, created_at, trip_direction, trip_time, route_name';

const STATUS_TONE: Record<FeedbackStatus, 'warning' | 'info' | 'success'> = { new: 'warning', in_progress: 'info', resolved: 'success' };

export function StatusBadge({ status }: { status: FeedbackStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{t.feedback.statuses[status]}</Badge>;
}

export function KindBadge({ kind }: { kind: FeedbackKind }) {
  return <Badge tone={kind === 'complaint' ? 'danger' : 'neutral'}>{t.feedback.kinds[kind]}</Badge>;
}

/** «عودة 2:00 م · الخط 3 — الرحلة الثانية»: the trip a complaint is about. */
export function TripLine({ row }: { row: Pick<FeedbackRow, 'trip_direction' | 'trip_time' | 'route_name'> }) {
  if (!row.trip_direction) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 rounded-lg bg-surface px-3 py-2 text-sm font-semibold" data-testid="feedback-trip">
      <Bus className="h-4 w-4 shrink-0 text-brand-ink" aria-hidden />
      <span className="num">
        {t.feedback.directions[row.trip_direction]} {formatClock(row.trip_time)}
      </span>
      <span className="text-muted">·</span>
      <span>{row.route_name ?? t.feedback.noLine}</span>
    </p>
  );
}

/** The submission's photos as thumbnails (signed URLs, private bucket); a tap opens the full photo. */
export function FeedbackImages({ paths }: { paths: string[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const urls = useQuery({
    queryKey: ['feedback-images', paths],
    enabled: paths.length > 0,
    staleTime: 30 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(FEEDBACK_BUCKET).createSignedUrls(paths, 3600);
      if (error) throw error;
      return (data ?? []).map((d) => d.signedUrl).filter((u): u is string => Boolean(u));
    },
  });
  if (!paths.length) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2" data-testid="feedback-images">
        {(urls.data ?? []).map((url, i) => (
          <button
            key={url}
            type="button"
            className="overflow-hidden rounded-lg border border-border"
            onClick={() => setOpen(url)}
            aria-label={t.feedback.openImage(i + 1)}
          >
            <img src={url} alt="" className="h-20 w-20 object-cover" loading="lazy" />
          </button>
        ))}
        {urls.isLoading ? paths.map((p) => <span key={p} className="h-20 w-20 animate-pulse rounded-lg bg-surface" />) : null}
      </div>
      <Dialog open={open !== null} onOpenChange={(o) => (o ? undefined : setOpen(null))} title={t.feedback.image}>
        {open ? <img src={open} alt="" className="max-h-[75vh] w-full rounded-lg object-contain" /> : null}
      </Dialog>
    </>
  );
}
