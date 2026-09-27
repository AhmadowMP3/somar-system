import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { checkFullName, normalizePhone, normalizeStudentNo, SHIFT_STARTS } from '@somar/shared';
import { useToast } from '@/components/ui/overlay';
import { Button, Card, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { PageHeader, QueryState } from '@/components/ui/states';
import { t } from '@/i18n/ar';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { supabase, unwrap } from '@/lib/supabase';
import { DayToggles, useAreas, useColleges, WithUniversity } from './common';

type FormState = {
  full_name: string;
  university_student_no: string;
  phone: string;
  college_id: string;
  residence_text: string;
  area_primary_id: string;
  area_secondary_id: string;
  area_other_text: string;
  work_days: number[];
  shift_start: string;
};

const EMPTY: FormState = {
  full_name: '',
  university_student_no: '',
  phone: '',
  college_id: '',
  residence_text: '',
  area_primary_id: '',
  area_secondary_id: '',
  area_other_text: '',
  work_days: [],
  shift_start: '08:00',
};

export default function StudentFormPage() {
  const { id } = useParams();
  const existing = useQuery({
    queryKey: ['student-form', id],
    enabled: Boolean(id),
    queryFn: async () =>
      unwrap(
        await supabase
          .from('students')
          .select('id, university_id, full_name, university_student_no, phone_e164, college_id, residence_text, area_primary_id, area_secondary_id, area_other_text, work_days, shift_start')
          .eq('id', id as string)
          .single(),
      ) as {
        id: string;
        university_id: string;
        full_name: string;
        university_student_no: string;
        phone_e164: string;
        college_id: string;
        residence_text: string | null;
        area_primary_id: string | null;
        area_secondary_id: string | null;
        area_other_text: string | null;
        work_days: number[];
        shift_start: string;
      },
  });
  if (!id) return <WithUniversity>{(universityId) => <StudentForm universityId={universityId} initial={EMPTY} />}</WithUniversity>;
  return (
    <QueryState query={existing}>
      {(s) => (
        <StudentForm
          universityId={s.university_id}
          studentId={s.id}
          initial={{
            full_name: s.full_name,
            university_student_no: s.university_student_no,
            phone: s.phone_e164,
            college_id: s.college_id,
            residence_text: s.residence_text ?? '',
            area_primary_id: s.area_primary_id ?? '',
            area_secondary_id: s.area_secondary_id ?? '',
            area_other_text: s.area_other_text ?? '',
            work_days: s.work_days,
            shift_start: s.shift_start.slice(0, 5),
          }}
        />
      )}
    </QueryState>
  );
}

function StudentForm({ universityId, studentId, initial }: { universityId: string; studentId?: string; initial: FormState }) {
  const s = t.admin.students;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const colleges = useColleges(universityId);
  const areas = useAreas(universityId);
  const [form, setForm] = useState<FormState>(initial);
  const [touched, setTouched] = useState(false);
  const ids = {
    name: useId(),
    no: useId(),
    phone: useId(),
    college: useId(),
    residence: useId(),
    a1: useId(),
    a2: useId(),
    other: useId(),
    shift: useId(),
  };

  const name = checkFullName(form.full_name);
  const no = normalizeStudentNo(form.university_student_no);
  const phone = normalizePhone(form.phone);
  const errors = {
    full_name: !name.ok ? (name.reason === 'empty' ? t.shared.import.NAME_REQUIRED : t.shared.import.NAME_TOO_SHORT) : undefined,
    no: !no.ok ? t.shared.import.STUDENT_NO_INVALID : undefined,
    phone: !phone.ok ? t.shared.import.PHONE_INVALID : undefined,
    college: !form.college_id ? t.shared.import.COLLEGE_REQUIRED : undefined,
    days: !form.work_days.length ? t.shared.import.WORK_DAYS_EMPTY : undefined,
  };
  const valid = Object.values(errors).every((e) => !e);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        university_id: universityId,
        college_id: form.college_id,
        full_name: form.full_name,
        university_student_no: form.university_student_no,
        phone: form.phone,
        residence_text: form.residence_text || null,
        area_primary_id: form.area_primary_id || null,
        area_secondary_id: form.area_secondary_id || null,
        area_other_text: form.area_other_text || null,
        work_days: form.work_days,
        shift_start: form.shift_start,
      };
      if (!studentId) {
        const res = await api.post<{ student_id: string; transport_number: string }>('/students', payload);
        return { id: res.student_id, message: s.created(res.transport_number) };
      }
      unwrap(
        await supabase
          .from('students')
          .update({
            full_name: name.ok ? name.value : form.full_name,
            university_student_no: no.ok ? no.value : form.university_student_no,
            phone_e164: phone.ok ? phone.value : form.phone,
            college_id: form.college_id,
            residence_text: payload.residence_text,
            area_primary_id: payload.area_primary_id,
            area_secondary_id: payload.area_secondary_id,
            area_other_text: payload.area_other_text,
            work_days: form.work_days,
            shift_start: form.shift_start,
          })
          .eq('id', studentId),
      );
      return { id: studentId, message: t.common.success };
    },
    onSuccess: ({ id, message }) => {
      toast.success(message);
      void qc.invalidateQueries({ queryKey: ['students'] });
      void qc.invalidateQueries({ queryKey: ['student', id] });
      navigate(`/admin/students/${id}`);
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
      <PageHeader title={studentId ? s.edit : s.add} />
      <Card>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={submit} noValidate>
          <Field label={t.student.fullName} htmlFor={ids.name} error={show(errors.full_name)}>
            <Input id={ids.name} value={form.full_name} onChange={(e) => set({ full_name: e.target.value })} />
          </Field>
          <Field label={t.student.universityNo} htmlFor={ids.no} error={show(errors.no)}>
            <Input id={ids.no} inputMode="numeric" dir="ltr" className="text-start" value={form.university_student_no} onChange={(e) => set({ university_student_no: e.target.value })} />
          </Field>
          <Field label={t.student.phone} htmlFor={ids.phone} error={show(errors.phone)}>
            <Input id={ids.phone} inputMode="tel" dir="ltr" className="text-start" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field label={t.student.college} htmlFor={ids.college} error={show(errors.college)}>
            <Select id={ids.college} value={form.college_id} onChange={(e) => set({ college_id: e.target.value })}>
              <option value="">{t.common.select}</option>
              {(colleges.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.student.area} htmlFor={ids.a1}>
            <Select id={ids.a1} value={form.area_primary_id} onChange={(e) => set({ area_primary_id: e.target.value })}>
              <option value="">{t.common.none}</option>
              {(areas.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.student.areaSecondary} htmlFor={ids.a2}>
            <Select id={ids.a2} value={form.area_secondary_id} onChange={(e) => set({ area_secondary_id: e.target.value })}>
              <option value="">{t.common.none}</option>
              {(areas.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.student.areaOther} htmlFor={ids.other}>
            <Input id={ids.other} value={form.area_other_text} onChange={(e) => set({ area_other_text: e.target.value })} />
          </Field>
          <Field label={t.student.shiftStart} htmlFor={ids.shift}>
            <Select id={ids.shift} value={form.shift_start} onChange={(e) => set({ shift_start: e.target.value })}>
              {SHIFT_STARTS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.student.workDays} error={show(errors.days)} className="md:col-span-2">
            <DayToggles value={form.work_days} onChange={(d) => set({ work_days: d })} />
          </Field>
          <Field label={t.student.residence} htmlFor={ids.residence} className="md:col-span-2">
            <Textarea id={ids.residence} value={form.residence_text} onChange={(e) => set({ residence_text: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-3 md:col-span-2">
            <Button onClick={() => navigate(-1)}>{t.common.cancel}</Button>
            <Button type="submit" variant="secondary" disabled={save.isPending}>
              {save.isPending ? t.common.saving : t.common.save}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
