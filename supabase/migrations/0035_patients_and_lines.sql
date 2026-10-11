-- Owner's requests, 2026-10-11. Re-runnable.
-- 1) Patients: students of a college flagged «طلابها يحجزون لمرضى» (dentistry) may book seats for up to five
--    patients together with their own booking — each patient with a name, a phone, an outbound time + stop
--    and a return time + drop-off stop. Same window, same slots, same lock as the student's own booking.
-- 2) Bookings by line: every booked seat (rider or patient) is placed on the bus line that serves its stop
--    at its time, so «حجوزات المقاعد» can list each line with its stops and who boards there.

-- ---------------------------------------------------------------- colleges: patients allowed

do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'colleges' and column_name = 'allows_patients') then
    alter table public.colleges add column allows_patients boolean not null default false;
    -- first run only: dentistry starts switched on, staff decide from then on
    update public.colleges set allows_patients = true where name ~ '[أا]سنان';
  end if;
end;
$$;

-- ---------------------------------------------------------------- patients' seats

create table if not exists public.pickup_patients (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  service_date date not null,
  university_id uuid not null references public.universities(id) on delete cascade,
  seq smallint not null check (seq between 1 and 5),
  full_name text not null check (char_length(btrim(full_name)) between 2 and 80),
  phone text not null check (phone ~ '^\+?[0-9]{7,15}$'),
  outbound_time time not null,
  stop_id uuid references public.stops(id) on delete set null,
  stop_name text,
  return_time time not null,
  return_stop_id uuid references public.stops(id) on delete set null,
  return_stop_name text,
  created_at timestamptz not null default now(),
  unique (student_id, service_date, seq)
);
create index if not exists pickup_patients_day_idx on public.pickup_patients (university_id, service_date);

-- the stop names are kept with the seat, so a stop deleted later still shows by name
create or replace function private.pickup_patient_stop_names()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.stop_name := coalesce((select s.name from public.stops s where s.id = new.stop_id), new.stop_name);
  new.return_stop_name := coalesce((select s.name from public.stops s where s.id = new.return_stop_id), new.return_stop_name);
  return new;
end;
$$;
drop trigger if exists pickup_patient_stop_names on public.pickup_patients;
create trigger pickup_patient_stop_names before insert or update of stop_id, return_stop_id on public.pickup_patients
  for each row execute function private.pickup_patient_stop_names();

alter table public.pickup_patients enable row level security;
drop policy if exists pickup_patients_select on public.pickup_patients;
create policy pickup_patients_select on public.pickup_patients for select to authenticated
  using (student_id = public.current_student_id() or public.is_university_staff(university_id));
-- no write policies: students write through choose_my_pickup only.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pickup_patients') then
    alter publication supabase_realtime add table public.pickup_patients;
  end if;
end;
$$;

-- ---------------------------------------------------------------- booking with patients

