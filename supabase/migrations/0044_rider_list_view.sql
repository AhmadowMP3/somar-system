-- Students list too slow / failing with a package filter (owner's report, 2026-11-08). v_rider_balance finds the
-- package through private.compute_balance, a lateral call per student, so a filter on the package (or the exact
-- count the list asks for) computed the week's balance of every student of the university before filtering and
-- hit the statement timeout. v_rider_list gives the same columns, but finds the current subscription with a
-- plain indexed subquery (same rule as compute_balance) and computes the balance only in the select list, i.e.
-- only for the rows of the page shown (or when the list is filtered by balance). Re-runnable.

create or replace view public.v_rider_list
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
  (private.compute_balance(s.id, public.damascus_today())).week_start as week_start,
  coalesce((private.compute_balance(s.id, public.damascus_today())).quota, 0) as quota,
  coalesce((private.compute_balance(s.id, public.damascus_today())).used, 0) as used,
  coalesce((private.compute_balance(s.id, public.damascus_today())).remaining, 0) as remaining,
  s.kind,
  s.job_title,
  s.work_hours_text,
  s.notes
from public.students s
left join public.colleges c on c.id = s.college_id
left join public.areas a1 on a1.id = s.area_primary_id
left join public.profiles p on p.id = s.profile_id
left join lateral (
  select sb.id, sb.package_id, sb.ends_on
  from public.subscriptions sb
  where sb.student_id = s.id and sb.status <> 'cancelled'
    and public.damascus_today() between sb.starts_on and sb.ends_on
  order by (sb.status = 'active') desc, sb.created_at desc
  limit 1
) sub on true
left join public.packages pk on pk.id = sub.package_id;

grant select on public.v_rider_list to authenticated;

create index if not exists subscriptions_student_dates_idx on public.subscriptions (student_id, starts_on, ends_on);
create index if not exists students_university_kind_idx on public.students (university_id, kind, transport_number);

-- ---------------------------------------------------------------- row-level security, once per query

-- The read policies of the big tables called is_university_staff(row.university_id) for every row, and each
-- call looked the caller up in profiles three times: a list of 2,400 students cost ~7,000 lookups, plus the
-- same again for their subscriptions. Same rules as before, but the caller's role, university and student id
-- are read once per query: a `(select …)` around a function without row arguments is evaluated once.
create or replace function private.staff_university(p_university_id uuid, p_role text, p_own_university uuid)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role = 'admin' or (p_role = 'university_supervisor' and p_own_university = p_university_id);
$$;
grant execute on function private.staff_university(uuid, text, uuid) to authenticated, service_role;

drop policy if exists students_select on public.students;
create policy students_select on public.students for select to authenticated
  using (profile_id = (select auth.uid())
         or private.staff_university(university_id, (select public.current_user_role()), (select public.current_university_id())));

drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions for select to authenticated
  using (student_id = (select public.current_student_id())
         or (select public.is_admin())
         or ((select public.current_user_role()) = 'university_supervisor'
             and exists (select 1 from public.students s
                         where s.id = student_id and s.university_id = (select public.current_university_id()))));

drop policy if exists scans_select on public.scans;
create policy scans_select on public.scans for select to authenticated
  using (private.staff_university(university_id, (select public.current_user_role()), (select public.current_university_id()))
         or supervisor_id = (select auth.uid())
         or (student_id = (select public.current_student_id()) and cancelled_at is null));

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (student_id = (select public.current_student_id())
         or (student_id is null and type <> 'FEEDBACK'
             and private.staff_university(university_id, (select public.current_user_role()), (select public.current_university_id())))
         or (select public.is_admin()));

drop policy if exists pickup_choices_select on public.pickup_choices;
create policy pickup_choices_select on public.pickup_choices for select to authenticated
  using (student_id = (select public.current_student_id())
         or private.staff_university(university_id, (select public.current_user_role()), (select public.current_university_id())));

drop policy if exists pickup_patients_select on public.pickup_patients;
create policy pickup_patients_select on public.pickup_patients for select to authenticated
  using (student_id = (select public.current_student_id())
         or private.staff_university(university_id, (select public.current_user_role()), (select public.current_university_id())));

-- a «for all» policy also applies to reads, so this one ran is_admin() for every subscription row too
drop policy if exists subscriptions_write on public.subscriptions;
create policy subscriptions_write on public.subscriptions for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
