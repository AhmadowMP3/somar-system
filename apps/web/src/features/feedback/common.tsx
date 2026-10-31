import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
};

export const FEEDBACK_COLUMNS = 'id, university_id, author_name, author_code, author_type, kind, body, image_paths, status, reply, replied_at, created_at';

const STATUS_TONE: Record<FeedbackStatus, 'warning' | 'info' | 'success'> = { new: 'warning', in_progress: 'info', resolved: 'success' };

export function StatusBadge({ status }: { status: FeedbackStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{t.feedback.statuses[status]}</Badge>;
}

export function KindBadge({ kind }: { kind: FeedbackKind }) {
  return <Badge tone={kind === 'complaint' ? 'danger' : 'neutral'}>{t.feedback.kinds[kind]}</Badge>;
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
