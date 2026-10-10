-- Attendance statistics per rider kind and college (owner's request): students, doctors and employees
-- are counted separately; students can be narrowed to one college, and a per-college count answers
-- "how many from this college come on day X". Doctors and employees have no time schedule, only
-- work days and a home stop, so they get a per-day, per-area count instead of the time pivot.
-- The staff dashboard reports each kind separately. Re-runnable.

-- 0009 (re)creates the one-argument versions and 0013 patches their permission check on every run,
-- so drop them here before creating the new signatures.
drop function if exists public.schedule_stats(uuid);
drop function if exists public.schedule_stats(uuid, text, uuid);
drop function if exists public.setup_progress(uuid);
drop function if exists public.setup_progress(uuid, text, uuid);

-- For every weekday, how many active riders of a kind leave / return at each time, per area.
create function public.schedule_stats(p_university_id uuid, p_kind text default 'student', p_college_id uuid default null)
returns table (dow smallint, kind text, slot time, area_id uuid, area_name text, students integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.staff_can(p_university_id, 'stats') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    with riders as (
      select s.id, s.area_primary_id from public.students s
      where s.university_id = p_university_id and s.is_active and s.kind = p_kind
        and (p_college_id is null or s.college_id = p_college_id)
    ),
    rows as (
      select sc.dow, 'outbound'::text as kind, sc.outbound_time as slot, r.area_primary_id as area_id, r.id as student_id
      from public.student_schedule sc join riders r on r.id = sc.student_id
      union all
      select sc.dow, 'return'::text, sc.return_time, r.area_primary_id, r.id
      from public.student_schedule sc join riders r on r.id = sc.student_id
    )
    select rows.dow, rows.kind, rows.slot, rows.area_id, a.name, count(distinct rows.student_id)::int
    from rows left join public.areas a on a.id = rows.area_id
    group by rows.dow, rows.kind, rows.slot, rows.area_id, a.name
    order by rows.dow, rows.kind, rows.slot, a.name;
end;
$$;

-- Riders without a time schedule (doctors, employees): per weekday, how many have it as a work day,
-- grouped by the area of their home stop (or their own area when they have no stop).
create or replace function public.work_day_stats(p_university_id uuid, p_kind text default 'doctor', p_college_id uuid default null)
returns table (dow smallint, area_id uuid, area_name text, riders integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.staff_can(p_university_id, 'stats') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    with rows as (
      select d.dow, coalesce(st.area_id, s.area_primary_id) as area_id, s.id as rider_id
      from public.students s
      cross join lateral unnest(s.work_days) as d(dow)
      left join public.stops st on st.id = s.home_stop_id
      where s.university_id = p_university_id and s.is_active and s.kind = p_kind
        and (p_college_id is null or s.college_id = p_college_id)
    )
    select rows.dow::smallint, rows.area_id, a.name, count(distinct rows.rider_id)::int
    from rows left join public.areas a on a.id = rows.area_id
    group by rows.dow, rows.area_id, a.name
    order by rows.dow, a.name;
end;
$$;

-- Per weekday and college, how many distinct active riders of a kind come that day: students by
-- their saved schedule (the same source as the time pivots), other kinds by their work days.
create or replace function public.attendance_by_college(p_university_id uuid, p_kind text default 'student')
returns table (dow smallint, college_id uuid, college_name text, riders integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.staff_can(p_university_id, 'stats') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    with pool as (
      select s.id, s.college_id, s.work_days from public.students s
      where s.university_id = p_university_id and s.is_active and s.kind = p_kind
    ),
    rows as (
      select sc.dow, r.college_id, r.id as rider_id
      from public.student_schedule sc join pool r on r.id = sc.student_id
      where p_kind = 'student'
      union all
      select d.dow::smallint, r.college_id, r.id
      from pool r cross join lateral unnest(r.work_days) as d(dow)
      where p_kind <> 'student'
    )
    select rows.dow, rows.college_id, c.name, count(distinct rows.rider_id)::int
    from rows left join public.colleges c on c.id = rows.college_id
    group by rows.dow, rows.college_id, c.name
    order by rows.dow, count(distinct rows.rider_id) desc, c.name;
end;
$$;

-- How many active riders of a kind finished their first-login setup.
create function public.setup_progress(p_university_id uuid, p_kind text default 'student', p_college_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.staff_can(p_university_id, 'stats') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object('total', count(*), 'completed', count(*) filter (where setup_completed_at is not null))
    from public.students
    where university_id = p_university_id and is_active and kind = p_kind
      and (p_college_id is null or college_id = p_college_id)
  );
end;
$$;

revoke execute on function public.schedule_stats(uuid, text, uuid) from public, anon;
grant execute on function public.schedule_stats(uuid, text, uuid) to authenticated, service_role;
revoke execute on function public.work_day_stats(uuid, text, uuid) from public, anon;
grant execute on function public.work_day_stats(uuid, text, uuid) to authenticated, service_role;
revoke execute on function public.attendance_by_college(uuid, text) from public, anon;
grant execute on function public.attendance_by_college(uuid, text) to authenticated, service_role;
revoke execute on function public.setup_progress(uuid, text, uuid) from public, anon;
grant execute on function public.setup_progress(uuid, text, uuid) to authenticated, service_role;

-- Staff dashboard: the 0002 body with the 0013 / 0016 patches folded in, plus by_kind. The top-level
-- student counters and alerts stay students-only; the top-level scan counts and the chart cover everyone.
create or replace function public.admin_dashboard(p_university_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_university uuid := p_university_id;
  v_today date := public.damascus_today();
  v_result jsonb;
begin
  if not public.is_admin() then
    if public.current_user_role() <> 'university_supervisor' or not public.has_permission('dashboard') then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
    v_university := public.current_university_id();
  end if;

  with riders as (
    select s.* from public.students s where v_university is null or s.university_id = v_university
  ),
  st as (
    select riders.* from riders where riders.kind = 'student'
  ),
  bal as (
    select st.id, b.* from st cross join lateral private.compute_balance(st.id, v_today) b where st.is_active
  ),
  today_scans as (
    select sc.direction, s.kind from public.scans sc join public.students s on s.id = sc.student_id
    where sc.service_date = v_today and sc.cancelled_at is null and (v_university is null or sc.university_id = v_university)
  ),
  kinds as (
    select k.kind,
           (select count(*) from riders where riders.kind = k.kind) as total,
           (select count(*) from riders where riders.kind = k.kind and riders.is_active) as active,
           (select count(*) from today_scans ts where ts.kind = k.kind and ts.direction = 'outbound') as outbound,
           (select count(*) from today_scans ts where ts.kind = k.kind and ts.direction = 'return') as ret
    from unnest(array['student', 'doctor', 'employee']) as k(kind)
  ),
  days as (
    select d::date as day from generate_series(v_today - 6, v_today, interval '1 day') d
  ),
  chart as (
    select days.day,
           count(sc.id) filter (where sc.direction = 'outbound') as outbound,
           count(sc.id) filter (where sc.direction = 'return') as ret
    from days
    left join public.scans sc on sc.service_date = days.day and sc.cancelled_at is null
      and (v_university is null or sc.university_id = v_university)
    group by days.day
  )
  select jsonb_build_object(
    'students_total', (select count(*) from st),
    'students_active', (select count(*) from st where st.is_active),
    'scans_today_outbound', (select count(*) from today_scans where today_scans.direction = 'outbound'),
    'scans_today_return', (select count(*) from today_scans where today_scans.direction = 'return'),
    'students_no_balance', (select count(*) from bal where bal.subscription_id is not null and bal.remaining <= 0),
    'subscriptions_expiring', (select count(*) from public.subscriptions sb join st on st.id = sb.student_id
                                 where sb.status = 'active' and sb.ends_on - v_today between 0 and
                                   (private.effective_settings(st.university_id)).expiry_warning_days),
    'students_no_photo', (select count(*) from st where st.is_active and st.photo_path is null),
    'needs_area_mapping', (select count(*) from st where st.needs_area_mapping),
    'by_kind', (select jsonb_object_agg(kinds.kind, jsonb_build_object(
                  'total', kinds.total, 'active', kinds.active,
                  'scans_today_outbound', kinds.outbound, 'scans_today_return', kinds.ret)) from kinds),
    'chart', (select jsonb_agg(jsonb_build_object('day', chart.day, 'outbound', chart.outbound, 'return', chart.ret)
                               order by chart.day) from chart),
    'today', v_today
  ) into v_result;
  return v_result;
end;
$$;
