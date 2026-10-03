-- Student import assigns the package chosen by «مبلغ الشريحة» (owner's request), in one batch.
-- Only students without an active subscription get one, so a re-import never replaces a package.
-- Re-runnable.

create or replace function public.import_assign_packages(p_rows jsonb)
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
  insert into public.subscriptions (student_id, package_id, trips_per_week, starts_on, ends_on, note)
  select distinct on (s.id) s.id, p.id, p.trips_per_week, p.semester_start, p.semester_end, 'استيراد (مبلغ الشريحة)'
  from jsonb_to_recordset(p_rows) as x(student_id uuid, package_id uuid)
  join public.students s on s.id = x.student_id
  join public.packages p on p.id = x.package_id and p.university_id = s.university_id
  where not exists (select 1 from public.subscriptions sb where sb.student_id = s.id and sb.status = 'active');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function public.import_assign_packages(jsonb) from public, anon, authenticated;
grant execute on function public.import_assign_packages(jsonb) to service_role;
