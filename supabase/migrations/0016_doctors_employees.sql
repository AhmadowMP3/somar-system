-- Doctors and university employees ride like students (account, transport number, QR, card)
-- but without a package: their trips are unlimited. They live in `students` with a `kind`.

alter table public.students add column if not exists kind text not null default 'student';
alter table public.students drop constraint if exists students_kind_check;
alter table public.students add constraint students_kind_check check (kind in ('student', 'doctor', 'employee'));
alter table public.students add column if not exists job_title text;
alter table public.students add column if not exists work_hours_text text;
alter table public.students add column if not exists notes text;

-- College, university number, phone and shift start stay mandatory for students only.
alter table public.students alter column college_id drop not null;
alter table public.students alter column university_student_no drop not null;
alter table public.students alter column phone_e164 drop not null;
alter table public.students alter column shift_start drop not null;
alter table public.students drop constraint if exists students_student_fields_check;
alter table public.students add constraint students_student_fields_check check (
  kind <> 'student'
  or (college_id is not null and university_student_no is not null and phone_e164 is not null and shift_start is not null));
alter table public.students drop constraint if exists students_work_days_check;
alter table public.students add constraint students_work_days_check check (
  work_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[] and (kind <> 'student' or cardinality(work_days) > 0));

create index if not exists students_university_kind_idx on public.students (university_id, kind);

-- ---------------------------------------------------------------- list view

-- v_student_balance (0003) plus the rider kind and the member fields. A separate view, because every
-- migration is re-run in order and 0003 could not replace a view that has gained columns.
create or replace view public.v_rider_balance
with (security_invoker = true) as
select
  s.id as student_id,
  s.university_id,
  s.college_id,
  c.name as college_name,
  s.profile_id,
  s.transport_number,
  s.full_name,
  s.university_student_no,
  s.phone_e164,
  s.residence_text,
  s.area_primary_id,
  a1.name as area_primary_name,
  s.area_secondary_id,
  s.area_other_text,
  s.needs_area_mapping,
  s.work_days,
  s.shift_start,
  s.photo_path is not null as has_photo,
  s.is_active,
  p.role as profile_role,
  s.created_at,
  sub.id as subscription_id,
  sub.package_id,
  pk.name as package_name,
  sub.ends_on as subscription_ends_on,
  b.week_start,
  coalesce(b.quota, 0) as quota,
  coalesce(b.used, 0) as used,
  coalesce(b.remaining, 0) as remaining,
  s.kind,
  s.job_title,
  s.work_hours_text,
  s.notes
from public.students s
left join public.colleges c on c.id = s.college_id
left join public.areas a1 on a1.id = s.area_primary_id
left join public.profiles p on p.id = s.profile_id
left join lateral private.compute_balance(s.id, public.damascus_today()) b on true
left join public.subscriptions sub on sub.id = b.subscription_id
left join public.packages pk on pk.id = sub.package_id;

-- ---------------------------------------------------------------- provisioning

