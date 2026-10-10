import type { QueryClient } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

/**
 * Which cached queries (by the first element of their query key) show data from each table.
 * A change to a table refetches only the screens that display it. Realtime delivers a change
 * only to users whose row-level security lets them read that row.
 */
const TABLE_QUERIES: Record<string, string[]> = {
  universities: ['universities', 'logo', 'me', 'admin-dashboard'],
  colleges: ['colleges', 'student-form', 'students', 'student', 'attendance-by-college'],
  areas: ['areas', 'area-mapping', 'student-form', 'my-setup', 'schedule-stats', 'work-day-stats', 'pickup-outbound-stats'],
  packages: ['packages', 'package-subscribers', 'student-dashboard', 'admin-dashboard'],
  routes: ['routes', 'pickup-return-times', 'route-path'],
  route_stops: ['routes', 'route-path'],
  stops: ['stops', 'routes', 'pickup-outbound-stats', 'pickup-return-stats', 'pickup-bookings', 'route-path', 'work-day-stats'],
  profiles: ['me', 'supervisors', 'scan-supervisors', 'audit-actors', 'student'],
  students: ['students', 'student', 'student-dashboard', 'admin-dashboard', 'active-students', 'cards', 'student-form', 'setup-progress', 'my-setup', 'me', 'package-subscribers', 'attendance-by-college', 'work-day-stats', 'schedule-stats', 'pickup-bookings', 'pickup-people'],
  subscriptions: ['student-dashboard', 'student', 'students', 'adjustments', 'package-subscribers', 'admin-dashboard', 'cards'],
  subscription_adjustments: ['adjustments', 'student-dashboard', 'student', 'admin-dashboard'],
  scans: ['scan-log', 'student-scans', 'my-scans-today', 'student-dashboard', 'admin-dashboard', 'student', 'bus-stats', 'bus-riders'],
  settings: ['settings', 'settings-rows', 'pickup-window'],
  broadcasts: ['broadcasts'],
  notifications: ['notifications', 'unread-count', 'staff-notifications', 'student-dashboard'],
  notification_reads: ['notifications', 'unread-count', 'staff-notifications'],
  recurring_notifications: ['recurring'],
  pickup_choices: ['my-pickups', 'pickup-outbound-stats', 'pickup-return-stats', 'pickup-days', 'pickup-people', 'pickup-bookings'],
  student_schedule: ['student-schedule', 'schedule-stats', 'setup-progress', 'my-setup', 'attendance-by-college'],
  audit_log: ['audit', 'audit-actors'],
  buses: ['buses', 'bus-stats', 'scan-buses'],
};

export const REALTIME_TABLES = Object.keys(TABLE_QUERIES);

/**
 * Keeps every open screen live: subscribes once per signed-in session and, a moment after changes
 * arrive, refetches the affected queries (bursts, like a bulk import, collapse into one refetch).
 * After a dropped connection comes back, everything on screen is refetched to catch missed changes.
 */
export function startRealtimeSync(qc: QueryClient): () => void {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let everSubscribed = false;

  const flush = () => {
    timer = null;
    const keys = new Set(pending);
    pending.clear();
    void qc.invalidateQueries({ predicate: (q) => keys.has(String(q.queryKey[0])) });
  };
  const queue = (table: string) => {
    for (const key of TABLE_QUERIES[table] ?? []) pending.add(key);
    timer ??= setTimeout(flush, 250);
  };

  let channel: RealtimeChannel = supabase.channel('app-sync');
  for (const table of REALTIME_TABLES) {
    channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => queue(table));
  }
  channel.subscribe((status) => {
    if (status !== 'SUBSCRIBED') return;
    if (everSubscribed) void qc.invalidateQueries();
    everSubscribed = true;
    if (typeof document !== 'undefined') document.documentElement.dataset.realtime = 'on';
  });

  return () => {
    if (timer) clearTimeout(timer);
    if (typeof document !== 'undefined') delete document.documentElement.dataset.realtime;
    void supabase.removeChannel(channel);
  };
}
