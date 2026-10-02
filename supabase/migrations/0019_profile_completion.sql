-- Owner's request: an import only needs name, university number and national number. Whatever else is
-- missing (phone, college, shift start, area, days and times) the student answers at first login, right
-- after changing the password, so in the end every student has the same information. Re-runnable.

alter table public.students drop constraint if exists students_student_fields_check;
alter table public.students add constraint students_student_fields_check check (
  kind <> 'student' or university_student_no is not null);
alter table public.students drop constraint if exists students_work_days_check;
alter table public.students add constraint students_work_days_check check (work_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]);
alter table public.students alter column work_days set default '{}';

-- A re-import fills in what the sheet has and never blanks what is already on file.
create or replace function public.import_update_students(p_university_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  with r as (
    select * from jsonb_to_recordset(p_rows) as x(
      university_student_no text, full_name text, phone_e164 text, college_id uuid, residence_text text, national_id text,
      area_primary_id uuid, area_secondary_id uuid, area_other_text text, work_days smallint[], shift_start time)
  ),
  upd as (
    update public.students s
    set full_name = r.full_name,
        phone_e164 = coalesce(r.phone_e164, s.phone_e164),
        college_id = coalesce(r.college_id, s.college_id),
        residence_text = coalesce(r.residence_text, s.residence_text),
        area_primary_id = coalesce(r.area_primary_id, s.area_primary_id),
        area_secondary_id = coalesce(r.area_secondary_id, s.area_secondary_id),
        area_other_text = case when r.area_primary_id is null and r.area_other_text is null then s.area_other_text
                               else r.area_other_text end,
        work_days = case when cardinality(coalesce(r.work_days, '{}')) > 0 then r.work_days else s.work_days end,
        shift_start = coalesce(r.shift_start, s.shift_start),
        national_id = coalesce(nullif(r.national_id, ''), s.national_id)
    from r
    where s.university_id = p_university_id and s.university_student_no = r.university_student_no
    returning s.profile_id, s.full_name, s.phone_e164
  ),
  prof as (
    update public.profiles p set full_name = upd.full_name, phone = coalesce(upd.phone_e164, p.phone)
    from upd where p.id = upd.profile_id
    returning p.id
  )
  select count(*) into v_count from upd;
  return v_count;
end;
$$;

-- The first-login questionnaire in one call: fills the missing profile answers (never overwrites what
-- the administration entered), then saves area, residence and the weekly schedule like save_my_setup.
create or replace function public.complete_my_setup(
  p_area_id uuid,
  p_residence text,
  p_schedule jsonb,
  p_phone text default null,
  p_college_id uuid default null,
  p_shift_start time default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_phone text := nullif(btrim(coalesce(p_phone, '')), '');
  v_days smallint[];
begin
  select * into v_student from public.students where profile_id = auth.uid();
  if v_student.id is null then
    raise exception 'NOT_A_STUDENT' using errcode = '22023';
  end if;
  if v_student.setup_completed_at is not null then
    raise exception 'SETUP_LOCKED' using errcode = '42501';
  end if;
  if p_area_id is null or not exists (select 1 from public.areas a where a.id = p_area_id and a.university_id = v_student.university_id) then
    raise exception 'AREA_REQUIRED' using errcode = '22023';
  end if;
  if v_phone is not null and v_phone !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'PHONE_INVALID' using errcode = '22023';
  end if;
  if p_college_id is not null
     and not exists (select 1 from public.colleges c where c.id = p_college_id and c.university_id = v_student.university_id) then
    raise exception 'COLLEGE_REQUIRED' using errcode = '22023';
  end if;
  if coalesce(v_student.phone_e164, v_phone) is null then
    raise exception 'PHONE_REQUIRED' using errcode = '22023';
  end if;
  if v_student.kind = 'student' then
    if coalesce(v_student.college_id, p_college_id) is null then
      raise exception 'COLLEGE_REQUIRED' using errcode = '22023';
    end if;
    if coalesce(v_student.shift_start, p_shift_start) is null then
      raise exception 'SHIFT_REQUIRED' using errcode = '22023';
    end if;
  end if;

  v_days := private.replace_schedule(v_student.id, p_schedule);

  update public.students
  set phone_e164 = coalesce(phone_e164, v_phone),
      college_id = coalesce(college_id, case when v_student.kind = 'student' then p_college_id end),
      shift_start = coalesce(shift_start, case when v_student.kind = 'student' then p_shift_start end),
      area_primary_id = p_area_id,
      residence_text = coalesce(nullif(btrim(coalesce(p_residence, '')), ''), residence_text),
      work_days = v_days,
      setup_completed_at = now()
  where id = v_student.id;
  if v_student.phone_e164 is null then
    update public.profiles set phone = v_phone where id = v_student.profile_id;
  end if;

  perform private.write_audit('student.setup', 'students', v_student.id,
                              jsonb_build_object('phone_e164', v_student.phone_e164,
                                                 'college', (select c.name from public.colleges c where c.id = v_student.college_id),
                                                 'shift_start', v_student.shift_start,
                                                 'area_primary_id', v_student.area_primary_id, 'work_days', v_student.work_days),
                              jsonb_build_object('phone_e164', coalesce(v_student.phone_e164, v_phone),
                                                 'college', (select c.name from public.colleges c
                                                             where c.id = coalesce(v_student.college_id, p_college_id)),
                                                 'shift_start', coalesce(v_student.shift_start, p_shift_start),
                                                 'area_primary_id', p_area_id, 'work_days', v_days, 'schedule', p_schedule),
                              v_student.university_id);
end;
$$;
revoke execute on function public.complete_my_setup(uuid, text, jsonb, text, uuid, time) from public, anon;
grant execute on function public.complete_my_setup(uuid, text, jsonb, text, uuid, time) to authenticated;