-- 0031's rules for the student's own seat, unchanged; p_patients is a JSON array of
-- {full_name, phone, outbound_time, stop_id, return_time, return_stop_id}, at most five.
drop function if exists public.choose_my_pickup(time, uuid, time, uuid);
drop function if exists public.choose_my_pickup(time, uuid, time, uuid, jsonb);
create function public.choose_my_pickup(
  p_outbound_time time,
  p_stop_id uuid,
  p_return_time time,
  p_return_stop_id uuid,
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
  v_ret time;
  v_stop uuid;
  v_ret_stop uuid;
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
  if not exists (select 1 from public.stops s where s.id = p_stop_id and s.university_id = v_student.university_id and s.is_active) then
    raise exception 'STOP_INVALID' using errcode = '22023';
  end if;
  if p_return_time is null or not (p_return_time = any (private.return_slots())) or p_return_time <= p_outbound_time then
    raise exception 'RETURN_TIME_INVALID' using errcode = '22023';
  end if;
  if not exists (select 1 from public.stops s where s.id = p_return_stop_id and s.university_id = v_student.university_id and s.is_active) then
    raise exception 'RETURN_STOP_INVALID' using errcode = '22023';
  end if;

  if jsonb_typeof(v_patients) <> 'array' or jsonb_array_length(v_patients) > 5 then
    raise exception 'PATIENTS_INVALID' using errcode = '22023';
  end if;
  if jsonb_array_length(v_patients) > 0 and not exists (
    select 1 from public.colleges c where c.id = v_student.college_id and c.allows_patients) then
    raise exception 'PATIENTS_NOT_ALLOWED' using errcode = '22023';
  end if;

  insert into public.pickup_choices (student_id, service_date, university_id, outbound_time, stop_id, return_time, return_stop_id)
  values (v_student.id, v_date, v_student.university_id, p_outbound_time, p_stop_id, p_return_time, p_return_stop_id);

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
      v_ret := (v_patient ->> 'return_time')::time;
      v_stop := (v_patient ->> 'stop_id')::uuid;
      v_ret_stop := (v_patient ->> 'return_stop_id')::uuid;
    exception when others then
      raise exception 'PATIENTS_INVALID' using errcode = '22023';
    end;
    if v_out is null or not (v_out = any (private.outbound_slots())) then
      raise exception 'OUTBOUND_TIME_INVALID' using errcode = '22023';
    end if;
    if not exists (select 1 from public.stops s where s.id = v_stop and s.university_id = v_student.university_id and s.is_active) then
      raise exception 'STOP_INVALID' using errcode = '22023';
    end if;
    if v_ret is null or not (v_ret = any (private.return_slots())) or v_ret <= v_out then
      raise exception 'RETURN_TIME_INVALID' using errcode = '22023';
    end if;
    if not exists (select 1 from public.stops s where s.id = v_ret_stop and s.university_id = v_student.university_id and s.is_active) then
      raise exception 'RETURN_STOP_INVALID' using errcode = '22023';
    end if;
    insert into public.pickup_patients (student_id, service_date, university_id, seq, full_name, phone,
                                        outbound_time, stop_id, return_time, return_stop_id)
    values (v_student.id, v_date, v_student.university_id, v_seq, v_name, v_phone, v_out, v_stop, v_ret, v_ret_stop);
  end loop;
  return v_date;
end;
$$;
revoke execute on function public.choose_my_pickup(time, uuid, time, uuid, jsonb) from public, anon;
grant execute on function public.choose_my_pickup(time, uuid, time, uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- which line carries a booked seat

-- The line is found from the booked time: an outbound seat rides the trip that passes its stop and leaves
-- after the previous slot and before the booked one (8:00 → the 7:00 trips, 10:00 → 8:50, 12:00 → 10:40…);
-- a return seat rides a return line passing its drop-off stop that leaves from the booked time until the next
-- slot, or one with no time (it serves every slot). Several candidates: the one whose time at that stop is
-- closest to the booked time, then the library order of the routes' names. Lines must run on that weekday.
create or replace function private.pickup_line(p_university_id uuid, p_date date, p_direction text, p_slot time, p_stop_id uuid)
returns table (route_id uuid, route_name text, route_departure time, stop_seq integer, stop_time time)
language sql
stable
security definer
set search_path = ''
as $$
  with slots as (
    select case when p_direction = 'outbound' then private.outbound_slots() else private.return_slots() end as list
  ),
  bounds as (
    select
      case when p_direction = 'outbound'
           then coalesce((select max(x) from slots, unnest(slots.list) x where x < p_slot), time '00:00')
           else p_slot end as low,
      case when p_direction = 'outbound'
           then p_slot
           else coalesce((select min(x) from slots, unnest(slots.list) x where x > p_slot), time '23:59:59') end as high
  )
  select r.id, r.name, r.departure_time, rs.seq, rs.departure_time
  from public.routes r
  join public.route_stops rs on rs.route_id = r.id and rs.stop_id = p_stop_id
  cross join bounds b
  where p_stop_id is not null
    and r.university_id = p_university_id
    and r.is_active
    and r.direction in (p_direction, 'both')
    and (r.active_days is null or cardinality(r.active_days) = 0 or extract(isodow from p_date)::smallint = any (r.active_days))
    and (
      (p_direction = 'outbound' and coalesce(r.departure_time, rs.departure_time) >= b.low
                                and coalesce(r.departure_time, rs.departure_time) < b.high)
      or (p_direction = 'return' and (r.departure_time is null
                                      or (r.departure_time >= b.low and r.departure_time < b.high)))
    )
  order by
    (r.departure_time is null),
    abs(extract(epoch from (coalesce(rs.departure_time, r.departure_time, p_slot) - p_slot))),
    r.name
  limit 1;
$$;

-- Staff: every booked seat of a day — riders and patients, outbound and return legs — with the line and
-- the stop's place on it. Who: student / supervisor (a student who also scans) / doctor / employee /
-- patient (with the student who booked the seat).
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
      -- riders
      select 'r:' || pc.student_id::text as seat_id,
             case when s.kind <> 'student' then s.kind
                  when p.role in ('supervisor', 'university_supervisor') then 'supervisor'
                  else 'student' end as passenger_type,
             s.full_name, s.phone_e164 as phone, s.transport_number,
             null::text as booked_by_name, null::text as booked_by_transport,
             pc.outbound_time, pc.stop_id, pc.stop_name, pc.return_time, pc.return_stop_id, pc.return_stop_name
      from public.pickup_choices pc
      join public.students s on s.id = pc.student_id
      left join public.profiles p on p.id = s.profile_id
      where pc.university_id = p_university_id and pc.service_date = p_date
      union all
      -- patients, with the student who booked them
      select 'p:' || pp.id::text, 'patient', pp.full_name, pp.phone, null,
             s.full_name, s.transport_number,
             pp.outbound_time, pp.stop_id, pp.stop_name, pp.return_time, pp.return_stop_id, pp.return_stop_name
      from public.pickup_patients pp
      join public.students s on s.id = pp.student_id
      where pp.university_id = p_university_id and pp.service_date = p_date
    ),
    legs as (
      select seats.*, 'outbound'::text as direction, seats.outbound_time as slot,
             seats.stop_id as leg_stop_id, seats.stop_name as leg_stop_name
      from seats
      union all
      select seats.*, 'return', seats.return_time, seats.return_stop_id, seats.return_stop_name
      from seats where seats.return_time is not null
    )
    select l.seat_id, l.passenger_type, l.full_name, l.phone, l.transport_number, l.booked_by_name, l.booked_by_transport,
           l.direction, l.slot, l.leg_stop_id, coalesce(st.name, l.leg_stop_name), st.area_id, a.name,
           line.route_id, line.route_name, line.route_departure, line.stop_seq, line.stop_time
    from legs l
    left join public.stops st on st.id = l.leg_stop_id
    left join public.areas a on a.id = st.area_id
    left join lateral private.pickup_line(p_university_id, p_date, l.direction, l.slot, l.leg_stop_id) line on l.slot is not null
    order by l.direction, l.slot nulls last, line.route_departure nulls last, line.route_name, line.stop_seq, l.full_name;
end;
$$;
revoke execute on function public.pickup_passengers(uuid, date) from public, anon;
grant execute on function public.pickup_passengers(uuid, date) to authenticated;