create or replace function public.provision_student(
  p_user_id uuid, p_university_id uuid, p_transport_number text, p_data jsonb, p_actor uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_kind text := coalesce(nullif(p_data ->> 'kind', ''), 'student');
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.profiles (id, login_code, role, university_id, full_name, phone, must_change_password)
  values (p_user_id, p_transport_number, 'student', p_university_id, p_data ->> 'full_name',
          nullif(p_data ->> 'phone_e164', ''), true);

  insert into public.students (profile_id, university_id, kind, college_id, transport_number, full_name,
                               university_student_no, phone_e164, residence_text, area_primary_id, area_secondary_id,
                               area_other_text, work_days, shift_start, job_title, work_hours_text, notes)
  values (p_user_id, p_university_id, v_kind, nullif(p_data ->> 'college_id', '')::uuid, p_transport_number,
          p_data ->> 'full_name', nullif(p_data ->> 'university_student_no', ''), nullif(p_data ->> 'phone_e164', ''),
          nullif(p_data ->> 'residence_text', ''),
          nullif(p_data ->> 'area_primary_id', '')::uuid, nullif(p_data ->> 'area_secondary_id', '')::uuid,
          nullif(p_data ->> 'area_other_text', ''),
          array(select jsonb_array_elements_text(coalesce(p_data -> 'work_days', '[]'::jsonb))::smallint),
          nullif(p_data ->> 'shift_start', '')::time,
          nullif(p_data ->> 'job_title', ''), nullif(p_data ->> 'work_hours_text', ''), nullif(p_data ->> 'notes', ''))
  returning id into v_id;

  if p_actor is not null then
    perform private.write_audit(case v_kind when 'student' then 'student.create' else v_kind || '.create' end,
                                'students', v_id, null, p_data, p_university_id, p_actor);
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------- scan engine

create or replace function public.perform_scan(
  p_qr_token uuid default null,
  p_transport_number text default null,
  p_lat numeric default null,
  p_lng numeric default null,
  p_accuracy numeric default null,
  p_geo_denied boolean default false,
  p_override_reason text default null
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

    -- 6. work day
    if not (extract(isodow from v_today)::smallint = any (v_student.work_days)) then
      if not v_settings.allow_offday_override then
        return private.scan_reject('OFFDAY_BLOCKED', 'اليوم ليس من أيام دوام الطالب');
      end if;
      if v_reason is null then
        return private.scan_reject('OVERRIDE_REASON_REQUIRED', 'يجب كتابة سبب تجاوز يوم الدوام');
      end if;
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

  -- 9. insert
  insert into public.scans (student_id, university_id, supervisor_id, scanned_at, service_date, week_start,
                            direction, method, lat, lng, accuracy_m, geo_denied, offday_override, override_reason,
                            remaining_after)
  values (v_student.id, v_student.university_id, v_uid, v_now, v_today, v_balance.week_start,
          v_direction, v_method, p_lat, p_lng, p_accuracy, coalesce(p_geo_denied, false), v_override,
          case when v_override then v_reason end, v_remaining_after)
  returning id into v_scan_id;

  select c.name into v_college from public.colleges c where c.id = v_student.college_id;

  -- 10. result
  return jsonb_build_object(
    'ok', true,
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
    'warning', case when not v_unlimited and v_remaining_after <= v_settings.low_balance_threshold then 'LOW_BALANCE' end
  );
end;
$$;

-- ---------------------------------------------------------------- dashboards

-- The rider's own dashboard also reports the kind (doctors/employees see «unlimited»).
create or replace function public.student_dashboard(p_student_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_today date := public.damascus_today();
  v_balance private.balance;
  v_sub jsonb;
  v_scans jsonb;
  v_unread integer;
  v_latest jsonb;
  v_university jsonb;
  v_college text;
begin
  if p_student_id is null then
    select * into v_student from public.students s where s.profile_id = auth.uid();
  else
    if not private.can_view_student(p_student_id) then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
    select * into v_student from public.students s where s.id = p_student_id;
  end if;
  if v_student.id is null then
    return null;
  end if;

  v_balance := private.compute_balance(v_student.id, v_today);

  select jsonb_build_object('id', sb.id, 'package_id', sb.package_id, 'package_name', p.name,
                            'trips_per_week', sb.trips_per_week, 'starts_on', sb.starts_on, 'ends_on', sb.ends_on,
                            'status', sb.status)
  into v_sub
  from public.subscriptions sb join public.packages p on p.id = sb.package_id
  where sb.student_id = v_student.id and sb.status <> 'cancelled'
  order by (sb.id = v_balance.subscription_id) desc nulls last, (sb.status = 'active') desc, sb.created_at desc
  limit 1;

  select coalesce(jsonb_agg(x order by x.scanned_at desc), '[]'::jsonb) into v_scans
  from (
    select sc.id, sc.scanned_at, sc.service_date, sc.direction, sc.method, sc.offday_override
    from public.scans sc
    where sc.student_id = v_student.id and sc.cancelled_at is null
    order by sc.scanned_at desc
    limit 60
  ) x;

  select count(*) into v_unread from public.notifications n
  where n.student_id = v_student.id
    and not exists (select 1 from public.notification_reads r where r.notification_id = n.id and r.profile_id = auth.uid());

  select jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'type', n.type, 'created_at', n.created_at)
  into v_latest
  from public.notifications n where n.student_id = v_student.id
  order by n.created_at desc limit 1;

  select jsonb_build_object('id', u.id, 'name', u.name, 'logo_path', u.logo_path, 'week_start_dow', u.week_start_dow)
  into v_university from public.universities u where u.id = v_student.university_id;
  select c.name into v_college from public.colleges c where c.id = v_student.college_id;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'id', v_student.id, 'full_name', v_student.full_name, 'transport_number', v_student.transport_number,
      'qr_token', v_student.qr_token, 'college', v_college, 'photo_path', v_student.photo_path,
      'phone_e164', v_student.phone_e164, 'university_student_no', v_student.university_student_no,
      'work_days', to_jsonb(v_student.work_days), 'shift_start', v_student.shift_start,
      'residence_text', v_student.residence_text, 'is_active', v_student.is_active,
      'kind', v_student.kind, 'job_title', v_student.job_title, 'work_hours_text', v_student.work_hours_text),
    'university', v_university,
    'balance', jsonb_build_object('week_start', v_balance.week_start, 'quota', v_balance.quota,
                                  'used', v_balance.used, 'remaining', v_balance.remaining),
    'subscription', v_sub,
    'recent_scans', v_scans,
    'unread_count', v_unread,
    'latest_notification', v_latest,
    'today', v_today
  );
end;
$$;

-- The staff dashboard's student counters stay about students.
select private.patch_function('public.admin_dashboard(uuid)'::regprocedure,
  'select s.* from public.students s where v_university is null or s.university_id = v_university',
  'select s.* from public.students s where s.kind = ''student'' and (v_university is null or s.university_id = v_university)');
