import { useId } from 'react';
import { t } from '@/i18n/ar';
import { cn } from '@/lib/utils';
import { Select } from './primitives';

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` → hour 1–12, minute, and AM/PM; null parts when empty. */
function split(value: string) {
  const m = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!m) return { h12: null, minute: null, pm: null };
  const h = Number(m[1]);
  return { h12: h % 12 === 0 ? 12 : h % 12, minute: Number(m[2]), pm: h >= 12 };
}

/** hour 1–12 + minute + AM/PM → `HH:MM`. */
function join(h12: number, minute: number, pm: boolean) {
  const h = (h12 % 12) + (pm ? 12 : 0);
  return `${pad(h)}:${pad(minute)}`;
}

/**
 * A 12-hour time picker (hour, minutes, ص/م) that reads and writes `HH:MM`, so the whole app shows
 * times the same way whatever the device's clock setting (the browser's own time field follows it).
 */
export function TimeInput12({
  id,
  value,
  onChange,
  disabled,
  testId,
  minuteStep = 5,
  className,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  testId?: string;
  minuteStep?: number;
  className?: string;
}) {
  const fallbackId = useId();
  const hourId = id ?? fallbackId;
  const { h12, minute, pm } = split(value);
  const steps = Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep);
  // a saved minute off the step (e.g. :07) stays selectable
  const minutes = minute !== null && !steps.includes(minute) ? [...steps, minute].sort((a, b) => a - b) : steps;
  // a part chosen before the hour waits for it; the other parts default to «:00 ص»
  const set = (patch: { h12?: number; minute?: number; pm?: boolean }) => {
    const next = { h12: patch.h12 ?? h12, minute: patch.minute ?? minute ?? 0, pm: patch.pm ?? pm ?? false };
    onChange(next.h12 === null ? '' : join(next.h12, next.minute, next.pm));
  };
  return (
    <div className={cn('flex items-center gap-1.5', className)} dir="ltr" data-testid={testId}>
      <Select
        id={hourId}
        aria-label={t.time.hour}
        className="w-[4.5rem] text-center"
        disabled={disabled}
        value={h12 ?? ''}
        onChange={(e) => set({ h12: Number(e.target.value) })}
        data-testid={testId ? `${testId}-hour` : undefined}
      >
        <option value="" disabled>
          --
        </option>
        {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </Select>
      <span className="font-bold text-muted">:</span>
      <Select
        aria-label={t.time.minute}
        className="w-[4.5rem] text-center"
        disabled={disabled}
        value={minute ?? ''}
        onChange={(e) => set({ minute: Number(e.target.value) })}
        data-testid={testId ? `${testId}-minute` : undefined}
      >
        <option value="" disabled>
          --
        </option>
        {minutes.map((m) => (
          <option key={m} value={m}>
            {pad(m)}
          </option>
        ))}
      </Select>
      <Select
        aria-label={t.time.period}
        className="w-[4.5rem] text-center"
        disabled={disabled}
        value={pm === null ? '' : pm ? 'pm' : 'am'}
        onChange={(e) => set({ pm: e.target.value === 'pm' })}
        data-testid={testId ? `${testId}-period` : undefined}
      >
        <option value="" disabled>
          --
        </option>
        <option value="am">{t.time.am}</option>
        <option value="pm">{t.time.pm}</option>
      </Select>
    </div>
  );
}
