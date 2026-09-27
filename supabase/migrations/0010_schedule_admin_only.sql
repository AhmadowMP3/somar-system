-- The weekly schedule is entered by the student once, at first login; afterwards only staff change it.

-- Shared by the student's one-time setup and the staff editor: validate, replace the rows,
-- and return the chosen days (which become the student's official work days).
create or replace function private.replace_schedule(p_student_id uuid, p_schedule jsonb)
returns smallint[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days smallint[];
  r record;
begin
  if jsonb_typeof(p_schedule) <> 'array' or jsonb_array_length(p_schedule) = 0 then
    raise exception 'SCHEDULE_REQUIRED' using errcode = '22023';
  end if;
  for r in select * from jsonb_to_recordset(p_schedule) as x(dow smallint, outbound time, "return" time) loop
    if r.dow is null or r.dow not between 1 and 7 or r.outbound is null or r."return" is null or r."return" <= r.outbound then
      raise exception 'SCHEDULE_INVALID' using errcode = '22023';
    end if;
  end loop;

  delete from public.student_schedule where student_id = p_student_id;
  insert into public.student_schedule (student_id, dow, outbound_time, return_time)
  select p_student_id, x.dow, x.outbound, x."return"
  from jsonb_to_recordset(p_schedule) as x(dow smallint, outbound time, "return" time);

  select array_agg(distinct x.dow order by x.dow) into v_days
  from jsonb_to_recordset(p_schedule) as x(dow smallint);
  return v_days;
end;
$$;
revoke execute on function private.replace_schedule(uuid, jsonb) from public, anon, authenticated;

create or replace function public.save_my_setup(p_area_id uuid, p_residence text, p_schedule jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
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

  v_days := private.replace_schedule(v_student.id, p_schedule);

  update public.students
  set area_primary_id = p_area_id,
      residence_text = nullif(btrim(coalesce(p_residence, '')), ''),
      work_days = v_days,
      setup_completed_at = now()
  where id = v_student.id;

  perform private.write_audit('student.setup', 'students', v_student.id,
                              jsonb_build_object('area_primary_id', v_student.area_primary_id, 'work_days', v_student.work_days),
                              jsonb_build_object('area_primary_id', p_area_id, 'work_days', v_days, 'schedule', p_schedule),
                              v_student.university_id);
end;
$$;
revoke execute on function public.save_my_setup(uuid, text, jsonb) from public, anon;
grant execute on function public.save_my_setup(uuid, text, jsonb) to authenticated;

-- Staff edit of one student's weekly schedule (also updates the official work days).
create or replace function public.save_student_schedule(p_student_id uuid, p_schedule jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_old jsonb;
  v_days smallint[];
begin
  select * into v_student from public.students where id = p_student_id;
  if v_student.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if not public.is_university_staff(v_student.university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'outbound', outbound_time, 'return', return_time) order by dow), '[]'::jsonb)
  into v_old from public.student_schedule where student_id = p_student_id;

  v_days := private.replace_schedule(p_student_id, p_schedule);

  update public.students
  set work_days = v_days,
      setup_completed_at = coalesce(setup_completed_at, now())
  where id = p_student_id;

  perform private.write_audit('student.schedule', 'students', p_student_id,
                              jsonb_build_object('work_days', v_student.work_days, 'schedule', v_old),
                              jsonb_build_object('work_days', v_days, 'schedule', p_schedule),
                              v_student.university_id);
end;
$$;
revoke execute on function public.save_student_schedule(uuid, jsonb) from public, anon;
grant execute on function public.save_student_schedule(uuid, jsonb) to authenticated;

-- Students keep read access to their own rows; writes go only through the functions above
-- (the staff write policy from 0009 stays for completeness).
