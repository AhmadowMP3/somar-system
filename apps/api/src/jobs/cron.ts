import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../lib/supabase.js';
import type { PushService } from '../services/push.js';

/**
 * Scheduled work (single instance, Asia/Damascus):
 * - hourly: run_daily_jobs() — each university is evaluated once its `daily_job_hour` has passed;
 *   idempotent per day, so restarts and repeated hours never double-send.
 * - every minute: write due recurring notifications (run_recurring_notifications, once per day each), then
 *   deliver web push for notification rows not yet pushed (covers DB-trigger notifications).
 */
export function startCron(db: Db, push: PushService, log: FastifyBaseLogger): () => void {
  let dailyRunning = false;
  let pushRunning = false;

  const runDaily = async () => {
    if (dailyRunning) return;
    dailyRunning = true;
    try {
      const { data, error } = await db.rpc('run_daily_jobs', { p_force: false });
      if (error) log.error({ err: error.message }, 'daily job failed');
      else log.info({ result: data }, 'daily job completed');
      await push.dispatchPending();
    } finally {
      dailyRunning = false;
    }
  };

  const runPush = async () => {
    if (pushRunning) return;
    pushRunning = true;
    try {
      const { data, error } = await db.rpc('run_recurring_notifications');
      if (error) log.error({ err: error.message }, 'recurring notifications failed');
      else if (data) log.info({ notifications: data }, 'recurring notifications written');
      if (push.enabled) await push.dispatchPending();
    } catch (err) {
      log.error(err, 'push dispatch failed');
    } finally {
      pushRunning = false;
    }
  };

  const tasks = [
    cron.schedule('5 * * * *', () => void runDaily(), { timezone: 'Asia/Damascus' }),
    cron.schedule('* * * * *', () => void runPush(), { timezone: 'Asia/Damascus' }),
  ];
  void runDaily();
  return () => tasks.forEach((t) => t.stop());
}
