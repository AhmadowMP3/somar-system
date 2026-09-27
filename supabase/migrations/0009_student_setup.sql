-- 0009_student_setup.sql — first-login setup: residence + weekly departure/return schedule, and staff statistics.
-- Re-runnable.

alter table public.students add column if not exists setup_completed_at timestamptz;

create table if not exists public.student_schedule (
  student_id uuid not null references public.students(id) on delete cascade,
  dow smallint not null check (dow between 1 and 7),
  outbound_time time not null,
  return_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (student_id, dow),
  check (return_time > outbound_time)
);

drop trigger if exists set_updated_at on public.student_schedule;
create trigger set_updated_at before update on public.student_schedule
  for each row execute function public.set_updated_at();

alter table public.student_schedule enable row level security;
drop policy if exists student_schedule_select on public.student_schedule;
create policy student_schedule_select on public.student_schedule for select to authenticated
  using (student_id = public.current_student_id()
         or exists (select 1 from public.students s where s.id = student_id and public.is_university_staff(s.university_id)));
-- writes go through save_my_setup() (students) or directly for staff
drop policy if exists student_schedule_staff_write on public.student_schedule;
create policy student_schedule_staff_write on public.student_schedule for all to authenticated
  using (exists (select 1 from public.students s where s.id = student_id and public.is_university_staff(s.university_id)))
  with check (exists (select 1 from public.students s where s.id = student_id and public.is_university_staff(s.university_id)));

-- Student saves residence + schedule in one transaction.
-- p_schedule: [{"dow":6,"outbound":"07:30","return":"14:00"}, …]; the filled days become the student's work days.
create or replace function public.save_my_setup(p_area_id uuid, p_residence text, p_schedule jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_days smallint[];
  r record;
begin
  select * into v_student from public.students where profile_id = auth.uid();
  if v_student.id is null then
    raise exception 'NOT_A_STUDENT' using errcode = '22023';
  end if;
  if p_area_id is null or not exists (select 1 from public.areas a where a.id = p_area_id and a.university_id = v_student.university_id) then
    raise exception 'AREA_REQUIRED' using errcode = '22023';
  end if;
  if jsonb_typeof(p_schedule) <> 'array' or jsonb_array_length(p_schedule) = 0 then
    raise exception 'SCHEDULE_REQUIRED' using errcode = '22023';
  end if;
  for r in select * from jsonb_to_recordset(p_schedule) as x(dow smallint, outbound time, "return" time) loop
    if r.dow is null or r.dow not between 1 and 7 or r.outbound is null or r."return" is null or r."return" <= r.outbound then
      raise exception 'SCHEDULE_INVALID' using errcode = '22023';
    end if;
  end loop;

  delete from public.student_schedule where student_id = v_student.id;
  insert into public.student_schedule (student_id, dow, outbound_time, return_time)
  select v_student.id, x.dow, x.outbound, x."return"
  from jsonb_to_recordset(p_schedule) as x(dow smallint, outbound time, "return" time);

  select array_agg(distinct x.dow order by x.dow) into v_days
  from jsonb_to_recordset(p_schedule) as x(dow smallint);

  update public.students
  set area_primary_id = p_area_id,
      residence_text = nullif(btrim(coalesce(p_residence, '')), ''),
      work_days = v_days,
      setup_completed_at = coalesce(setup_completed_at, now())
  where id = v_student.id;

  perform private.write_audit('student.setup', 'students', v_student.id,
                              jsonb_build_object('area_primary_id', v_student.area_primary_id, 'work_days', v_student.work_days),
                              jsonb_build_object('area_primary_id', p_area_id, 'work_days', v_days, 'schedule', p_schedule),
                              v_student.university_id);
end;
$$;

revoke execute on function public.save_my_setup(uuid, text, jsonb) from public, anon;
grant execute on function public.save_my_setup(uuid, text, jsonb) to authenticated;

-- Staff statistics: for every weekday, how many active students leave / return at each time, per area.
create or replace function public.schedule_stats(p_university_id uuid)
returns table (dow smallint, kind text, slot time, area_id uuid, area_name text, students integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_university_staff(p_university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    with rows as (
      select sc.dow, 'outbound'::text as kind, sc.outbound_time as slot, s.area_primary_id as area_id, s.id as student_id
      from public.student_schedule sc join public.students s on s.id = sc.student_id
      where s.university_id = p_university_id and s.is_active
      union all
      select sc.dow, 'return'::text, sc.return_time, s.area_primary_id, s.id
      from public.student_schedule sc join public.students s on s.id = sc.student_id
      where s.university_id = p_university_id and s.is_active
    )
    select rows.dow, rows.kind, rows.slot, rows.area_id, a.name, count(distinct rows.student_id)::int
    from rows left join public.areas a on a.id = rows.area_id
    group by rows.dow, rows.kind, rows.slot, rows.area_id, a.name
    order by rows.dow, rows.kind, rows.slot, a.name;
end;
$$;

create or replace function public.setup_progress(p_university_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_university_staff(p_university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('total', count(*), 'completed', count(*) filter (where setup_completed_at is not null))
    from public.students where university_id = p_university_id and is_active
  );
end;
$$;
