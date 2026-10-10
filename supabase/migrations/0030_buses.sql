-- Buses (owner's request, 2026-10-10): a per-university list of buses (number, plate, seats). Before
-- scanning, a supervisor picks the bus he is on; every scan records that bus (id + a number snapshot,
-- so the history survives deleting the bus). A university without active buses scans as before.
-- Re-runnable.

-- ---------------------------------------------------------------- buses

create table if not exists public.buses (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  bus_number text not null check (bus_number = btrim(bus_number) and char_length(bus_number) between 1 and 30),
  plate_number text not null check (plate_number = btrim(plate_number) and char_length(plate_number) between 1 and 30),
  seats integer not null check (seats between 1 and 200),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists buses_university_number_idx on public.buses (university_id, lower(bus_number));

drop trigger if exists set_updated_at on public.buses;
create trigger set_updated_at before update on public.buses
  for each row execute function public.set_updated_at();
drop trigger if exists audit_row on public.buses;
create trigger audit_row after insert or update or delete on public.buses
  for each row execute function private.audit_row('bus');

alter table public.buses enable row level security;
-- the university's staff see every bus; scanners (any role with the scan page) see the active ones
drop policy if exists buses_select on public.buses;
create policy buses_select on public.buses for select to authenticated
  using (public.is_university_staff(university_id)
         or (is_active and university_id = public.current_university_id() and public.has_permission('scan')));
-- managed like stops and routes: the routes page permission
drop policy if exists buses_write on public.buses;
create policy buses_write on public.buses for all to authenticated
  using (public.staff_can(university_id, 'routes')) with check (public.staff_can(university_id, 'routes'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'buses') then
    alter publication supabase_realtime add table public.buses;
  end if;
end;
$$;

-- ---------------------------------------------------------------- scans: the bus boarded

alter table public.scans add column if not exists bus_id uuid references public.buses(id) on delete set null;
alter table public.scans add column if not exists bus_number text;
create index if not exists scans_bus_day_idx on public.scans (bus_id, service_date) where bus_id is not null;

-- ---------------------------------------------------------------- perform_scan + p_bus_id

-- 0029's behaviour unchanged, plus step 2b (bus checks), the bus columns on insert and 'bus' in the result.
drop function if exists public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text, boolean);

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
      'boarded', v_bus_boarded) end
  );
end;
$$;

revoke execute on function public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text, boolean, uuid) from public, anon;
grant execute on function public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------- bus occupancy for a day

drop function if exists public.bus_day_stats(uuid, date);
create or replace function public.bus_day_stats(p_university_id uuid, p_date date)
returns table (
  bus_id uuid, bus_number text, plate_number text, seats integer, is_active boolean,
  outbound_count integer, return_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_university_staff(p_university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
  select b.id, b.bus_number, b.plate_number, b.seats, b.is_active,
         (count(sc.id) filter (where sc.direction = 'outbound'))::integer,
         (count(sc.id) filter (where sc.direction = 'return'))::integer
  from public.buses b
  left join public.scans sc on sc.bus_id = b.id and sc.service_date = p_date and sc.cancelled_at is null
  where b.university_id = p_university_id
  group by b.id
  order by lower(b.bus_number);
end;
$$;

revoke execute on function public.bus_day_stats(uuid, date) from public, anon;
grant execute on function public.bus_day_stats(uuid, date) to authenticated;
