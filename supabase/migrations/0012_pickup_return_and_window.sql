-- «مكان انطلاقتي غداً», second version (owner's request):
--  * the student also picks tomorrow's return time (one of tomorrow's return-route times) and drop-off stop;
--  * the choice is made once and then locked;
--  * the opening and closing times come from the settings (per university, or the global default).

alter table public.settings
  add column if not exists pickup_open_time time not null default '18:00',
  add column if not exists pickup_close_time time not null default '23:59';
alter table public.settings drop constraint if exists settings_pickup_window_check;
alter table public.settings add constraint settings_pickup_window_check check (pickup_close_time > pickup_open_time);

alter table public.pickup_choices
  add column if not exists return_time time,
  add column if not exists return_stop_id uuid references public.stops(id);
create index if not exists pickup_choices_return_idx on public.pickup_choices (university_id, service_date, return_time);

-- Window state for a university, on the database clock (Damascus). The choice is always for the next day.
create or replace function private.pickup_state(p_university_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_local timestamp := public.app_now() at time zone 'Asia/Damascus';
  v_settings public.settings;
  v_phase text;
begin
  v_settings := private.effective_settings(p_university_id);
  v_phase := case
    when v_local::time < v_settings.pickup_open_time then 'before'
    when v_local::time >= v_settings.pickup_close_time then 'after'
    else 'open' end;
  return jsonb_build_object(
    'open', v_phase = 'open',
    'phase', v_phase,
    'opens_at', to_char(v_settings.pickup_open_time, 'HH24:MI'),
    'closes_at', to_char(v_settings.pickup_close_time, 'HH24:MI'),
    'today', v_local::date,
    'service_date', v_local::date + 1
  );
end;
$$;

create or replace function public.pickup_window()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.pickup_state(public.current_university_id());
$$;
grant execute on function public.pickup_window() to authenticated;

-- Tomorrow's return times: departure times of active return routes that run on tomorrow's weekday.
create or replace function private.return_times(p_university_id uuid, p_date date)
returns table (slot time)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct r.departure_time
  from public.routes r
  where r.university_id = p_university_id
    and r.is_active
    and r.direction in ('return', 'both')
    and r.departure_time is not null
    and (r.active_days is null or cardinality(r.active_days) = 0 or extract(isodow from p_date)::smallint = any (r.active_days))
  order by 1;
$$;

create or replace function public.pickup_return_times()
returns table (slot time)
language sql
stable
security definer
set search_path = ''
as $$
  select rt.slot
  from private.return_times(public.current_university_id(),
                            (public.app_now() at time zone 'Asia/Damascus')::date + 1) rt;
$$;
grant execute on function public.pickup_return_times() to authenticated;

drop function if exists public.choose_my_pickup(uuid);
create or replace function public.choose_my_pickup(p_stop_id uuid, p_return_time time default null, p_return_stop_id uuid default null)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_state jsonb;
  v_date date;
  v_has_returns boolean;
begin
  select * into v_student from public.students where profile_id = auth.uid();
  if v_student.id is null or not v_student.is_active then
    raise exception 'NOT_A_STUDENT' using errcode = '22023';
  end if;
  v_state := private.pickup_state(v_student.university_id);
  if not (v_state ->> 'open')::boolean then
    raise exception 'PICKUP_CLOSED' using errcode = '22023';
  end if;
  v_date := (v_state ->> 'service_date')::date;
  if exists (select 1 from public.pickup_choices where student_id = v_student.id and service_date = v_date) then
    raise exception 'PICKUP_LOCKED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.stops s where s.id = p_stop_id and s.university_id = v_student.university_id and s.is_active) then
    raise exception 'STOP_INVALID' using errcode = '22023';
  end if;

  select exists (select 1 from private.return_times(v_student.university_id, v_date)) into v_has_returns;
  if v_has_returns then
    if p_return_time is null or not exists (select 1 from private.return_times(v_student.university_id, v_date) rt where rt.slot = p_return_time) then
      raise exception 'RETURN_TIME_INVALID' using errcode = '22023';
    end if;
    if p_return_stop_id is null or not exists (
      select 1 from public.stops s where s.id = p_return_stop_id and s.university_id = v_student.university_id and s.is_active) then
      raise exception 'RETURN_STOP_INVALID' using errcode = '22023';
    end if;
  elsif p_return_time is not null or p_return_stop_id is not null then
    raise exception 'RETURN_TIME_INVALID' using errcode = '22023';
  end if;

  insert into public.pickup_choices (student_id, service_date, university_id, stop_id, return_time, return_stop_id)
  values (v_student.id, v_date, v_student.university_id, p_stop_id, p_return_time, p_return_stop_id);
  return v_date;
end;
$$;
revoke execute on function public.choose_my_pickup(uuid, time, uuid) from public, anon;
grant execute on function public.choose_my_pickup(uuid, time, uuid) to authenticated;

-- Staff: how many students return at each time, per drop-off stop (grouped by the stop's area).
create or replace function public.pickup_return_stats(p_university_id uuid, p_date date)
returns table (return_time time, area_id uuid, area_name text, stop_id uuid, stop_name text, students integer)
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
    select pc.return_time, s.area_id, a.name, s.id, s.name, count(*)::int
    from public.pickup_choices pc
    join public.stops s on s.id = pc.return_stop_id
    left join public.areas a on a.id = s.area_id
    where pc.university_id = p_university_id and pc.service_date = p_date and pc.return_time is not null
    group by pc.return_time, s.area_id, a.name, s.id, s.name
    order by pc.return_time, count(*) desc, s.name;
end;
$$;
