import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { checkFullName, normalizePhone, type MemberKind } from '@somar/shared';
import { useToast } from '@/components/ui/overlay';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { DayToggles, stopLabel, useAreas, useStopOptions, WithUniversity } from './common';
import { memberPath } from './MembersPage';

type FormState = {
  full_name: string;
  phone: string;
  job_title: string;
  residence_text: string;
  area_primary_id: string;
  home_stop_id: string;
  work_days: number[];
  work_hours_text: string;
  notes: string;
};

const EMPTY: FormState = {
  full_name: '',
  phone: '',
  job_title: '',
  residence_text: '',
  area_primary_id: '',
  home_stop_id: '',
  work_days: [],
  work_hours_text: '',
  notes: '',
};

type Existing = {
  id: string;
  university_id: string;
  full_name: string;
  phone_e164: string | null;
  job_title: string | null;
  residence_text: string | null;
  area_primary_id: string | null;
  home_stop_id: string | null;
  work_days: number[];
  work_hours_text: string | null;
  notes: string | null;
};

export default function MemberFormPage({ kind }: { kind: MemberKind }) {
  const { id } = useParams();
  const existing = useQuery({
    queryKey: ['member-form', id],
    enabled: Boolean(id),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('students')
          .select('id, university_id, full_name, phone_e164, job_title, residence_text, area_primary_id, home_stop_id, work_days, work_hours_text, notes')
          .eq('id', id as string)
          .single(),
      ) as Existing,
  });
  if (!id) return <WithUniversity>{(universityId) => <MemberForm kind={kind} universityId={universityId} initial={EMPTY} />}</WithUniversity>;
  return (
    <QueryState query={existing}>
      {(m) => (
        <MemberForm
          kind={kind}
          universityId={m.university_id}
          memberId={m.id}
          initial={{
            full_name: m.full_name,
            phone: m.phone_e164 ?? '',
            job_title: m.job_title ?? '',
            residence_text: m.residence_text ?? '',
            area_primary_id: m.area_primary_id ?? '',
            home_stop_id: m.home_stop_id ?? '',
            work_days: m.work_days,
            work_hours_text: m.work_hours_text ?? '',
            notes: m.notes ?? '',
          }}
        />
      )}
    </QueryState>
  );
}

function MemberForm({ kind, universityId, memberId, initial }: { kind: MemberKind; universityId: string; memberId?: string; initial: FormState }) {
  const m = t.admin.members;
  const k = m[kind];
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const areas = useAreas(universityId);
  const stops = useStopOptions(universityId);
  const [form, setForm] = useState<FormState>(initial);
  const [touched, setTouched] = useState(false);
  const ids = { name: useId(), phone: useId(), job: useId(), area: useId(), stop: useId(), hours: useId(), residence: useId(), notes: useId() };

  const name = checkFullName(form.full_name);
  const phone = form.phone.trim() ? normalizePhone(form.phone) : null;
  const errors = {
    full_name: !name.ok ? (name.reason === 'empty' ? t.shared.import.NAME_REQUIRED : t.shared.import.NAME_TOO_SHORT) : undefined,
    phone: phone && !phone.ok ? t.shared.import.PHONE_INVALID : undefined,
  };
  const valid = Object.values(errors).every((e) => !e);

  const save = useMutation({
    mutationFn: async () => {
      const fields = {
        full_name: name.ok ? name.value : form.full_name.trim(),
        job_title: form.job_title.trim() || null,
        residence_text: form.residence_text.trim() || null,
        area_primary_id: form.area_primary_id || null,
        home_stop_id: form.home_stop_id || null,
        work_days: form.work_days,
        work_hours_text: form.work_hours_text.trim() || null,
        notes: form.notes.trim() || null,
      };
      if (!memberId) {
        const res = await api.post<{ student_id: string; transport_number: string }>('/members', {
          ...fields,
          university_id: universityId,
          kind,
          phone: form.phone.trim() || null,
        });
        return { id: res.student_id, message: k.created(res.transport_number) };
      }
      unwrap(
        await supabase
          .from('students')
          .update({ ...fields, phone_e164: phone?.ok ? phone.value : null })
          .eq('id', memberId),
      );
      return { id: memberId, message: t.common.success };
    },
    onSuccess: ({ id, message }) => {
      toast.success(message);
      void qc.invalidateQueries({ queryKey: ['students'] });
      void qc.invalidateQueries({ queryKey: ['student', id] });
      void qc.invalidateQueries({ queryKey: ['member-form', id] });
      navigate(`${memberPath(kind)}/${id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (valid) save.mutate();
  };
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const show = (msg?: string) => (touched ? msg : undefined);

  return (
    <div>
      <PageHeader title={memberId ? k.edit : k.add} subtitle={m.unlimitedNote} />
      <Card>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={submit} noValidate>
          <Field label={t.student.fullName} htmlFor={ids.name} error={show(errors.full_name)}>
            <Input id={ids.name} value={form.full_name} onChange={(e) => set({ full_name: e.target.value })} data-testid="member-name" />
          </Field>
          <Field label={m.phoneOptional} htmlFor={ids.phone} error={show(errors.phone)}>
            <Input id={ids.phone} inputMode="tel" dir="ltr" className="text-start" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field label={t.student.jobTitle} htmlFor={ids.job}>
            <Input id={ids.job} value={form.job_title} onChange={(e) => set({ job_title: e.target.value })} />
          </Field>
          <Field label={t.student.area} htmlFor={ids.area}>
            <Select id={ids.area} value={form.area_primary_id} onChange={(e) => set({ area_primary_id: e.target.value })}>
              <option value="">{t.common.none}</option>
              {(areas.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.student.homeStop} htmlFor={ids.stop} hint={m.stopHint}>
            <Select id={ids.stop} value={form.home_stop_id} onChange={(e) => set({ home_stop_id: e.target.value })} data-testid="member-stop">
              <option value="">{m.stopPending}</option>
              {(stops.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {stopLabel(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.student.workHours} htmlFor={ids.hours} hint={m.workHoursHint}>
            <Input id={ids.hours} value={form.work_hours_text} onChange={(e) => set({ work_hours_text: e.target.value })} />
          </Field>
          <Field label={t.student.workDays} className="md:col-span-2">
            <DayToggles value={form.work_days} onChange={(d) => set({ work_days: d })} />
          </Field>
          <Field label={t.student.residence} htmlFor={ids.residence} className="md:col-span-2">
            <Textarea id={ids.residence} value={form.residence_text} onChange={(e) => set({ residence_text: e.target.value })} />
          </Field>
          <Field label={m.notes} htmlFor={ids.notes} className="md:col-span-2">
            <Textarea id={ids.notes} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-3 md:col-span-2">
            <Button onClick={() => navigate(-1)}>{t.common.cancel}</Button>
            <Button type="submit" variant="secondary" disabled={save.isPending} data-testid="member-save">
              {save.isPending ? t.common.saving : t.common.save}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
