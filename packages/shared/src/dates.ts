/**
 * Date helpers. All business dates are calendar dates in Asia/Damascus (fixed UTC+3, no DST),
 * represented as ISO strings `YYYY-MM-DD`.
 */
export const DAMASCUS_OFFSET_MINUTES = 180;
export const DAMASCUS_TZ = 'Asia/Damascus';

const DAY_MS = 86_400_000;

function parseIsoDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`Invalid ISO date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Damascus calendar date of an instant. */
export function damascusDate(instant: Date = new Date()): string {
  return formatUtcDate(instant.getTime() + DAMASCUS_OFFSET_MINUTES * 60_000);
}

/** The Damascus wall-clock hour (0-23) of an instant. */
export function damascusHour(instant: Date = new Date()): number {
  return new Date(instant.getTime() + DAMASCUS_OFFSET_MINUTES * 60_000).getUTCHours();
}

/** Convert a Damascus wall-clock date+time to an instant. */
export function damascusInstant(date: string, time = '00:00'): Date {
  const [h, m] = time.split(':').map(Number);
  return new Date(parseIsoDate(date) + ((h ?? 0) * 60 + (m ?? 0) - DAMASCUS_OFFSET_MINUTES) * 60_000);
}

export function addDays(date: string, days: number): string {
  return formatUtcDate(parseIsoDate(date) + days * DAY_MS);
}

export function diffDays(a: string, b: string): number {
  return Math.round((parseIsoDate(a) - parseIsoDate(b)) / DAY_MS);
}

/** ISO weekday: 1=Monday .. 7=Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(parseIsoDate(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The most recent date <= `date` whose ISO weekday equals `weekStartDow`. */
export function weekStart(date: string, weekStartDow: number): string {
  if (weekStartDow < 1 || weekStartDow > 7) throw new Error(`Invalid week start day: ${weekStartDow}`);
  const back = (isoWeekday(date) - weekStartDow + 7) % 7;
  return addDays(date, -back);
}

/** `YYYY-MM-DD` → `dd/MM/yyyy`. */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '';
  const [y, m, d] = date.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Instant → `dd/MM/yyyy h:mm ص|م` in Damascus time. */
export function formatDateTime(instant: string | Date | null | undefined): string {
  if (!instant) return '';
  const t = new Date(new Date(instant).getTime() + DAMASCUS_OFFSET_MINUTES * 60_000);
  const iso = t.toISOString();
  return `${formatDate(iso.slice(0, 10))} ${formatClock(iso.slice(11, 16))}`;
}

/** Instant → `h:mm ص|م` in Damascus time. */
export function formatTime(instant: string | Date | null | undefined): string {
  if (!instant) return '';
  const t = new Date(new Date(instant).getTime() + DAMASCUS_OFFSET_MINUTES * 60_000);
  return formatClock(t.toISOString().slice(11, 16));
}

/** `HH:MM[:SS]` → 12-hour clock with the Arabic marks: `08:00` → «8:00 ص», `14:30` → «2:30 م». */
export function formatClock(time: string | null | undefined): string {
  const m = time ? /^(\d{1,2}):(\d{2})/.exec(time) : null;
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'ص' : 'م'}`;
}
