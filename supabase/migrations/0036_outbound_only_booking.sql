-- «احجز مقعدك غداً», third version (owner's request, 2026-10-19). Re-runnable.
--  * No return booking any more: the student (and each patient) books the outbound seat only. Return data
--    already saved is erased.
--  * After the outbound time, the student picks a stop ON A LINE of that time: only lines of that trip that
--    run tomorrow, only active stops with a time written on the line. A stop on two lines shows under each
--    line and the student picks the bus; the booking keeps that line and the stop's time on it, shown to the
--    student as «الباص يصل … الساعة …».

-- ---------------------------------------------------------------- erase return bookings

update public.pickup_choices
set return_time = null, return_stop_id = null, return_stop_name = null
where return_time is not null or return_stop_id is not null or return_stop_name is not null;

alter table public.pickup_patients alter column return_time drop not null;
update public.pickup_patients
set return_time = null, return_stop_id = null, return_stop_name = null
where return_time is not null or return_stop_id is not null or return_stop_name is not null;

-- ---------------------------------------------------------------- the line kept with each seat

alter table public.pickup_choices
  add column if not exists outbound_route_id uuid references public.routes(id) on delete set null,
  add column if not exists outbound_route_name text,
  add column if not exists outbound_stop_time time;
alter table public.pickup_patients
  add column if not exists outbound_route_id uuid references public.routes(id) on delete set null,
  add column if not exists outbound_route_name text,
  add column if not exists outbound_stop_time time;

-- ---------------------------------------------------------------- what can be booked

-- For each outbound slot: the lines of that trip (leaving after the previous slot and before this one, by the
-- line's departure or, without one, its first stop time) that are active and run on that day, with their
-- active stops that have a time on the line, in riding order.
create or replace function private.booking_options(p_university_id uuid, p_date date)
returns table (slot time, route_id uuid, route_name text, route_departure time, stop_id uuid, stop_name text, stop_seq integer, stop_time time)
language sql
stable
security definer
set search_path = ''
as $$
  with slots as (
    select x as slot,
           coalesce(lag(x) over (order by x), time '00:00') as low
    from unnest(private.outbound_slots()) x
  ),
  lines as (
    select r.id, r.name,
           coalesce(r.departure_time, (select min(rs.departure_time) from public.route_stops rs where rs.route_id = r.id)) as departs
    from public.routes r
    where r.university_id = p_university_id
      and r.is_active
      and r.direction in ('outbound', 'both')
      and (r.active_days is null or cardinality(r.active_days) = 0 or extract(isodow from p_date)::smallint = any (r.active_days))
  )
  select sl.slot, l.id, l.name, l.departs, s.id, s.name, rs.seq, rs.departure_time
  from slots sl
  join lines l on l.departs >= sl.low and l.departs < sl.slot
  join public.route_stops rs on rs.route_id = l.id and rs.departure_time is not null
  join public.stops s on s.id = rs.stop_id and s.is_active
  order by sl.slot, l.departs, l.name, rs.seq;
$$;

-- The signed-in student's choices for the day being booked (tomorrow).
create or replace function public.pickup_options()
returns table (slot time, route_id uuid, route_name text, route_departure time, stop_id uuid, stop_name text, stop_seq integer, stop_time time)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_student public.students%rowtype;
begin
  select * into v_student from public.students where profile_id = auth.uid();
  if v_student.id is null then
    return;
  end if;
  return query
    select * from private.booking_options(v_student.university_id,
                                          (private.pickup_state(v_student.university_id) ->> 'service_date')::date);
end;
$$;
revoke execute on function public.pickup_options() from public, anon;
grant execute on function public.pickup_options() to authenticated;

-- ---------------------------------------------------------------- booking

drop function if exists public.choose_my_pickup(time, uuid, time, uuid);
drop function if exists public.choose_my_pickup(time, uuid, time, uuid, jsonb);
drop function if exists public.choose_my_pickup(time, uuid, uuid, jsonb);
-- p_patients: JSON array of {full_name, phone, outbound_time, route_id, stop_id}, at most five.
create function public.choose_my_pickup(
  p_outbound_time time,
  p_route_id uuid,
  p_stop_id uuid,
  p_patients jsonb default '[]'::jsonb
)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_state jsonb;
  v_date date;
  v_patients jsonb := coalesce(p_patients, '[]'::jsonb);
  v_patient jsonb;
  v_seq smallint := 0;
  v_name text;
  v_phone text;
  v_out time;
  v_route uuid;
  v_stop uuid;
  v_option record;
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
  if p_outbound_time is null or not (p_outbound_time = any (private.outbound_slots())) then
    raise exception 'OUTBOUND_TIME_INVALID' using errcode = '22023';
  end if;
  select * into v_option from private.booking_options(v_student.university_id, v_date) o
  where o.slot = p_outbound_time and o.route_id = p_route_id and o.stop_id = p_stop_id
  limit 1;
  if v_option.route_id is null then
    raise exception 'STOP_INVALID' using errcode = '22023';
  end if;

  if jsonb_typeof(v_patients) <> 'array' or jsonb_array_length(v_patients) > 5 then
    raise exception 'PATIENTS_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(v_patients) > 0 and not exists (
    select 1 from public.colleges c where c.id = v_student.college_id and c.allows_patients) then
    raise exception 'PATIENTS_NOT_ALLOWED' using errcode = '22023';
  end if;

  insert into public.pickup_choices (student_id, service_date, university_id, outbound_time, stop_id,
                                     outbound_route_id, outbound_route_name, outbound_stop_time)
  values (v_student.id, v_date, v_student.university_id, p_outbound_time, p_stop_id,
          v_option.route_id, v_option.route_name, v_option.stop_time);

  for v_patient in select value from jsonb_array_elements(v_patients) loop
    v_seq := v_seq + 1;
    v_name := btrim(coalesce(v_patient ->> 'full_name', ''));
    if char_length(v_name) not between 2 and 80 then
      raise exception 'PATIENT_NAME_INVALID' using errcode = '22023';
    end if;
    -- spaces, dashes and brackets typed in a phone number are ignored
    v_phone := regexp_replace(coalesce(v_patient ->> 'phone', ''), '[\s\-().]', '', 'g');
    if v_phone !~ '^\+?[0-9]{7,15}$' then
      raise exception 'PATIENT_PHONE_INVALID' using errcode = '22023';
    end if;
    begin
      v_out := (v_patient ->> 'outbound_time')::time;
      v_route := (v_patient ->> 'route_id')::uuid;
      v_stop := (v_patient ->> 'stop_id')::uuid;
    exception when others then
      raise exception 'PATIENTS_INVALID' using errcode = '22023';
    end;
    if v_out is null or not (v_out = any (private.outbound_slots())) then
      raise exception 'OUTBOUND_TIME_INVALID' using errcode = '22023';
    end if;
    v_option := null;
    select * into v_option from private.booking_options(v_student.university_id, v_date) o
    where o.slot = v_out and o.route_id = v_route and o.stop_id = v_stop
    limit 1;
    if v_option.route_id is null then
      raise exception 'STOP_INVALID' using errcode = '22023';
    end if;
    insert into public.pickup_patients (student_id, service_date, university_id, seq, full_name, phone,
                                        outbound_time, stop_id, outbound_route_id, outbound_route_name, outbound_stop_time)
    values (v_student.id, v_date, v_student.university_id, v_seq, v_name, v_phone,
            v_out, v_stop, v_option.route_id, v_option.route_name, v_option.stop_time);
  end loop;
  return v_date;
end;
$$;
revoke execute on function public.choose_my_pickup(time, uuid, uuid, jsonb) from public, anon;
grant execute on function public.choose_my_pickup(time, uuid, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- staff: seats by line (outbound only)

-- Same columns as 0035. A seat booked on a line keeps that line; older seats are placed by private.pickup_line.
create or replace function public.pickup_passengers(p_university_id uuid, p_date date)
returns table (
  seat_id text,
  passenger_type text,
  full_name text,
  phone text,
  transport_number text,
  booked_by_name text,
  booked_by_transport text,
  direction text,
  slot time,
  stop_id uuid,
  stop_name text,
  area_id uuid,
  area_name text,
  route_id uuid,
  route_name text,
  route_departure time,
  stop_seq integer,
  stop_time time
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.staff_can(p_university_id, 'pickups') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    with seats as (
      select 'r:' || pc.student_id::text as seat_id,
             case when s.kind <> 'student' then s.kind
                  when p.role in ('supervisor', 'university_supervisor') then 'supervisor'
                  else 'student' end as passenger_type,
             s.full_name, s.phone_e164 as phone, s.transport_number,
             null::text as booked_by_name, null::text as booked_by_transport,
             pc.outbound_time, pc.stop_id, pc.stop_name,
             pc.outbound_route_id, pc.outbound_route_name, pc.outbound_stop_time
      from public.pickup_choices pc
      join public.students s on s.id = pc.student_id
      left join public.profiles p on p.id = s.profile_id
      where pc.university_id = p_university_id and pc.service_date = p_date
      union all
      select 'p:' || pp.id::text, 'patient', pp.full_name, pp.phone, null,
             s.full_name, s.transport_number,
             pp.outbound_time, pp.stop_id, pp.stop_name,
             pp.outbound_route_id, pp.outbound_route_name, pp.outbound_stop_time
      from public.pickup_patients pp
      join public.students s on s.id = pp.student_id
      where pp.university_id = p_university_id and pp.service_date = p_date
    )
    select x.seat_id, x.passenger_type, x.full_name, x.phone, x.transport_number, x.booked_by_name, x.booked_by_transport,
           'outbound'::text, x.outbound_time, x.stop_id, coalesce(st.name, x.stop_name), st.area_id, a.name,
           coalesce(x.outbound_route_id, line.route_id),
           case when x.outbound_route_name is not null or x.outbound_route_id is not null
                then coalesce(r.name, x.outbound_route_name) else line.route_name end,
           case when x.outbound_route_id is not null then r.departure_time else line.route_departure end,
           case when x.outbound_route_id is not null
                then (select rs.seq from public.route_stops rs where rs.route_id = x.outbound_route_id and rs.stop_id = x.stop_id limit 1)
                else line.stop_seq end,
           case when x.outbound_route_name is not null or x.outbound_route_id is not null then x.outbound_stop_time else line.stop_time end
    from seats x
    left join public.stops st on st.id = x.stop_id
    left join public.areas a on a.id = st.area_id
    left join public.routes r on r.id = x.outbound_route_id
    left join lateral private.pickup_line(p_university_id, p_date, 'outbound', x.outbound_time, x.stop_id) line
      on x.outbound_route_id is null and x.outbound_route_name is null and x.outbound_time is not null
    order by x.outbound_time nulls last, 16 nulls last, 15, 17, x.full_name;
end;
$$;
