import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatClock, normalizePhone, OUTBOUND_SLOTS, RETURN_SLOTS, SHIFT_STARTS } from '@somar/shared';
import { useAuth } from '@/app/auth';
import { CreditFooter, Logo } from '@/components/common';
import { Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { ListSkeleton } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { stopLabel, useStopOptions } from '@/features/admin/common';

export type DayRow = { dow: number; on: boolean; outbound: string; ret: string };
export type ScheduleRow = { dow: number; outbound_time: string; return_time: string };

/** Week order starting from the university's week-start day. */
function weekOrder(start: number): number[] {
  return Array.from({ length: 7 }, (_, i) => ((start - 1 + i) % 7) + 1);
}

/** Editor rows for all seven days; with no saved schedule the current work days start ticked. */
export function toDayRows(weekStart: number, schedule: ScheduleRow[], workDays: number[]): DayRow[] {
  return weekOrder(weekStart).map((dow) => {
    const row = schedule.find((x) => x.dow === dow);
    return {
      dow,
      on: row ? true : schedule.length === 0 && workDays.includes(dow),
      outbound: row?.outbound_time.slice(0, 5) ?? '',
      ret: row?.return_time.slice(0, 5) ?? '',
    };
  });
}

/** Arabic message for the first problem in the ticked days, or null when they can be saved. */
export function scheduleProblem(days: DayRow[]): string | null {
  const s = t.setup.errors;
  const active = days.filter((d) => d.on);
  if (!active.length) return s.noDays ?? null;
  if (active.some((d) => !d.outbound || !d.ret)) return s.missingTime ?? null;
  if (active.some((d) => d.ret <= d.outbound)) return s.order ?? null;
  return null;
}

export function toSchedulePayload(days: DayRow[]) {
  return days.filter((d) => d.on).map((d) => ({ dow: d.dow, outbound: d.outbound, return: d.ret }));
}

type SetupData = {
  student: {
    kind: 'student' | 'doctor' | 'employee';
    phone_e164: string | null;
    college_id: string | null;
    shift_start: string | null;
    area_primary_id: string | null;
    residence_text: string | null;
    work_days: number[];
  };
  schedule: ScheduleRow[];
  areas: { id: string; name: string }[];
  colleges: { id: string; name: string }[];
  weekStart: number;
};

function useSetupData(studentId: string | undefined, universityId: string | undefined) {
  return useQuery({
    queryKey: ['my-setup', studentId],
    enabled: Boolean(studentId && universityId),
    queryFn: async (): Promise<SetupData> => {
      const [student, schedule, areas, colleges, university] = await Promise.all([
        supabase
          .from('students')
          .select('kind, phone_e164, college_id, shift_start, area_primary_id, residence_text, work_days')
          .eq('id', studentId as string)
          .single(),
        supabase.from('student_schedule').select('dow, outbound_time, return_time').eq('student_id', studentId as string),
        supabase.from('areas').select('id, name').eq('university_id', universityId as string).eq('is_active', true).order('name'),
        supabase.from('colleges').select('id, name').eq('university_id', universityId as string).eq('is_active', true).order('name'),
        supabase.from('universities').select('week_start_dow').eq('id', universityId as string).single(),
      ]);
      return {
        student: unwrap(student) as SetupData['student'],
        schedule: unwrap(schedule) as ScheduleRow[],
        areas: unwrap(areas) as SetupData['areas'],
        colleges: unwrap(colleges) as SetupData['colleges'],
        weekStart: (unwrap(university) as { week_start_dow: number }).week_start_dow,
      };
    },
  });
}

/** Times offered in the schedule dropdowns: every quarter hour from 06:00 to 22:00. */
export const TIME_OPTIONS = Array.from({ length: (22 - 6) * 4 + 1 }, (_, i) => {
  const m = 6 * 60 + i * 15;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});

/** The bus slots a student may choose: leave at 8, 10 or 12; come back at 11:30, 2 or 3:30. */
export const OUTBOUND_OPTIONS: readonly string[] = OUTBOUND_SLOTS;
export const RETURN_OPTIONS: readonly string[] = RETURN_SLOTS;

/** 08:00 → «8:00 ص», 14:30 → «2:30 م» (the app's 12-hour clock). */
export const timeLabel = formatClock;

type Step =
  | { kind: 'phone' }
  | { kind: 'college' }
  | { kind: 'shift' }
  | { kind: 'area' }
  | { kind: 'residence' }
  | { kind: 'days' }
  | { kind: 'times'; dow: number }
  | { kind: 'review' };

/**
 * First-login questionnaire, one question per screen. Asks only what the administration does not
 * have yet (phone, college, shift start), then the area, residence, work days and each day's times.
 */
function SetupWizard() {
  const s = t.setup;
  const { me, refreshMe } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const data = useSetupData(me?.student?.id, me?.student?.university_id);
  const [phone, setPhone] = useState('');
  const [collegeId, setCollegeId] = useState('');
  const [shift, setShift] = useState('');
  const [areaId, setAreaId] = useState('');
  const [residence, setResidence] = useState('');
  const [days, setDays] = useState<DayRow[]>([]);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (!data.data) return;
    const { student, schedule, weekStart } = data.data;
    setAreaId(student.area_primary_id ?? '');
    setResidence(student.residence_text ?? '');
    // a time outside the bus slots must be chosen again
    setDays(
      toDayRows(weekStart, schedule, student.work_days).map((d) => ({
        ...d,
        outbound: OUTBOUND_OPTIONS.includes(d.outbound) ? d.outbound : '',
        ret: RETURN_OPTIONS.includes(d.ret) ? d.ret : '',
      })),
    );
  }, [data.data]);

  const steps = useMemo<Step[]>(() => {
    if (!data.data) return [];
    const st = data.data.student;
    const out: Step[] = [];
    if (!st.phone_e164) out.push({ kind: 'phone' });
    if (st.kind === 'student' && !st.college_id) out.push({ kind: 'college' });
    if (st.kind === 'student' && !st.shift_start) out.push({ kind: 'shift' });
    out.push({ kind: 'area' }, { kind: 'residence' }, { kind: 'days' });
    for (const d of days) if (d.on) out.push({ kind: 'times', dow: d.dow });
    out.push({ kind: 'review' });
    return out;
  }, [data.data, days]);

  const save = useMutation({
    mutationFn: async () => {
      const p = phone.trim() ? normalizePhone(phone) : null;
      return unwrap(
        await supabase.rpc('complete_my_setup', {
          p_area_id: areaId,
          p_residence: residence,
          p_schedule: toSchedulePayload(days),
          p_phone: p?.ok ? p.value : null,
          p_college_id: collegeId || null,
          p_shift_start: shift || null,
        }),
      );
    },
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['my-setup'] });
      void qc.invalidateQueries({ queryKey: ['student-dashboard'] });
      await refreshMe();
      navigate('/', { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  if (data.isLoading || !data.data || !steps.length) return <ListSkeleton rows={4} />;
  if (data.data.student.kind !== 'student') return <MemberStopStep universityId={me?.student?.university_id as string} />;
  const position = Math.min(index, steps.length - 1);
  const step = steps[position] as Step;
  const dayRow = step.kind === 'times' ? days.find((d) => d.dow === step.dow) : undefined;
  const updateDay = (dow: number, patch: Partial<DayRow>) => setDays((all) => all.map((d) => (d.dow === dow ? { ...d, ...patch } : d)));

  /** The problem with the current answer, or null to move on. */
  const problem = (): string | null => {
    switch (step.kind) {
      case 'phone':
        return normalizePhone(phone).ok ? null : (s.errors.phone ?? null);
      case 'college':
        return collegeId ? null : (s.errors.college ?? null);
      case 'shift':
        return shift ? null : (s.errors.shift ?? null);
      case 'area':
        return areaId ? null : (s.errors.area ?? null);
      case 'days':
        return days.some((d) => d.on) ? null : (s.errors.noDays ?? null);
      case 'times':
        if (!dayRow?.outbound || !dayRow.ret) return s.errors.missingTime ?? null;
        return dayRow.ret <= dayRow.outbound ? (s.errors.order ?? null) : null;
      default:
        return null;
    }
  };
  const next = (e: FormEvent) => {
    e.preventDefault();
    const p = problem();
    setError(p);
    if (p) return;
    if (step.kind === 'review') save.mutate();
    else setIndex(position + 1);
  };
  const back = () => {
    setError(null);
    setIndex(Math.max(0, position - 1));
  };

  const areaName = data.data.areas.find((a) => a.id === areaId)?.name;
  const collegeName = data.data.colleges.find((c) => c.id === collegeId)?.name;
  const title = (text: string) => <span className="text-lg font-bold">{text}</span>;

  return (
    <form className="space-y-4" onSubmit={next} noValidate>
      <SetupHeader title={s.title} intro={s.intro} />
      <div>
        <p className="mb-1 text-xs font-semibold text-muted" data-testid="setup-progress">
          {s.progress(position + 1, steps.length)}
        </p>
        <div className="h-2 overflow-hidden rounded-full bg-bg" aria-hidden>
          <div className="h-full rounded-full bg-brand-ink transition-all" style={{ width: `${((position + 1) / steps.length) * 100}%` }} />
        </div>
      </div>

      <Card className="space-y-4" data-testid={`setup-step-${step.kind}`}>
        {step.kind === 'phone' ? (
          <Field label={title(s.q.phone)} htmlFor={inputId} hint={s.hint.phone}>
            <Input id={inputId} inputMode="tel" dir="ltr" className="text-start" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="setup-phone" />
          </Field>
        ) : null}
        {step.kind === 'college' ? (
          <Field label={title(s.q.college)} htmlFor={inputId}>
            <Select id={inputId} value={collegeId} onChange={(e) => setCollegeId(e.target.value)} data-testid="setup-college">
              <option value="">{t.common.select}</option>
              {data.data.colleges.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {step.kind === 'shift' ? (
          <Field label={title(s.q.shift)} htmlFor={inputId}>
            <Select id={inputId} value={shift} onChange={(e) => setShift(e.target.value)} data-testid="setup-shift">
              <option value="">{t.common.select}</option>
              {SHIFT_STARTS.map((x) => (
                <option key={x} value={x}>
                  {timeLabel(x)}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {step.kind === 'area' ? (
          <Field label={title(s.q.area)} htmlFor={inputId}>
            <Select id={inputId} value={areaId} onChange={(e) => setAreaId(e.target.value)} data-testid="setup-area">
              <option value="">{t.common.select}</option>
              {data.data.areas.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {step.kind === 'residence' ? (
          <Field label={title(s.q.residence)} htmlFor={inputId} hint={s.hint.residence}>
            <Input id={inputId} value={residence} placeholder={s.residencePlaceholder} onChange={(e) => setResidence(e.target.value)} data-testid="setup-residence" />
          </Field>
        ) : null}
        {step.kind === 'days' ? (
          <div className="space-y-3">
            {title(s.q.days)}
            <p className="text-sm text-muted">{s.hint.days}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {days.map((d) => (
                <button
                  key={d.dow}
                  type="button"
                  aria-pressed={d.on}
                  onClick={() => updateDay(d.dow, { on: !d.on })}
                  className={cn(
                    'min-h-touch rounded-lg border px-3 text-base font-semibold',
                    d.on ? 'border-brand-ink bg-brand-ink text-on-ink' : 'border-border bg-bg',
                  )}
                  data-testid={`day-${d.dow}`}
                >
                  {t.days[d.dow]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {step.kind === 'times' && dayRow ? (
          <div className="space-y-3">
            {title(s.q.times(t.days[dayRow.dow] ?? ''))}
            <TimeSelect
              label={s.outbound}
              value={dayRow.outbound}
              options={OUTBOUND_OPTIONS}
              onChange={(v) => updateDay(dayRow.dow, { outbound: v })}
              testId={`out-${dayRow.dow}`}
            />
            <TimeSelect
              label={s.return}
              value={dayRow.ret}
              options={RETURN_OPTIONS}
              onChange={(v) => updateDay(dayRow.dow, { ret: v })}
              testId={`ret-${dayRow.dow}`}
            />
          </div>
        ) : null}
        {step.kind === 'review' ? (
          <div className="space-y-3">
            {title(s.q.review)}
            <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
              {phone.trim() ? (
                <>
                  <dt className="text-muted">{t.student.phone}</dt>
                  <dd className="num text-start" dir="ltr">
                    {phone}
                  </dd>
                </>
              ) : null}
              {collegeName ? (
                <>
                  <dt className="text-muted">{t.student.college}</dt>
                  <dd>{collegeName}</dd>
                </>
              ) : null}
              {shift ? (
                <>
                  <dt className="text-muted">{t.student.shiftStart}</dt>
                  <dd>{timeLabel(shift)}</dd>
                </>
              ) : null}
              <dt className="text-muted">{t.student.area}</dt>
              <dd>{areaName}</dd>
              {residence.trim() ? (
                <>
                  <dt className="text-muted">{t.student.residence}</dt>
                  <dd>{residence}</dd>
                </>
              ) : null}
              {days
                .filter((d) => d.on)
                .map((d) => (
                  <Fragment key={d.dow}>
                    <dt className="text-muted">{t.days[d.dow]}</dt>
                    <dd>
                      {s.outbound} {timeLabel(d.outbound)} · {s.return} {timeLabel(d.ret)}
                    </dd>
                  </Fragment>
                ))}
            </dl>
            <p className="text-xs text-muted">{s.workDaysNote}</p>
          </div>
        ) : null}
      </Card>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-3">
        {position > 0 ? (
          <Button type="button" size="lg" className="flex-1" onClick={back} data-testid="setup-back">
            {t.common.back}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="flex-[2]"
          disabled={save.isPending}
          data-testid={step.kind === 'review' ? 'setup-save' : 'setup-next'}
        >
          {step.kind === 'review' ? (save.isPending ? t.common.saving : s.save) : s.next}
        </Button>
      </div>
    </form>
  );
}

function SetupHeader({ title, intro }: { title: string; intro: string }) {
  return (
    <div className="mb-5 flex flex-col items-center gap-3 text-center">
      <Logo className="h-14" />
      <h1 className="text-2xl font-extrabold text-brand-ink">{title}</h1>
      <p className="text-sm text-muted">{intro}</p>
    </div>
  );
}

/** Doctors and university employees: one question, their nearest stop from the stop library. */
function MemberStopStep({ universityId }: { universityId: string }) {
  const s = t.setup;
  const { refreshMe } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const stops = useStopOptions(universityId);
  const [stopId, setStopId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const save = useMutation({
    mutationFn: async () => unwrap(await supabase.rpc('complete_member_setup', { p_stop_id: stopId })),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['my-setup'] });
      void qc.invalidateQueries({ queryKey: ['student-dashboard'] });
      await refreshMe();
      navigate('/', { replace: true });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problem = stopId ? null : (s.errors.stop ?? null);
    setError(problem);
    if (!problem) save.mutate();
  };
  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <SetupHeader title={s.memberTitle} intro={s.memberIntro} />
      <Card className="space-y-4" data-testid="setup-step-stop">
        <Field label={<span className="text-lg font-bold">{s.q.stop}</span>} htmlFor={id} hint={s.hint.stop}>
          <Select id={id} value={stopId} onChange={(e) => setStopId(e.target.value)} disabled={stops.isLoading} data-testid="setup-stop">
            <option value="">{t.common.select}</option>
            {(stops.data ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {stopLabel(x)}
              </option>
            ))}
          </Select>
        </Field>
      </Card>
      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={save.isPending} data-testid="setup-save">
        {save.isPending ? t.common.saving : s.save}
      </Button>
    </form>
  );
}

function TimeSelect({ label, value, onChange, testId, options: allowed = TIME_OPTIONS }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  options?: readonly string[];
}) {
  const id = useId();
  const options = value && !allowed.includes(value) ? [value, ...allowed] : allowed;
  return (
    <Field label={label} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        <option value="">{t.common.select}</option>
        {options.map((x) => (
          <option key={x} value={x}>
            {timeLabel(x)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Blocking first-login step, right after the password change (the photo comes next). Students answer
 * the questionnaire; doctors and university employees pick their nearest stop. */
export function SetupPage() {
  return (
    <main className="min-h-dvh bg-surface px-4 py-6">
      <div className="mx-auto max-w-lg">
        <SetupWizard />
        <CreditFooter />
      </div>
    </main>
  );
}

/** Ticks and the outbound/return slot of each weekday (staff editor); one line per dropdown on phones. */
export function DaysEditor({ days, onChange }: { days: DayRow[]; onChange: (days: DayRow[]) => void }) {
  const s = t.setup;
  const update = (dow: number, patch: Partial<DayRow>) => onChange(days.map((d) => (d.dow === dow ? { ...d, ...patch } : d)));
  return (
    <ul className="space-y-2" data-testid="setup-days">
      {days.map((d) => (
        <li key={d.dow} className={cn('rounded-lg border p-3', d.on ? 'border-brand-ink/40 bg-surface' : 'border-border')}>
          <label className="flex min-h-touch items-center gap-3 font-semibold">
            <input
              type="checkbox"
              className="h-5 w-5 accent-[var(--brand-ink)]"
              checked={d.on}
              onChange={(e) => update(d.dow, { on: e.target.checked })}
              data-testid={`day-${d.dow}`}
            />
            {t.days[d.dow]}
          </label>
          {d.on ? (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
              <TimeSelect label={s.outbound} value={d.outbound} options={OUTBOUND_OPTIONS} onChange={(v) => update(d.dow, { outbound: v })} testId={`out-${d.dow}`} />
              <TimeSelect label={s.return} value={d.ret} options={RETURN_OPTIONS} onChange={(v) => update(d.dow, { ret: v })} testId={`ret-${d.dow}`} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
