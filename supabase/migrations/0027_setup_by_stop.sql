-- The first-login questionnaire asks for the student's nearest library stop instead of an area (owner's
-- request, 2026-10-06). The student's area becomes that stop's area (created and attached to the stop
-- when missing, private.area_for_stop from 0023), and the stop itself is kept as the student's home stop.
-- complete_my_setup stays for clients that still send an area. Re-runnable.

create or replace function public.complete_my_setup_with_stop(
  p_stop_id uuid,
  p_residence text,
  p_schedule jsonb,
  p_phone text default null,
  p_college_id uuid default null,
  p_shift_start time default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_area uuid;
begin
  select * into v_student from public.students where profile_id = auth.uid();
  if v_student.id is null then
    raise exception 'NOT_A_STUDENT' using errcode = '22023';
  end if;
  if p_stop_id is null
     or not exists (select 1 from public.stops s where s.id = p_stop_id and s.university_id = v_student.university_id and s.is_active) then
    raise exception 'STOP_INVALID' using errcode = '22023';
  end if;
  if v_student.setup_completed_at is not null then
    raise exception 'SETUP_LOCKED' using errcode = '42501';
  end if;

  v_area := private.area_for_stop(p_stop_id);
  perform public.complete_my_setup(v_area, p_residence, p_schedule, p_phone, p_college_id, p_shift_start);
  update public.students set home_stop_id = p_stop_id where id = v_student.id;
end;
$$;
revoke execute on function public.complete_my_setup_with_stop(uuid, text, jsonb, text, uuid, time) from public, anon;
grant execute on function public.complete_my_setup_with_stop(uuid, text, jsonb, text, uuid, time) to authenticated;
