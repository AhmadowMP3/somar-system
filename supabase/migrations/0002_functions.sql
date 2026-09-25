-- 0002_functions.sql — helpers, balance, scan engine, jobs, provisioning RPCs. Re-runnable.

-- ---------------------------------------------------------------- identity helpers

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.is_active;
$$;

create or replace function public.current_university_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.university_id from public.profiles p where p.id = auth.uid() and p.is_active;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'admin', false);
$$;

-- admin, or a university_supervisor of the given university
create or replace function public.is_university_staff(p_university_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin()
      or (public.current_user_role() = 'university_supervisor' and public.current_university_id() = p_university_id);
$$;

create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id from public.students s where s.profile_id = auth.uid();
$$;

-- A backend connection: the service_role key, or a direct database session with no JWT at all.
create or replace function private.is_trusted()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.role() = 'service_role', false)
      or nullif(current_setting('request.jwt.claims', true), '') is null
         and nullif(current_setting('request.jwt.claim.sub', true), '') is null;
$$;

create or replace function private.request_ip()
returns text
language sql
stable
set search_path = ''
as $$
  select split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1);
$$;

create or replace function private.write_audit(
  p_action text, p_entity text, p_entity_id uuid, p_before jsonb, p_after jsonb, p_university_id uuid,
  p_actor uuid default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (actor_profile_id, university_id, action, entity, entity_id, before, after, ip)
  values (coalesce(p_actor, auth.uid()), p_university_id, p_action, p_entity, p_entity_id, p_before, p_after,
          nullif(private.request_ip(), ''));
$$;

-- ---------------------------------------------------------------- settings

create or replace function private.effective_settings(p_university_id uuid)
returns public.settings
language sql
stable
security definer
set search_path = ''
as $$
  select s.* from public.settings s
  where s.university_id = p_university_id or s.university_id is null
  order by (s.university_id is null)
  limit 1;
$$;

create or replace function public.get_settings(p_university_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_university uuid := coalesce(p_university_id, public.current_university_id());
begin
  if auth.uid() is null and not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not public.is_admin() and not private.is_trusted()
     and v_university is distinct from public.current_university_id() then
    v_university := public.current_university_id();
  end if;
  return to_jsonb(private.effective_settings(v_university));
end;
$$;

-- ---------------------------------------------------------------- balance

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'private' and t.typname = 'balance') then
    create type private.balance as (week_start date, quota integer, used integer, remaining integer, subscription_id uuid);
  end if;
end;
$$;

create or replace function private.compute_balance(p_student_id uuid, p_on_date date)
returns private.balance
language sql
stable
security definer
set search_path = ''
as $$
  with st as (
    select public.week_start(p_on_date, u.week_start_dow) as ws
    from public.students s join public.universities u on u.id = s.university_id
    where s.id = p_student_id
  ),
  sub as (
    select sb.id, sb.trips_per_week
    from public.subscriptions sb
    where sb.student_id = p_student_id and sb.status <> 'cancelled'
      and p_on_date between sb.starts_on and sb.ends_on
    order by (sb.status = 'active') desc, sb.created_at desc
    limit 1
  ),
  adj as (
    select coalesce(sum(a.delta_trips), 0)::int as total
    from public.subscription_adjustments a
    join sub on a.subscription_id = sub.id
    cross join st
    where a.week_start is null or a.week_start = st.ws
  ),
  usd as (
    select count(*)::int as n
    from public.scans sc cross join st
    where sc.student_id = p_student_id and sc.direction = 'outbound' and sc.cancelled_at is null
      and sc.service_date between st.ws and st.ws + 6
  ),
  q as (
    select st.ws, (coalesce((select trips_per_week from sub), 0) + (select total from adj))::int as quota,
           (select n from usd) as used, (select id from sub) as subscription_id
    from st
  )
  select (q.ws, q.quota, q.used, q.quota - q.used, q.subscription_id)::private.balance from q;
$$;

create or replace function private.can_view_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_trusted() or exists (
    select 1 from public.students s
    where s.id = p_student_id
      and (s.profile_id = auth.uid() or public.is_university_staff(s.university_id))
  );
$$;

create or replace function public.student_week_balance(student_id uuid, on_date date default null)
returns table (week_start date, quota integer, used integer, remaining integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  b private.balance;
begin
  if not private.can_view_student(student_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  b := private.compute_balance(student_id, coalesce(on_date, public.damascus_today()));
  if b is null then
    return;
  end if;
  week_start := b.week_start;
  quota := b.quota;
  used := b.used;
  remaining := b.remaining;
  return next;
end;
$$;

-- ---------------------------------------------------------------- scan engine

create or replace function private.scan_reject(p_code text, p_message text, p_extra jsonb default '{}'::jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'message_ar', p_message) || p_extra;
$$;

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
  if v_role is null or v_role not in ('admin', 'university_supervisor', 'supervisor') then
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

  -- 3. active
  if not v_student.is_active then
    return private.scan_reject('STUDENT_INACTIVE', 'حساب الطالب موقوف');
  end if;

  v_settings := private.effective_settings(v_student.university_id);

  -- 4. geolocation
  if v_settings.require_supervisor_geo and (p_lat is null or p_lng is null or coalesce(p_geo_denied, false)) then
    return private.scan_reject('GEO_REQUIRED', 'يجب تفعيل صلاحية الموقع للمتابعة');
  end if;

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
    if v_balance.remaining <= 0 then
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
      'college', v_college,
      'photo_path', v_student.photo_path,
      'photo_url', null),
    'quota', v_balance.quota,
    'used', v_used_after,
    'remaining_after', v_remaining_after,
    'subscription_ends_on', v_sub.ends_on,
    'offday_override', v_override,
    'warning', case when v_remaining_after <= v_settings.low_balance_threshold then 'LOW_BALANCE' end
  );
end;
$$;

create or replace function public.cancel_scan(p_scan_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scan public.scans%rowtype;
  v_ids uuid[];
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_scan from public.scans where id = p_scan_id for update;
  if v_scan.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.is_university_staff(v_scan.university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;
  if v_scan.cancelled_at is not null then
    return jsonb_build_object('ok', true, 'cancelled_ids', '[]'::jsonb);
  end if;

  with upd as (
    update public.scans sc
    set cancelled_at = public.app_now(), cancelled_by = auth.uid(), cancel_reason = v_reason
    where sc.cancelled_at is null
      and (sc.id = v_scan.id
           or (v_scan.direction = 'outbound' and sc.student_id = v_scan.student_id
               and sc.service_date = v_scan.service_date))
    returning sc.id
  )
  select array_agg(id) into v_ids from upd;

  perform private.write_audit('scan.cancel', 'scans', v_scan.id, to_jsonb(v_scan),
                              jsonb_build_object('cancelled_ids', v_ids, 'reason', v_reason), v_scan.university_id);
  return jsonb_build_object('ok', true, 'cancelled_ids', to_jsonb(v_ids));
end;
$$;

-- ---------------------------------------------------------------- student dashboard

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
      'residence_text', v_student.residence_text, 'is_active', v_student.is_active),
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

-- ---------------------------------------------------------------- subscriptions

create or replace function public.assign_subscription(
  p_student_id uuid, p_package_id uuid, p_starts_on date default null, p_ends_on date default null, p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pkg public.packages%rowtype;
  v_student public.students%rowtype;
  v_id uuid;
begin
  if not public.is_admin() and not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_pkg from public.packages where id = p_package_id;
  select * into v_student from public.students where id = p_student_id;
  if v_pkg.id is null or v_student.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_pkg.university_id <> v_student.university_id then
    raise exception 'WRONG_UNIVERSITY' using errcode = '22023';
  end if;

  update public.subscriptions set status = 'cancelled'
  where student_id = p_student_id and status = 'active';

  insert into public.subscriptions (student_id, package_id, trips_per_week, starts_on, ends_on, assigned_by, note)
  values (p_student_id, p_package_id, v_pkg.trips_per_week, coalesce(p_starts_on, v_pkg.semester_start),
          coalesce(p_ends_on, v_pkg.semester_end), auth.uid(), p_note)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.bulk_adjust_package(
  p_package_id uuid, p_scope text, p_delta integer, p_week_date date default null, p_reason text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pkg public.packages%rowtype;
  v_dow smallint;
  v_week date;
  v_count integer;
begin
  if not public.is_admin() and not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'DELTA_REQUIRED' using errcode = '22023';
  end if;
  select * into v_pkg from public.packages where id = p_package_id;
  if v_pkg.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select week_start_dow into v_dow from public.universities where id = v_pkg.university_id;
  v_week := case p_scope
    when 'permanent' then null
    when 'this_week' then public.week_start(public.damascus_today(), v_dow)
    when 'week' then public.week_start(p_week_date, v_dow)
  end;
  if p_scope not in ('permanent', 'this_week', 'week') or (p_scope = 'week' and p_week_date is null) then
    raise exception 'INVALID_SCOPE' using errcode = '22023';
  end if;

  insert into public.subscription_adjustments (subscription_id, week_start, delta_trips, reason, created_by)
  select sb.id, v_week, p_delta, p_reason, auth.uid()
  from public.subscriptions sb
  where sb.package_id = p_package_id and sb.status = 'active';
  get diagnostics v_count = row_count;

  perform private.write_audit('adjustment.bulk_insert', 'packages', p_package_id, null,
                              jsonb_build_object('scope', p_scope, 'week_start', v_week, 'delta', p_delta,
                                                 'reason', p_reason, 'count', v_count), v_pkg.university_id);
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- roles

create or replace function public.promote_student_to_supervisor(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if not public.is_admin() and not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select p.* into v_profile from public.profiles p join public.students s on s.profile_id = p.id where s.id = p_student_id;
  if v_profile.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_profile.role <> 'student' then
    return;
  end if;
  perform set_config('app.trusted_write', 'on', true);
  update public.profiles set role = 'supervisor' where id = v_profile.id;
  perform private.write_audit('role.change', 'profiles', v_profile.id, jsonb_build_object('role', 'student'),
                              jsonb_build_object('role', 'supervisor'), v_profile.university_id);
end;
$$;

create or replace function public.demote_supervisor_to_student(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if not public.is_admin() and not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles where id = p_profile_id;
  if v_profile.id is null or not exists (select 1 from public.students where profile_id = p_profile_id) then
    raise exception 'NOT_A_STUDENT' using errcode = '22023';
  end if;
  if v_profile.role <> 'supervisor' then
    return;
  end if;
  perform set_config('app.trusted_write', 'on', true);
  update public.profiles set role = 'student' where id = p_profile_id;
  perform private.write_audit('role.change', 'profiles', p_profile_id, jsonb_build_object('role', 'supervisor'),
                              jsonb_build_object('role', 'student'), v_profile.university_id);
end;
$$;

-- ---------------------------------------------------------------- notifications

create or replace function public.unread_notifications_count()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
  from public.notifications n
  where (n.student_id = public.current_student_id()
         or (n.student_id is null and public.is_university_staff(n.university_id)))
    and not exists (select 1 from public.notification_reads r
                    where r.notification_id = n.id and r.profile_id = auth.uid());
$$;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    return 0;
  end if;
  insert into public.notification_reads (notification_id, profile_id)
  select n.id, auth.uid() from public.notifications n
  where n.student_id = public.current_student_id()
     or (n.student_id is null and public.is_university_staff(n.university_id))
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function private.notify_schedule_change(p_university_id uuid, p_body text, p_data jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (university_id, student_id, audience, type, title, body, data, created_by)
  select p_university_id, s.id, jsonb_build_object('kind', 'university'), 'SCHEDULE_CHANGED',
         'تغيير في مواعيد الرحلات', p_body, p_data, auth.uid()
  from public.students s
  where s.university_id = p_university_id and s.is_active;
$$;

create or replace function private.on_route_time_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_route public.routes%rowtype;
begin
  if new.departure_time is not distinct from old.departure_time or new.departure_time is null then
    return new;
  end if;
  if tg_table_name = 'routes' then
    perform private.notify_schedule_change(
      new.university_id,
      'تم تغيير موعد انطلاق خط «' || new.name || '» إلى ' || to_char(new.departure_time, 'HH24:MI'),
      jsonb_build_object('route_id', new.id, 'departure_time', to_char(new.departure_time, 'HH24:MI')));
    perform private.write_audit('route.time_change', 'routes', new.id,
                                jsonb_build_object('departure_time', old.departure_time),
                                jsonb_build_object('departure_time', new.departure_time), new.university_id);
  else
    select * into v_route from public.routes where id = new.route_id;
    perform private.notify_schedule_change(
      v_route.university_id,
      'تم تغيير موعد نقطة «' || new.name || '» على خط «' || v_route.name || '» إلى ' || to_char(new.departure_time, 'HH24:MI'),
      jsonb_build_object('route_id', v_route.id, 'stop_id', new.id, 'departure_time', to_char(new.departure_time, 'HH24:MI')));
    perform private.write_audit('route.time_change', 'route_stops', new.id,
                                jsonb_build_object('departure_time', old.departure_time),
                                jsonb_build_object('departure_time', new.departure_time), v_route.university_id);
  end if;
  return new;
end;
$$;

drop trigger if exists notify_time_change on public.routes;
create trigger notify_time_change after update of departure_time on public.routes
  for each row execute function private.on_route_time_change();
drop trigger if exists notify_time_change on public.route_stops;
create trigger notify_time_change after update of departure_time on public.route_stops
  for each row execute function private.on_route_time_change();

-- Daily evaluation. Idempotent per (student, type, service_date) and per (university, digest type, service_date).
create or replace function public.run_daily_jobs(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := public.app_now();
  v_today date := public.damascus_date(public.app_now());
  v_hour integer := extract(hour from (public.app_now() at time zone 'Asia/Damascus'))::int;
  v_expired integer;
  v_low integer := 0;
  v_exp integer := 0;
  v_n integer;
  u record;
  st public.settings%rowtype;
  v_names text;
  v_count integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  update public.subscriptions set status = 'expired' where status = 'active' and ends_on < v_today;
  get diagnostics v_expired = row_count;

  for u in select * from public.universities where is_active loop
    st := private.effective_settings(u.id);
    continue when not p_force and v_hour < st.daily_job_hour;

    insert into public.notifications (university_id, student_id, audience, type, title, body, data, service_date)
    select u.id, s.id, jsonb_build_object('kind', 'student', 'student_id', s.id), 'LOW_BALANCE',
           'رصيد الرحلات منخفض', 'تبقى لديك ' || greatest(b.remaining, 0) || ' رحلة هذا الأسبوع',
           jsonb_build_object('remaining', b.remaining, 'quota', b.quota), v_today
    from public.students s
    cross join lateral private.compute_balance(s.id, v_today) b
    where s.university_id = u.id and s.is_active and b.subscription_id is not null
      and b.remaining <= st.low_balance_threshold
    on conflict (student_id, type, service_date) where student_id is not null and service_date is not null do nothing;
    get diagnostics v_n = row_count;
    v_low := v_low + v_n;

    insert into public.notifications (university_id, student_id, audience, type, title, body, data, service_date)
    select u.id, s.id, jsonb_build_object('kind', 'student', 'student_id', s.id), 'SUBSCRIPTION_EXPIRING',
           'اشتراكك على وشك الانتهاء', 'ينتهي اشتراكك بتاريخ ' || to_char(sb.ends_on, 'DD/MM/YYYY'),
           jsonb_build_object('ends_on', sb.ends_on, 'subscription_id', sb.id), v_today
    from public.students s
    join public.subscriptions sb on sb.student_id = s.id and sb.status = 'active'
    where s.university_id = u.id and s.is_active
      and sb.ends_on - v_today between 0 and st.expiry_warning_days
    on conflict (student_id, type, service_date) where student_id is not null and service_date is not null do nothing;
    get diagnostics v_n = row_count;
    v_exp := v_exp + v_n;

    -- staff digests
    select count(*), string_agg(x.full_name || ' (' || x.transport_number || '): ' || x.remaining, '، ')
    into v_count, v_names
    from (
      select s.full_name, s.transport_number, b.remaining
      from public.students s cross join lateral private.compute_balance(s.id, v_today) b
      where s.university_id = u.id and s.is_active and b.subscription_id is not null
        and b.remaining <= st.low_balance_threshold
      order by b.remaining, s.transport_number
    ) x;
    if v_count > 0 then
      insert into public.notifications (university_id, student_id, audience, type, title, body, data, service_date)
      values (u.id, null, jsonb_build_object('kind', 'staff'), 'LOW_BALANCE_DIGEST',
              'طلاب برصيد منخفض: ' || v_count, left(v_names, 3000), jsonb_build_object('count', v_count), v_today)
      on conflict (university_id, type, service_date) where student_id is null and service_date is not null do nothing;
    end if;

    select count(*), string_agg(x.full_name || ' (' || x.transport_number || '): ' || to_char(x.ends_on, 'DD/MM/YYYY'), '، ')
    into v_count, v_names
    from (
      select s.full_name, s.transport_number, sb.ends_on
      from public.students s join public.subscriptions sb on sb.student_id = s.id and sb.status = 'active'
      where s.university_id = u.id and s.is_active and sb.ends_on - v_today between 0 and st.expiry_warning_days
      order by sb.ends_on, s.transport_number
    ) x;
    if v_count > 0 then
      insert into public.notifications (university_id, student_id, audience, type, title, body, data, service_date)
      values (u.id, null, jsonb_build_object('kind', 'staff'), 'EXPIRING_DIGEST',
              'اشتراكات تنتهي قريباً: ' || v_count, left(v_names, 3000), jsonb_build_object('count', v_count), v_today)
      on conflict (university_id, type, service_date) where student_id is null and service_date is not null do nothing;
    end if;
  end loop;

  return jsonb_build_object('expired_subscriptions', v_expired, 'low_balance', v_low, 'expiring', v_exp,
                            'service_date', v_today, 'ran_at', v_now);
end;
$$;

-- ---------------------------------------------------------------- provisioning (service role only)

create or replace function public.allocate_transport_number(p_university_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_next integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select transport_prefix into v_prefix from public.universities where id = p_university_id;
  if v_prefix is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.university_counters (university_id) values (p_university_id) on conflict do nothing;
  perform 1 from public.university_counters where university_id = p_university_id for update;
  update public.university_counters set last_value = last_value + 1
  where university_id = p_university_id
  returning last_value into v_next;
  return v_prefix || '-' || case when v_next < 10000 then lpad(v_next::text, 4, '0') else v_next::text end;
end;
$$;

-- Give a number back only if it is still the most recent allocation (avoids gaps after a failed provisioning).
create or replace function public.release_transport_number(p_university_id uuid, p_transport_number text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq integer := nullif(regexp_replace(split_part(p_transport_number, '-', 2), '\D', '', 'g'), '')::int;
  v_n integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.university_counters set last_value = last_value - 1
  where university_id = p_university_id and last_value = v_seq
    and not exists (select 1 from public.students where transport_number = p_transport_number);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

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
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.profiles (id, login_code, role, university_id, full_name, phone, must_change_password)
  values (p_user_id, p_transport_number, 'student', p_university_id, p_data ->> 'full_name', p_data ->> 'phone_e164', true);

  insert into public.students (profile_id, university_id, college_id, transport_number, full_name,
                               university_student_no, phone_e164, residence_text, area_primary_id, area_secondary_id,
                               area_other_text, work_days, shift_start)
  values (p_user_id, p_university_id, (p_data ->> 'college_id')::uuid, p_transport_number, p_data ->> 'full_name',
          p_data ->> 'university_student_no', p_data ->> 'phone_e164', nullif(p_data ->> 'residence_text', ''),
          nullif(p_data ->> 'area_primary_id', '')::uuid, nullif(p_data ->> 'area_secondary_id', '')::uuid,
          nullif(p_data ->> 'area_other_text', ''),
          array(select jsonb_array_elements_text(p_data -> 'work_days')::smallint), (p_data ->> 'shift_start')::time)
  returning id into v_id;

  if p_actor is not null then
    perform private.write_audit('student.create', 'students', v_id, null, p_data, p_university_id, p_actor);
  end if;
  return v_id;
end;
$$;

create or replace function public.import_update_students(p_university_id uuid, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  with r as (
    select * from jsonb_to_recordset(p_rows) as x(
      university_student_no text, full_name text, phone_e164 text, college_id uuid, residence_text text,
      area_primary_id uuid, area_secondary_id uuid, area_other_text text, work_days smallint[], shift_start time)
  ),
  upd as (
    update public.students s
    set full_name = r.full_name, phone_e164 = r.phone_e164, college_id = r.college_id,
        residence_text = r.residence_text, area_primary_id = r.area_primary_id,
        area_secondary_id = r.area_secondary_id, area_other_text = r.area_other_text,
        work_days = r.work_days, shift_start = r.shift_start
    from r
    where s.university_id = p_university_id and s.university_student_no = r.university_student_no
    returning s.profile_id, s.full_name, s.phone_e164
  ),
  prof as (
    update public.profiles p set full_name = upd.full_name, phone = upd.phone_e164
    from upd where p.id = upd.profile_id
    returning p.id
  )
  select count(*) into v_count from upd;
  return v_count;
end;
$$;

create or replace function public.ensure_colleges(p_university_id uuid, p_names text[])
returns table (id uuid, name text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_trusted() and not public.is_university_staff(p_university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  insert into public.colleges (university_id, name)
  select p_university_id, n from unnest(p_names) n where btrim(n) <> ''
  on conflict (university_id, name) do nothing;
  return query select c.id, c.name from public.colleges c where c.university_id = p_university_id;
end;
$$;

-- ---------------------------------------------------------------- area mapping

create or replace function public.area_mapping_candidates(p_university_id uuid)
returns table (area_other_text text, student_count integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_university_staff(p_university_id) and not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    select s.area_other_text, count(*)::int
    from public.students s
    where s.university_id = p_university_id and s.needs_area_mapping
    group by s.area_other_text
    order by count(*) desc, s.area_other_text;
end;
$$;

create or replace function public.map_area_other_text(p_university_id uuid, p_other_text text, p_area_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not public.is_university_staff(p_university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.areas where id = p_area_id and university_id = p_university_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  update public.students set area_primary_id = p_area_id
  where university_id = p_university_id and needs_area_mapping and area_other_text = p_other_text;
  get diagnostics v_count = row_count;
  perform private.write_audit('area.map', 'areas', p_area_id, jsonb_build_object('area_other_text', p_other_text),
                              jsonb_build_object('students', v_count), p_university_id);
  return v_count;
end;
$$;

-- ---------------------------------------------------------------- admin dashboard

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
    if public.current_user_role() <> 'university_supervisor' then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
    v_university := public.current_university_id();
  end if;

  with st as (
    select s.* from public.students s where v_university is null or s.university_id = v_university
  ),
  bal as (
    select st.id, b.* from st cross join lateral private.compute_balance(st.id, v_today) b where st.is_active
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
    'scans_today_outbound', (select count(*) from public.scans sc where sc.service_date = v_today and sc.cancelled_at is null
                               and sc.direction = 'outbound' and (v_university is null or sc.university_id = v_university)),
    'scans_today_return', (select count(*) from public.scans sc where sc.service_date = v_today and sc.cancelled_at is null
                             and sc.direction = 'return' and (v_university is null or sc.university_id = v_university)),
    'students_no_balance', (select count(*) from bal where bal.subscription_id is not null and bal.remaining <= 0),
    'subscriptions_expiring', (select count(*) from public.subscriptions sb join st on st.id = sb.student_id
                                 where sb.status = 'active' and sb.ends_on - v_today between 0 and
                                   (private.effective_settings(st.university_id)).expiry_warning_days),
    'students_no_photo', (select count(*) from st where st.is_active and st.photo_path is null),
    'needs_area_mapping', (select count(*) from st where st.needs_area_mapping),
    'chart', (select jsonb_agg(jsonb_build_object('day', chart.day, 'outbound', chart.outbound, 'return', chart.ret)
                               order by chart.day) from chart),
    'today', v_today
  ) into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------- guards & audit triggers

create or replace function private.guard_students()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and coalesce(current_setting('app.trusted_write', true), '') <> 'on' then
    if new.transport_number is distinct from old.transport_number
       or new.qr_token is distinct from old.qr_token
       or new.profile_id is distinct from old.profile_id
       or new.university_id is distinct from old.university_id
       or new.photo_path is distinct from old.photo_path
       or new.photo_uploaded_at is distinct from old.photo_uploaded_at then
      raise exception 'IMMUTABLE_FIELD' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_students on public.students;
create trigger guard_students before update on public.students
  for each row execute function private.guard_students();

create or replace function private.guard_profiles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and coalesce(current_setting('app.trusted_write', true), '') <> 'on' then
    if new.role is distinct from old.role
       or new.login_code is distinct from old.login_code
       or new.id is distinct from old.id
       or (new.university_id is distinct from old.university_id and not public.is_admin())
       or (old.role = 'admin' and not public.is_admin()) then
      raise exception 'IMMUTABLE_FIELD' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_profiles on public.profiles;
create trigger guard_profiles before update on public.profiles
  for each row execute function private.guard_profiles();

-- Keep the login of a plain student in sync with the student record's active flag.
create or replace function private.sync_student_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_active is distinct from old.is_active and new.profile_id is not null then
    update public.profiles set is_active = new.is_active where id = new.profile_id and role = 'student';
  end if;
  return new;
end;
$$;

drop trigger if exists sync_student_active on public.students;
create trigger sync_student_active after update of is_active on public.students
  for each row execute function private.sync_student_active();

-- Generic audit for writes made by signed-in users through the data API.
-- Writes made by the privileged API (no auth.uid()) are logged explicitly by the API.
create or replace function private.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_after, v_before);
  v_action text := tg_argv[0] || '.' || lower(tg_op);
  v_university uuid;
begin
  if auth.uid() is null then
    return null;
  end if;
  if tg_op = 'UPDATE' and v_before - 'updated_at' = v_after - 'updated_at' then
    return null;
  end if;
  if tg_argv[0] = 'student' and tg_op = 'UPDATE'
     and (v_before ->> 'is_active')::boolean and not (v_after ->> 'is_active')::boolean then
    v_action := 'student.deactivate';
  end if;
  if tg_argv[0] = 'profile' and tg_op = 'UPDATE'
     and (v_before ->> 'role') = (v_after ->> 'role') and (v_before ->> 'is_active') = (v_after ->> 'is_active') then
    return null;
  end if;
  v_university := coalesce(
    nullif(v_row ->> 'university_id', '')::uuid,
    (select s.university_id from public.students s
     where s.id = coalesce(nullif(v_row ->> 'student_id', '')::uuid,
                           (select sb.student_id from public.subscriptions sb
                            where sb.id = nullif(v_row ->> 'subscription_id', '')::uuid))));
  perform private.write_audit(v_action, tg_table_name, nullif(v_row ->> 'id', '')::uuid, v_before, v_after, v_university);
  return null;
end;
$$;

do $$
declare
  r record;
begin
  for r in select * from (values
    ('students', 'student'), ('subscriptions', 'subscription'), ('subscription_adjustments', 'adjustment'),
    ('settings', 'settings'), ('profiles', 'profile'), ('packages', 'package'), ('universities', 'university'))
    as t(tbl, label)
  loop
    execute format('drop trigger if exists audit_row on public.%I', r.tbl);
    execute format('create trigger audit_row after insert or update or delete on public.%I
                    for each row execute function private.audit_row(%L)', r.tbl, r.label);
  end loop;
end;
$$;

-- ---------------------------------------------------------------- supervisor: own scans today

create or replace function public.my_scans_today()
returns table (
  id uuid, scanned_at timestamptz, direction text, method text, offday_override boolean,
  cancelled_at timestamptz, student_name text, transport_number text, remaining_after smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select sc.id, sc.scanned_at, sc.direction, sc.method, sc.offday_override, sc.cancelled_at,
         s.full_name, s.transport_number, sc.remaining_after
  from public.scans sc
  join public.students s on s.id = sc.student_id
  where sc.supervisor_id = auth.uid()
    and sc.service_date = public.damascus_today()
  order by sc.scanned_at desc;
$$;
