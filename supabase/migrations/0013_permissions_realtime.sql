-- 1) Page permissions for supervisors (owner's request), enforced here and not only in the UI.
-- 2) Realtime: every app table is published so screens refresh the moment data changes.

-- ---------------------------------------------------------------- permissions

-- null = the role's historical access (university supervisor: every staff page; supervisor: scanning only).
alter table public.profiles add column if not exists permissions text[];
alter table public.profiles drop constraint if exists profiles_permissions_check;
alter table public.profiles add constraint profiles_permissions_check check (
  permissions is null or permissions <@ array['dashboard', 'students', 'import', 'packages', 'routes', 'org', 'stats',
                                              'pickups', 'scans', 'scan', 'notifications', 'supervisors', 'settings', 'audit']);

create or replace function public.has_permission(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select case p.role
             when 'admin' then true
             when 'university_supervisor' then p.permissions is null or p_key = any (p.permissions)
             when 'supervisor' then case when p.permissions is null then p_key = 'scan' else p_key = any (p.permissions) end
             else false
           end
    from public.profiles p
    where p.id = auth.uid() and p.is_active
  ), false);
$$;
grant execute on function public.has_permission(text) to authenticated;

-- Staff of the university *and* allowed to use that page.
create or replace function public.staff_can(p_university_id uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or (public.is_university_staff(p_university_id) and public.has_permission(p_key));
$$;
grant execute on function public.staff_can(uuid, text) to authenticated;

-- The admin sets a supervisor's pages; the role follows (anything beyond scanning needs the staff panel).
create or replace function public.set_staff_permissions(p_profile_id uuid, p_permissions text[])
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_perms text[];
  v_role text;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_profile from public.profiles where id = p_profile_id;
  if v_profile.id is null or v_profile.role not in ('supervisor', 'university_supervisor') then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct k order by k), '{}') into v_perms from unnest(p_permissions) k;
  if cardinality(v_perms) = 0 then
    raise exception 'PERMISSIONS_REQUIRED' using errcode = '22023';
  end if;
  v_role := case when exists (select 1 from unnest(v_perms) k where k <> 'scan') then 'university_supervisor' else 'supervisor' end;
  -- a student promoted to scanner keeps the student account: scanning only
  if v_role = 'university_supervisor' and exists (select 1 from public.students s where s.profile_id = p_profile_id) then
    raise exception 'STUDENT_SUPERVISOR_SCAN_ONLY' using errcode = '22023';
  end if;

  perform set_config('app.trusted_write', 'on', true);
  update public.profiles set permissions = v_perms, role = v_role where id = p_profile_id;
  perform set_config('app.trusted_write', 'off', true);

  perform private.write_audit('supervisor.permissions', 'profiles', p_profile_id,
                              jsonb_build_object('role', v_profile.role, 'permissions', v_profile.permissions),
                              jsonb_build_object('role', v_role, 'permissions', v_perms),
                              v_profile.university_id);
  return v_role;
end;
$$;
revoke execute on function public.set_staff_permissions(uuid, text[]) from public, anon;
grant execute on function public.set_staff_permissions(uuid, text[]) to authenticated;

-- Only the admin (or the server) may change permissions directly.
create or replace function private.guard_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null and new.permissions is distinct from old.permissions
     and coalesce(current_setting('app.trusted_write', true), '') <> 'on' and not public.is_admin() then
    raise exception 'IMMUTABLE_FIELD' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_permissions on public.profiles;
create trigger guard_permissions before update on public.profiles
  for each row execute function private.guard_permissions();

-- Rewrites a staff check inside an existing function; fails loudly if the expected text is not there.
create or replace function private.patch_function(p_fn regprocedure, p_old text, p_new text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_new in v_def) > 0 then
    return; -- already patched (re-run)
  end if;
  if position(p_old in v_def) = 0 then
    raise exception 'patch_function: % does not contain the expected check', p_fn;
  end if;
  execute replace(v_def, p_old, p_new);
end;
$$;

select private.patch_function('public.cancel_scan(uuid, text)'::regprocedure,
  'public.is_university_staff(v_scan.university_id)', 'public.staff_can(v_scan.university_id, ''scans'')');
select private.patch_function('public.ensure_colleges(uuid, text[])'::regprocedure,
  'not public.is_university_staff(p_university_id)',
  'not (public.staff_can(p_university_id, ''import'') or public.staff_can(p_university_id, ''org''))');
select private.patch_function('public.area_mapping_candidates(uuid)'::regprocedure,
  'not public.is_university_staff(p_university_id)',
  'not (public.staff_can(p_university_id, ''org'') or public.staff_can(p_university_id, ''import''))');
select private.patch_function('public.map_area_other_text(uuid, text, uuid)'::regprocedure,
  'not public.is_university_staff(p_university_id)',
  'not (public.staff_can(p_university_id, ''org'') or public.staff_can(p_university_id, ''import''))');
