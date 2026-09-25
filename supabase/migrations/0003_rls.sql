-- 0003_rls.sql — row level security. Re-runnable.

do $$
declare
  t text;
begin
  foreach t in array array['universities', 'university_counters', 'colleges', 'areas', 'packages', 'routes',
                           'route_stops', 'profiles', 'students', 'subscriptions', 'subscription_adjustments',
                           'scans', 'settings', 'broadcasts', 'notifications', 'notification_reads',
                           'push_subscriptions', 'audit_log']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- universities
drop policy if exists universities_select on public.universities;
create policy universities_select on public.universities for select to authenticated
  using (public.is_admin() or id = public.current_university_id());
drop policy if exists universities_insert on public.universities;
create policy universities_insert on public.universities for insert to authenticated
  with check (public.is_admin());
drop policy if exists universities_update on public.universities;
create policy universities_update on public.universities for update to authenticated
  using (public.is_university_staff(id)) with check (public.is_university_staff(id));
drop policy if exists universities_delete on public.universities;
create policy universities_delete on public.universities for delete to authenticated
  using (public.is_admin());

-- university_counters: no client access (service role only)

-- colleges / areas / routes: read for the university, write for staff
do $$
declare
  t text;
begin
  foreach t in array array['colleges', 'areas', 'routes']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select to authenticated
                    using (public.is_admin() or university_id = public.current_university_id())', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
    execute format('create policy %I on public.%I for all to authenticated
                    using (public.is_university_staff(university_id))
                    with check (public.is_university_staff(university_id))', t || '_write', t);
  end loop;
end;
$$;

-- route_stops (scoped through the route)
drop policy if exists route_stops_select on public.route_stops;
create policy route_stops_select on public.route_stops for select to authenticated
  using (exists (select 1 from public.routes r where r.id = route_id
                 and (public.is_admin() or r.university_id = public.current_university_id())));
drop policy if exists route_stops_write on public.route_stops;
create policy route_stops_write on public.route_stops for all to authenticated
  using (exists (select 1 from public.routes r where r.id = route_id and public.is_university_staff(r.university_id)))
  with check (exists (select 1 from public.routes r where r.id = route_id and public.is_university_staff(r.university_id)));

-- packages: all users of the university read; admin writes
drop policy if exists packages_select on public.packages;
create policy packages_select on public.packages for select to authenticated
  using (public.is_admin() or university_id = public.current_university_id());
drop policy if exists packages_write on public.packages;
create policy packages_write on public.packages for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin()
         or (public.current_user_role() = 'university_supervisor' and university_id = public.current_university_id()));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin()
         or (public.current_user_role() = 'university_supervisor' and university_id = public.current_university_id()
             and role in ('supervisor', 'student')))
  with check (public.is_admin()
              or (public.current_user_role() = 'university_supervisor' and university_id = public.current_university_id()
                  and role in ('supervisor', 'student')));

-- students: own row, staff of the university; supervisors get nothing directly
drop policy if exists students_select on public.students;
create policy students_select on public.students for select to authenticated
  using (profile_id = auth.uid() or public.is_university_staff(university_id));
drop policy if exists students_update on public.students;
create policy students_update on public.students for update to authenticated
  using (public.is_university_staff(university_id)) with check (public.is_university_staff(university_id));
drop policy if exists students_delete on public.students;
create policy students_delete on public.students for delete to authenticated
  using (public.is_admin());

-- subscriptions: admin writes; staff reads their university; student reads own
drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (student_id = public.current_student_id()
         or exists (select 1 from public.students s where s.id = student_id and public.is_university_staff(s.university_id)));
drop policy if exists subscriptions_write on public.subscriptions;
create policy subscriptions_write on public.subscriptions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists subscription_adjustments_select on public.subscription_adjustments;
create policy subscription_adjustments_select on public.subscription_adjustments for select to authenticated
  using (exists (select 1 from public.subscriptions sb join public.students s on s.id = sb.student_id
                 where sb.id = subscription_id
                   and (s.id = public.current_student_id() or public.is_university_staff(s.university_id))));
drop policy if exists subscription_adjustments_write on public.subscription_adjustments;
create policy subscription_adjustments_write on public.subscription_adjustments for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- scans: read only; inserts happen exclusively through perform_scan()
drop policy if exists scans_select on public.scans;
create policy scans_select on public.scans for select to authenticated
  using (public.is_university_staff(university_id)
         or supervisor_id = auth.uid()
         or (student_id = public.current_student_id() and cancelled_at is null));

-- settings: admin only directly; everyone else uses get_settings()
drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to authenticated
  using (public.is_admin() or (public.current_user_role() = 'university_supervisor'
                               and (university_id is null or university_id = public.current_university_id())));
drop policy if exists settings_write on public.settings;
create policy settings_write on public.settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- broadcasts: staff read
drop policy if exists broadcasts_select on public.broadcasts;
create policy broadcasts_select on public.broadcasts for select to authenticated
  using (public.is_university_staff(university_id));

-- notifications
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (student_id = public.current_student_id()
         or (student_id is null and public.is_university_staff(university_id))
         or public.is_admin());

drop policy if exists notification_reads_own on public.notification_reads;
create policy notification_reads_own on public.notification_reads for all to authenticated
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- push subscriptions: own rows (inserted by the API)
drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions for select to authenticated
  using (profile_id = auth.uid());
drop policy if exists push_subscriptions_delete_own on public.push_subscriptions;
create policy push_subscriptions_delete_own on public.push_subscriptions for delete to authenticated
  using (profile_id = auth.uid());

-- audit log: admin all, university supervisor own university
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_admin()
         or (public.current_user_role() = 'university_supervisor' and university_id = public.current_university_id()));

-- ---------------------------------------------------------------- list view

create or replace view public.v_student_balance
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
  coalesce(b.remaining, 0) as remaining
from public.students s
left join public.colleges c on c.id = s.college_id
left join public.areas a1 on a1.id = s.area_primary_id
left join public.profiles p on p.id = s.profile_id
left join lateral private.compute_balance(s.id, public.damascus_today()) b on true
left join public.subscriptions sub on sub.id = b.subscription_id
left join public.packages pk on pk.id = sub.package_id;

-- ---------------------------------------------------------------- grants

grant usage on schema private to authenticated, service_role;
grant execute on function private.compute_balance(uuid, date) to authenticated, service_role;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.run_daily_jobs(boolean)',
    'public.allocate_transport_number(uuid)',
    'public.release_transport_number(uuid, text)',
    'public.provision_student(uuid, uuid, text, jsonb, uuid)',
    'public.import_update_students(uuid, jsonb)'
  ]
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$$;

revoke execute on function public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text) from public, anon;
grant execute on function public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text) to authenticated;
