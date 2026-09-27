import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/app/auth';
import { CreditFooter, Logo } from '@/components/common';
import { SearchPicker } from '@/components/SearchPicker';
import { useToast } from '@/components/ui/overlay';
import { Button, Card, Field, Input } from '@/components/ui/primitives';
import { ListSkeleton, PageHeader } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type DayRow = { dow: number; on: boolean; outbound: string; ret: string };

/** Week order starting from the university's week-start day. */
function weekOrder(start: number): number[] {
  return Array.from({ length: 7 }, (_, i) => ((start - 1 + i) % 7) + 1);
}

function useSetupData(studentId: string | undefined, universityId: string | undefined) {
  return useQuery({
    queryKey: ['my-setup', studentId],
    enabled: Boolean(studentId && universityId),
    queryFn: async () => {
      const [student, schedule, areas, university] = await Promise.all([
        supabase.from('students').select('area_primary_id, residence_text, work_days').eq('id', studentId as string).single(),
        supabase.from('student_schedule').select('dow, outbound_time, return_time').eq('student_id', studentId as string),
        supabase.from('areas').select('id, name').eq('university_id', universityId as string).eq('is_active', true).order('name'),
        supabase.from('universities').select('week_start_dow').eq('id', universityId as string).single(),
      ]);
      return {
        student: unwrap(student) as { area_primary_id: string | null; residence_text: string | null; work_days: number[] },
        schedule: unwrap(schedule) as { dow: number; outbound_time: string; return_time: string }[],
        areas: unwrap(areas) as { id: string; name: string }[],
        weekStart: (unwrap(university) as { week_start_dow: number }).week_start_dow,
      };
    },
  });
}

export function SetupForm({ mode }: { mode: 'first' | 'edit' }) {
  const s = t.setup;
  const { me, refreshMe } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const data = useSetupData(me?.student?.id, me?.student?.university_id);
  const [areaId, setAreaId] = useState('');
  const [residence, setResidence] = useState('');
  const [days, setDays] = useState<DayRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const residenceId = useId();

  useEffect(() => {
    if (!data.data) return;
    const { student, schedule, weekStart } = data.data;
    setAreaId(student.area_primary_id ?? '');
    setResidence(student.residence_text ?? '');
    setDays(
      weekOrder(weekStart).map((dow) => {
        const row = schedule.find((x) => x.dow === dow);
        return {
          dow,
          on: row ? true : schedule.length === 0 && student.work_days.includes(dow),
          outbound: row?.outbound_time.slice(0, 5) ?? '',
          ret: row?.return_time.slice(0, 5) ?? '',
        };
      }),
    );
  }, [data.data]);

  const save = useMutation({
    mutationFn: async () =>
      unwrap(
        await supabase.rpc('save_my_setup', {
          p_area_id: areaId,
          p_residence: residence,
          p_schedule: days.filter((d) => d.on).map((d) => ({ dow: d.dow, outbound: d.outbound, return: d.ret })),
        }),
      ),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['my-setup'] });
      void qc.invalidateQueries({ queryKey: ['student-dashboard'] });
      await refreshMe();
      if (mode === 'first') navigate('/', { replace: true });
      else toast.success(s.saved);
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const active = days.filter((d) => d.on);
    const problem = !areaId
      ? s.errors.area
      : !active.length
        ? s.errors.noDays
        : active.some((d) => !d.outbound || !d.ret)
          ? s.errors.missingTime
          : active.some((d) => d.ret <= d.outbound)
            ? s.errors.order
            : null;
    setError(problem ?? null);
    if (!problem) save.mutate();
  };

  const update = (dow: number, patch: Partial<DayRow>) => setDays((all) => all.map((d) => (d.dow === dow ? { ...d, ...patch } : d)));

  if (data.isLoading || !data.data) return <ListSkeleton rows={4} />;

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <Card className="space-y-3">
        <p className="font-bold">{s.area}</p>
        <SearchPicker
          items={data.data.areas}
          value={areaId}
          onChange={setAreaId}
          placeholder={s.areaSearch}
          label={s.area}
          emptyText={s.areaEmpty}
          testId="setup-area"
        />
        <Field label={s.residence} htmlFor={residenceId}>
          <Input id={residenceId} value={residence} placeholder={s.residencePlaceholder} onChange={(e) => setResidence(e.target.value)} />
        </Field>
      </Card>

      <Card className="space-y-3">
        <div>
          <p className="font-bold">{s.schedule}</p>
          <p className="text-sm text-muted">{s.scheduleHint}</p>
        </div>
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
                <div className="mt-2 grid grid-cols-2 gap-3">
                  <label className="text-sm">
                    <span className="mb-1 block text-muted">{s.outbound}</span>
                    <Input type="time" step={300} value={d.outbound} onChange={(e) => update(d.dow, { outbound: e.target.value })} data-testid={`out-${d.dow}`} />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted">{s.return}</span>
                    <Input type="time" step={300} value={d.ret} onChange={(e) => update(d.dow, { ret: e.target.value })} data-testid={`ret-${d.dow}`} />
                  </label>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">{s.workDaysNote}</p>
      </Card>

      {error ? (
        <p role="alert" className="rounded-lg bg-danger/10 p-3 text-sm font-semibold text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" size="lg" className="w-full" disabled={save.isPending} data-testid="setup-save">
        {save.isPending ? t.common.saving : mode === 'first' ? s.save : s.saveEdit}
      </Button>
    </form>
  );
}

/** Blocking first-login step (after password change and photo). */
export function SetupPage() {
  return (
    <main className="min-h-dvh bg-surface px-4 py-6">
      <div className="mx-auto max-w-lg">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <Logo className="h-14" />
          <h1 className="text-2xl font-extrabold text-brand-ink">{t.setup.title}</h1>
          <p className="text-sm text-muted">{t.setup.intro}</p>
        </div>
        <SetupForm mode="first" />
        <CreditFooter />
      </div>
    </main>
  );
}

/** The same form, editable later from «حسابي». */
export function EditSchedulePage() {
  return (
    <div>
      <PageHeader title={t.setup.editTitle} />
      <SetupForm mode="edit" />
    </div>
  );
}
