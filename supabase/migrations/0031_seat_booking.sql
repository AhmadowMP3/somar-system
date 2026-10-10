-- «احجز مقعدك غداً» (owner's request, 2026-10-10): booking tomorrow's seat names all four things — the
-- outbound time and stop, the return time and the arrival stop. Times are the fixed bus slots (as in
-- packages/shared/src/schedule.ts), no longer the return routes' times. The supervisor sees the
-- booking when scanning. Re-runnable.

-- ---------------------------------------------------------------- slots, defined once

create or replace function private.outbound_slots()
returns time[]
language sql
immutable
set search_path = ''
as $$ select array['08:00', '10:00', '12:00']::time[] $$;

create or replace function private.return_slots()
returns time[]
language sql
immutable
set search_path = ''
as $$ select array['11:30', '14:00', '15:30']::time[] $$;

-- ---------------------------------------------------------------- booking: outbound time

-- null on bookings made before this migration
alter table public.pickup_choices add column if not exists outbound_time time;

drop function if exists public.choose_my_pickup(uuid, time, uuid);
drop function if exists public.choose_my_pickup(time, uuid, time, uuid);
create function public.choose_my_pickup(p_outbound_time time, p_stop_id uuid, p_return_time time, p_return_stop_id uuid)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_state jsonb;
  v_date date;
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

  insert into public.pickup_choices (student_id, service_date, university_id, outbound_time, stop_id, return_time, return_stop_id)
  values (v_student.id, v_date, v_student.university_id, p_outbound_time, p_stop_id, p_return_time, p_return_stop_id);
  return v_date;
end;
$$;
revoke execute on function public.choose_my_pickup(time, uuid, time, uuid) from public, anon;
grant execute on function public.choose_my_pickup(time, uuid, time, uuid) to authenticated;

-- ---------------------------------------------------------------- staff: outbound counts per time

-- pickup_stats (0011/0015) keeps its columns: 0011 re-creates it on every apply, so its return type
-- cannot change. This one adds the outbound time; old bookings have none (null).
create or replace function public.pickup_outbound_stats(p_university_id uuid, p_date date)
returns table (outbound_time time, area_id uuid, area_name text, stop_id uuid, stop_name text, students integer)
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
    select pc.outbound_time, s.area_id, a.name, pc.stop_id, coalesce(s.name, pc.stop_name), count(*)::int
    from public.pickup_choices pc
    left join public.stops s on s.id = pc.stop_id
    left join public.areas a on a.id = s.area_id
    where pc.university_id = p_university_id and pc.service_date = p_date
    group by pc.outbound_time, s.area_id, a.name, pc.stop_id, coalesce(s.name, pc.stop_name)
    order by pc.outbound_time nulls last, count(*) desc, 5;
end;
$$;
revoke execute on function public.pickup_outbound_stats(uuid, date) from public, anon;
grant execute on function public.pickup_outbound_stats(uuid, date) to authenticated;

-- ---------------------------------------------------------------- perform_scan + the booking

-- 0030's behaviour unchanged; the success result also carries today's booking for the scan's direction.
-- It is information only and never blocks the scan.
create or replace function public.perform_scan(
  p_qr_token uuid default null,
  p_transport_number text default null,
  p_lat numeric default null,
  p_lng numeric default null,
  p_accuracy numeric default null,
  p_geo_denied boolean default false,
  p_override_reason text default null,
  p_preview boolean default false,
  p_bus_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_caller_university uuid;
  v_student public.students%rowtype;
  v_settings public.settings%rowtype;
  v_now timestamptz := public.app_now();
  v_today date := public.damascus_date(public.app_now());
  v_method text;
  v_sub public.subscriptions%rowtype;
  v_unlimited boolean;
  v_override boolean := false;
  v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_last timestamptz;
  v_minutes integer;
  v_count integer;
  v_has_outbound boolean;
  v_direction text;
  v_balance private.balance;
  v_remaining_after integer;
  v_used_after integer;
  v_scan_id uuid;
  v_college text;
  v_bus public.buses%rowtype;
  v_bus_boarded integer;
  v_booking jsonb;
begin
  -- 1. caller
  select p.role, p.university_id into v_role, v_caller_university
  from public.profiles p where p.id = v_uid and p.is_active;
  if v_role is null or v_role not in ('admin', 'university_supervisor', 'supervisor') or not public.has_permission('scan') then
    return private.scan_reject('FORBIDDEN', 'غير مصرح لك بإجراء المسح');
  end if;

  -- 2. resolve student
  if p_qr_token is not null then
    v_method := 'qr';
    select * into v_student from public.students s where s.qr_token = p_qr_token for update;
  elsif nullif(btrim(coalesce(p_transport_number, '')), '') is not null then
    v_method := 'manual';
    select * into v_student from public.students s
    where upper(s.transport_number) = upper(btrim(p_transport_number)) for update;
  end if;
  if v_student.id is null then
    return private.scan_reject('UNKNOWN_QR', 'رمز غير معروف');
  end if;
  if v_role <> 'admin' and v_student.university_id is distinct from v_caller_university then
    return private.scan_reject('WRONG_UNIVERSITY', 'الطالب لا يتبع لجامعتك');
  end if;
  -- doctors and university employees: no package, no weekly quota, any day
  v_unlimited := v_student.kind <> 'student';

  -- 2b. bus: required once the rider's university has an active bus; it must be one of them
  if p_bus_id is not null then
    select * into v_bus from public.buses b
    where b.id = p_bus_id and b.is_active and b.university_id = v_student.university_id;
    if v_bus.id is null then
      return private.scan_reject('BUS_INVALID', 'الباص المختار غير صالح');
    end if;
  elsif exists (select 1 from public.buses b where b.university_id = v_student.university_id and b.is_active) then
    return private.scan_reject('BUS_REQUIRED', 'اختر الباص قبل المسح');
  end if;

  -- 3. active
  if not v_student.is_active then
    return private.scan_reject('STUDENT_INACTIVE', 'حساب الطالب موقوف');
  end if;

  v_settings := private.effective_settings(v_student.university_id);

  -- 4. geolocation
  if v_settings.require_supervisor_geo and (p_lat is null or p_lng is null or coalesce(p_geo_denied, false)) then
    return private.scan_reject('GEO_REQUIRED', 'يجب تفعيل صلاحية الموقع للمتابعة');
  end if;

  if not v_unlimited then
    -- 5. subscription
    select * into v_sub from public.subscriptions sb
    where sb.student_id = v_student.id and sb.status = 'active'
    order by sb.created_at desc limit 1;
    if v_sub.id is null then
      if exists (select 1 from public.subscriptions sb where sb.student_id = v_student.id and sb.status = 'expired') then
        return private.scan_reject('SUBSCRIPTION_EXPIRED', 'انتهى الاشتراك');
      end if;
      return private.scan_reject('NO_ACTIVE_SUBSCRIPTION', 'لا يوجد اشتراك فعّال');
    end if;
    if v_today > v_sub.ends_on then
      return private.scan_reject('SUBSCRIPTION_EXPIRED', 'انتهى الاشتراك');
    end if;
    if v_today < v_sub.starts_on then
      return private.scan_reject('NO_ACTIVE_SUBSCRIPTION', 'لا يوجد اشتراك فعّال');
    end if;

    -- 6. work day: allowed, but flagged and warned about
    if not (extract(isodow from v_today)::smallint = any (v_student.work_days)) then
      v_override := true;
    end if;
  end if;

  -- 7. cooldown
  select max(sc.scanned_at) into v_last from public.scans sc
  where sc.student_id = v_student.id and sc.cancelled_at is null;
  if v_last is not null and v_settings.scan_cooldown_minutes > 0
     and v_last > v_now - make_interval(mins => v_settings.scan_cooldown_minutes) then
    v_minutes := greatest(1, ceil(extract(epoch from (v_last + make_interval(mins => v_settings.scan_cooldown_minutes) - v_now)) / 60.0)::int);
    return private.scan_reject('COOLDOWN', 'تم مسح هذا الطالب قبل قليل، يمكن المسح بعد ' || v_minutes || ' دقيقة',
                               jsonb_build_object('minutes_remaining', v_minutes));
  end if;

  -- 8. direction & deduction
  select count(*), coalesce(bool_or(sc.direction = 'outbound'), false) into v_count, v_has_outbound
  from public.scans sc
  where sc.student_id = v_student.id and sc.service_date = v_today and sc.cancelled_at is null;

  v_balance := private.compute_balance(v_student.id, v_today);

  if v_count = 0 then
    v_direction := 'outbound';
    if not v_unlimited and v_balance.remaining <= 0 then
      return private.scan_reject('NO_BALANCE', 'لا يوجد رصيد رحلات');
    end if;
    v_remaining_after := v_balance.remaining - 1;
    v_used_after := v_balance.used + 1;
  elsif v_count = 1 then
    if not v_has_outbound then
      return private.scan_reject('INCONSISTENT_DAY', 'بيانات اليوم غير متسقة، يرجى مراجعة الإدارة');
    end if;
    v_direction := 'return';
    v_remaining_after := v_balance.remaining;
    v_used_after := v_balance.used;
  else
    return private.scan_reject('DAY_COMPLETE', 'تم استخدام رحلتي اليوم (ذهاب وعودة)');
  end if;
  if v_unlimited then
    v_remaining_after := 0;
  end if;

  -- 9. insert (a preview records nothing; the supervisor confirms and calls again)
  if not coalesce(p_preview, false) then
    insert into public.scans (student_id, university_id, supervisor_id, scanned_at, service_date, week_start,
                              direction, method, lat, lng, accuracy_m, geo_denied, offday_override, override_reason,
                              remaining_after, bus_id, bus_number)
    values (v_student.id, v_student.university_id, v_uid, v_now, v_today, v_balance.week_start,
            v_direction, v_method, p_lat, p_lng, p_accuracy, coalesce(p_geo_denied, false), v_override,
            case when v_override then v_reason end, v_remaining_after, v_bus.id, v_bus.bus_number)
    returning id into v_scan_id;
  end if;

  select c.name into v_college from public.colleges c where c.id = v_student.college_id;

  -- riders on this bus today in this direction (this one included once recorded)
  if v_bus.id is not null then
    select count(*) into v_bus_boarded from public.scans sc
    where sc.bus_id = v_bus.id and sc.service_date = v_today and sc.direction = v_direction and sc.cancelled_at is null;
  end if;

  -- today's seat booking, for this direction (a deleted stop keeps its saved name)
  select case when v_direction = 'outbound'
           then jsonb_build_object('booked', true, 'time', to_char(pc.outbound_time, 'HH24:MI'),
                                   'stop_name', coalesce(s.name, pc.stop_name))
           else jsonb_build_object('booked', true, 'time', to_char(pc.return_time, 'HH24:MI'),
                                   'stop_name', coalesce(rs.name, pc.return_stop_name)) end
  into v_booking
  from public.pickup_choices pc
  left join public.stops s on s.id = pc.stop_id
  left join public.stops rs on rs.id = pc.return_stop_id
  where pc.student_id = v_student.id and pc.service_date = v_today;

  -- 10. result
  return jsonb_build_object(
    'ok', true,
    'preview', coalesce(p_preview, false),
    'scan_id', v_scan_id,
    'direction', v_direction,
    'method', v_method,
    'scanned_at', v_now,
    'student', jsonb_build_object(
      'id', v_student.id,
      'full_name', v_student.full_name,
      'transport_number', v_student.transport_number,
      'college', coalesce(v_college, v_student.job_title),
      'kind', v_student.kind,
      'photo_path', v_student.photo_path,
      'photo_url', null),
    'unlimited', v_unlimited,
    'quota', case when v_unlimited then null else v_balance.quota end,
    'used', v_used_after,
    'remaining_after', case when v_unlimited then null else v_remaining_after end,
    'subscription_ends_on', v_sub.ends_on,
    'offday_override', v_override,
    'warning', case when not v_unlimited and v_remaining_after <= v_settings.low_balance_threshold then 'LOW_BALANCE' end,
    'bus', case when v_bus.id is not null then jsonb_build_object(
      'id', v_bus.id,
      'bus_number', v_bus.bus_number,
      'plate_number', v_bus.plate_number,
      'seats', v_bus.seats,
      'boarded', v_bus_boarded) end,
    'booking', coalesce(v_booking, jsonb_build_object('booked', false))
  );
end;
$$;

revoke execute on function public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text, boolean, uuid) from public, anon;
grant execute on function public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text, boolean, uuid) to authenticated;
