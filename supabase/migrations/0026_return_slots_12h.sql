-- 1) Return slots are 11:30, 2 and 3:30 only (owner's decision, 2026-10-06): a later return becomes
--    3:30 (the 4:00 slot is removed). Existing rows are re-saved through the rounding trigger.
-- 2) The whole app shows a 12-hour clock: the schedule-change notification texts say «7:30 ص» / «2:00 م».
-- Re-runnable.

create or replace function private.snap_return(p time)
returns time
language sql
immutable
set search_path = ''
as $$
  select case
           when p <= time '11:30' then time '11:30'
           when p <= time '14:00' then time '14:00'
           else time '15:30'
         end;
$$;

create or replace function private.snap_schedule_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.outbound_time := private.snap_outbound(new.outbound_time);
  new.return_time := private.snap_return(new.return_time);
  if new.return_time <= new.outbound_time then
    new.return_time := coalesce(
      (select s from unnest(array[time '11:30', time '14:00', time '15:30']) s
       where s > new.outbound_time order by s limit 1),
      time '15:30');
  end if;
  return new;
end;
$$;

update public.student_schedule
set return_time = return_time
where return_time not in (time '11:30', time '14:00', time '15:30');

-- `14:30` → «2:30 م» (Arabic AM/PM marks), as the app shows times.
create or replace function private.clock12(p time)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p is null then ''
              else to_char(p, 'FMHH12:MI') || ' ' || case when p < time '12:00' then 'ص' else 'م' end
         end;
$$;

create or replace function private.on_route_time_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_route public.routes%rowtype;
  v_stop_name text;
begin
  if new.departure_time is not distinct from old.departure_time or new.departure_time is null then
    return new;
  end if;
  if tg_table_name = 'routes' then
    perform private.notify_schedule_change(
      new.university_id,
      'تم تغيير موعد انطلاق خط «' || new.name || '» إلى ' || private.clock12(new.departure_time),
      jsonb_build_object('route_id', new.id, 'departure_time', to_char(new.departure_time, 'HH24:MI')));
    perform private.write_audit('route.time_change', 'routes', new.id,
                                jsonb_build_object('departure_time', old.departure_time),
                                jsonb_build_object('departure_time', new.departure_time), new.university_id);
  else
    select * into v_route from public.routes where id = new.route_id;
    select s.name into v_stop_name from public.stops s where s.id = new.stop_id;
    v_stop_name := coalesce(v_stop_name, new.name, '');
    perform private.notify_schedule_change(
      v_route.university_id,
      'تم تغيير موعد نقطة «' || v_stop_name || '» على خط «' || v_route.name || '» إلى ' || private.clock12(new.departure_time),
      jsonb_build_object('route_id', v_route.id, 'stop_id', new.stop_id, 'departure_time', to_char(new.departure_time, 'HH24:MI')));
    perform private.write_audit('route.time_change', 'route_stops', new.id,
                                jsonb_build_object('departure_time', old.departure_time),
                                jsonb_build_object('departure_time', new.departure_time), v_route.university_id);
  end if;
  return new;
end;
$$;
