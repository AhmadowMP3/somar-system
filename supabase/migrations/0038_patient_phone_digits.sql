-- Patients' phone numbers typed with Arabic-Indic or Persian digits (Arabic phone keyboards) were rejected as
-- invalid (owner's report, 2026-10-19). They are now converted to Western digits before the check. Otherwise
-- identical to 0037. Re-runnable.

create or replace function public.choose_my_pickup(
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

  -- a new booking, or a change to the one already made for that day: the patients are replaced as a whole
  insert into public.pickup_choices (student_id, service_date, university_id, outbound_time, stop_id,
                                     outbound_route_id, outbound_route_name, outbound_stop_time)
  values (v_student.id, v_date, v_student.university_id, p_outbound_time, p_stop_id,
          v_option.route_id, v_option.route_name, v_option.stop_time)
  on conflict (student_id, service_date) do update
    set outbound_time = excluded.outbound_time,
        stop_id = excluded.stop_id,
        outbound_route_id = excluded.outbound_route_id,
        outbound_route_name = excluded.outbound_route_name,
        outbound_stop_time = excluded.outbound_stop_time;
  delete from public.pickup_patients where student_id = v_student.id and service_date = v_date;

  for v_patient in select value from jsonb_array_elements(v_patients) loop
    v_seq := v_seq + 1;
    v_name := btrim(coalesce(v_patient ->> 'full_name', ''));
    if char_length(v_name) not between 2 and 80 then
      raise exception 'PATIENT_NAME_INVALID' using errcode = '22023';
    end if;
    -- spaces, dashes and brackets typed in a phone number are ignored
    -- Arabic phone keyboards type ٠٩٤٤…: those digits count the same as 0944…
    v_phone := regexp_replace(
      translate(coalesce(v_patient ->> 'phone', ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
      '[\s\-().]', '', 'g');
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
