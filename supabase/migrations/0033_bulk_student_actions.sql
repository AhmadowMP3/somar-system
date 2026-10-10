-- Bulk «تعديل الباقة» from the students list: assign_subscription for every picked student in one call.
-- Same rule as the single action (admin only); a failing student is reported and the others still get the package.

drop function if exists public.bulk_assign_subscription(uuid[], uuid, date, date, text);
create function public.bulk_assign_subscription(
  p_student_ids uuid[], p_package_id uuid, p_starts_on date default null, p_ends_on date default null, p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pkg public.packages%rowtype;
  v_id uuid;
  v_university uuid;
  v_kind text;
  v_done int := 0;
  v_failed jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_student_ids), 0) = 0 or cardinality(p_student_ids) > 1000 then
    raise exception 'VALIDATION' using errcode = '22023';
  end if;
  select * into v_pkg from public.packages where id = p_package_id;
  if v_pkg.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  foreach v_id in array array(select distinct x from unnest(p_student_ids) x where x is not null) loop
    select s.university_id, s.kind into v_university, v_kind from public.students s where s.id = v_id;
    if v_university is null then
      v_failed := v_failed || jsonb_build_object('student_id', v_id, 'code', 'NOT_FOUND');
    elsif v_university <> v_pkg.university_id then
      v_failed := v_failed || jsonb_build_object('student_id', v_id, 'code', 'WRONG_UNIVERSITY');
    elsif v_kind <> 'student' then
      -- doctors and employees ride without a package
      v_failed := v_failed || jsonb_build_object('student_id', v_id, 'code', 'NOT_A_STUDENT');
    else
      begin
        perform public.assign_subscription(v_id, p_package_id, p_starts_on, p_ends_on, p_note);
        v_done := v_done + 1;
      exception when others then
        v_failed := v_failed || jsonb_build_object('student_id', v_id, 'code', sqlerrm);
      end;
    end if;
  end loop;

  -- each subscription row is audited by its trigger; this line records the bulk action itself
  perform private.write_audit('subscription.bulk_assign', 'packages', p_package_id, null,
    jsonb_build_object('assigned', v_done, 'failed', jsonb_array_length(v_failed)), v_pkg.university_id);
  return jsonb_build_object('assigned', v_done, 'failed', v_failed);
end;
$$;

revoke execute on function public.bulk_assign_subscription(uuid[], uuid, date, date, text) from public, anon;
grant execute on function public.bulk_assign_subscription(uuid[], uuid, date, date, text) to authenticated;
