-- National number for students (owner's request): read from the import sheet («الرقم الوطني») and used
-- as the initial password of a new account (the transport number when it is missing). Re-runnable.

alter table public.students add column if not exists national_id text;
alter table public.students drop constraint if exists students_national_id_check;
alter table public.students add constraint students_national_id_check check (national_id ~ '^[0-9]{6,20}$');

create or replace function public.provision_student(
  p_user_id uuid, p_university_id uuid, p_transport_number text, p_data jsonb, p_actor uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_kind text := coalesce(nullif(p_data ->> 'kind', ''), 'student');
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.profiles (id, login_code, role, university_id, full_name, phone, must_change_password)
  values (p_user_id, p_transport_number, 'student', p_university_id, p_data ->> 'full_name',
          nullif(p_data ->> 'phone_e164', ''), true);

  insert into public.students (profile_id, university_id, kind, college_id, transport_number, full_name,
                               university_student_no, phone_e164, residence_text, area_primary_id, area_secondary_id,
                               area_other_text, work_days, shift_start, job_title, work_hours_text, notes, national_id)
  values (p_user_id, p_university_id, v_kind, nullif(p_data ->> 'college_id', '')::uuid, p_transport_number,
          p_data ->> 'full_name', nullif(p_data ->> 'university_student_no', ''), nullif(p_data ->> 'phone_e164', ''),
          nullif(p_data ->> 'residence_text', ''),
          nullif(p_data ->> 'area_primary_id', '')::uuid, nullif(p_data ->> 'area_secondary_id', '')::uuid,
          nullif(p_data ->> 'area_other_text', ''),
          array(select jsonb_array_elements_text(coalesce(p_data -> 'work_days', '[]'::jsonb))::smallint),
          nullif(p_data ->> 'shift_start', '')::time,
          nullif(p_data ->> 'job_title', ''), nullif(p_data ->> 'work_hours_text', ''), nullif(p_data ->> 'notes', ''),
          nullif(p_data ->> 'national_id', ''))
  returning id into v_id;

  if p_actor is not null then
    perform private.write_audit(case v_kind when 'student' then 'student.create' else v_kind || '.create' end,
                                'students', v_id, null, p_data, p_university_id, p_actor);
  end if;
  return v_id;
end;
$$;

-- A re-import fills the national number in; an empty cell keeps the one on file.
-- (The password of an existing account is never changed by an import.)
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
    set full_name = r.full_name, phone_e164 = r.phone_e164, college_id = r.college_id,
        residence_text = r.residence_text, area_primary_id = r.area_primary_id,
        area_secondary_id = r.area_secondary_id, area_other_text = r.area_other_text,
        work_days = r.work_days, shift_start = r.shift_start,
        national_id = coalesce(nullif(r.national_id, ''), s.national_id)
    from r
    where s.university_id = p_university_id and s.university_student_no = r.university_student_no
    returning s.profile_id, s.full_name, s.phone_e164
  ),
  prof as (
    update public.profiles p set full_name = upd.full_name, phone = upd.phone_e164
    from upd where p.id = upd.profile_id
    returning p.id
  )
  select count(*) into v_count from upd;
  return v_count;
end;
$$;