select private.patch_function('public.admin_dashboard(uuid)'::regprocedure,
  'if public.current_user_role() <> ''university_supervisor'' then',
  'if public.current_user_role() <> ''university_supervisor'' or not public.has_permission(''dashboard'') then');
select private.patch_function('public.duplicate_route(uuid, text)'::regprocedure,
  'public.is_university_staff(v_route.university_id)', 'public.staff_can(v_route.university_id, ''routes'')');
select private.patch_function('public.schedule_stats(uuid)'::regprocedure,
  'public.is_university_staff(p_university_id)', 'public.staff_can(p_university_id, ''stats'')');
select private.patch_function('public.setup_progress(uuid)'::regprocedure,
  'public.is_university_staff(p_university_id)', 'public.staff_can(p_university_id, ''stats'')');
select private.patch_function('public.save_student_schedule(uuid, jsonb)'::regprocedure,
  'public.is_university_staff(v_student.university_id)', 'public.staff_can(v_student.university_id, ''students'')');
select private.patch_function('public.pickup_stats(uuid, date)'::regprocedure,
  'public.is_university_staff(p_university_id)', 'public.staff_can(p_university_id, ''pickups'')');
select private.patch_function('public.pickup_days(uuid)'::regprocedure,
  'public.is_university_staff(p_university_id)', 'public.staff_can(p_university_id, ''pickups'')');
select private.patch_function('public.pickup_return_stats(uuid, date)'::regprocedure,
  'public.is_university_staff(p_university_id)', 'public.staff_can(p_university_id, ''pickups'')');
select private.patch_function('public.perform_scan(uuid, text, numeric, numeric, numeric, boolean, text)'::regprocedure,
  'if v_role is null or v_role not in (''admin'', ''university_supervisor'', ''supervisor'') then',
  'if v_role is null or v_role not in (''admin'', ''university_supervisor'', ''supervisor'') or not public.has_permission(''scan'') then');

-- Write policies follow the page permissions (reads stay with the university's staff).
drop policy if exists colleges_write on public.colleges;
create policy colleges_write on public.colleges for all to authenticated
  using (public.staff_can(university_id, 'org')) with check (public.staff_can(university_id, 'org'));
drop policy if exists areas_write on public.areas;
create policy areas_write on public.areas for all to authenticated
  using (public.staff_can(university_id, 'org')) with check (public.staff_can(university_id, 'org'));
drop policy if exists routes_write on public.routes;
create policy routes_write on public.routes for all to authenticated
  using (public.staff_can(university_id, 'routes')) with check (public.staff_can(university_id, 'routes'));
drop policy if exists route_stops_write on public.route_stops;
create policy route_stops_write on public.route_stops for all to authenticated
  using (exists (select 1 from public.routes r where r.id = route_id and public.staff_can(r.university_id, 'routes')))
  with check (exists (select 1 from public.routes r where r.id = route_id and public.staff_can(r.university_id, 'routes')));
drop policy if exists stops_write on public.stops;
create policy stops_write on public.stops for all to authenticated
  using (public.staff_can(university_id, 'routes')) with check (public.staff_can(university_id, 'routes'));
drop policy if exists students_update on public.students;
create policy students_update on public.students for update to authenticated
  using (public.staff_can(university_id, 'students')) with check (public.staff_can(university_id, 'students'));
drop policy if exists student_schedule_staff_write on public.student_schedule;
create policy student_schedule_staff_write on public.student_schedule for all to authenticated
  using (exists (select 1 from public.students s where s.id = student_id and public.staff_can(s.university_id, 'students')))
  with check (exists (select 1 from public.students s where s.id = student_id and public.staff_can(s.university_id, 'students')));
drop policy if exists recurring_notifications_staff on public.recurring_notifications;
create policy recurring_notifications_staff on public.recurring_notifications for all to authenticated
  using (public.staff_can(university_id, 'notifications')) with check (public.staff_can(university_id, 'notifications'));
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin()
         or (public.current_user_role() = 'university_supervisor' and university_id = public.current_university_id()
             and ((role = 'supervisor' and public.has_permission('supervisors'))
                  or (role = 'student' and public.has_permission('students')))))
  with check (public.is_admin()
              or (public.current_user_role() = 'university_supervisor' and university_id = public.current_university_id()
                  and ((role = 'supervisor' and public.has_permission('supervisors'))
                       or (role = 'student' and public.has_permission('students')))));
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_admin()
         or (public.current_user_role() = 'university_supervisor' and university_id = public.current_university_id()
             and public.has_permission('audit')));

-- ---------------------------------------------------------------- realtime

-- Realtime delivers a change only to subscribers whose row-level security lets them read the row.
do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array['universities', 'colleges', 'areas', 'packages', 'routes', 'route_stops', 'stops', 'profiles',
                           'students', 'subscriptions', 'subscription_adjustments', 'scans', 'settings', 'broadcasts',
                           'notifications', 'notification_reads', 'recurring_notifications', 'pickup_choices',
                           'student_schedule', 'audit_log']
  loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
