import webpush from 'web-push';
import type { Config } from '../config.js';
import type { Db } from '../lib/supabase.js';

type PendingNotification = {
  id: string;
  university_id: string;
  student_id: string | null;
  type: string;
  title: string;
  body: string;
};

type PushSubscriptionRow = { id: string; endpoint: string; p256dh: string; auth: string; failure_count: number };

export type PushService = {
  enabled: boolean;
  dispatchPending: () => Promise<{ notifications: number; sent: number }>;
  sendToProfiles: (profileIds: string[], payload: PushPayload) => Promise<number>;
};

export type PushPayload = { title: string; body: string; url: string; tag?: string };

function urlFor(n: PendingNotification): string {
  if (n.student_id) return '/notifications';
  return '/admin/notifications';
}

export function createPushService(cfg: Config, db: Db, log: (msg: string) => void): PushService {
  const enabled = Boolean(cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY);
  if (enabled) webpush.setVapidDetails(cfg.VAPID_SUBJECT, cfg.VAPID_PUBLIC_KEY, cfg.VAPID_PRIVATE_KEY);

  async function sendToProfiles(profileIds: string[], payload: PushPayload): Promise<number> {
    if (!enabled || !profileIds.length) return 0;
    let sent = 0;
    for (let i = 0; i < profileIds.length; i += 200) {
      const { data: subs } = await db
        .from('push_subscriptions')
        .select('id, endpoint, p256dh, auth, failure_count')
        .in('profile_id', profileIds.slice(i, i + 200));
      for (const s of (subs ?? []) as PushSubscriptionRow[]) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            { TTL: 86_400 },
          );
          sent++;
          await db
            .from('push_subscriptions')
            .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
            .eq('id', s.id);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await db.from('push_subscriptions').delete().eq('id', s.id);
          } else {
            await db
              .from('push_subscriptions')
              .update({ failure_count: s.failure_count + 1 })
              .eq('id', s.id);
          }
        }
      }
    }
    return sent;
  }

  async function recipientsFor(n: PendingNotification): Promise<string[]> {
    if (n.student_id) {
      const { data } = await db.from('students').select('profile_id').eq('id', n.student_id).maybeSingle();
      return data?.profile_id ? [data.profile_id as string] : [];
    }
    const { data } = await db
      .from('profiles')
      .select('id, role, university_id')
      .eq('is_active', true)
      .or(`role.eq.admin,and(role.eq.university_supervisor,university_id.eq.${n.university_id})`);
    return (data ?? []).map((p) => p.id as string);
  }

  /** Deliver web push for every notification row created in the last 24h that has not been pushed yet. */
  async function dispatchPending() {
    if (!enabled) return { notifications: 0, sent: 0 };
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const { data, error } = await db
      .from('notifications')
      .select('id, university_id, student_id, type, title, body')
      .is('push_sent_at', null)
      .gte('created_at', since)
      .order('created_at')
      .limit(500);
    if (error) {
      log(`push dispatch query failed: ${error.message}`);
      return { notifications: 0, sent: 0 };
    }
    let sent = 0;
    const rows = (data ?? []) as PendingNotification[];
    for (const n of rows) {
      const recipients = await recipientsFor(n);
      sent += await sendToProfiles(recipients, { title: n.title, body: n.body, url: urlFor(n), tag: n.type });
      await db.from('notifications').update({ push_sent_at: new Date().toISOString() }).eq('id', n.id);
    }
    return { notifications: rows.length, sent };
  }

  return { enabled, dispatchPending, sendToProfiles };
}
