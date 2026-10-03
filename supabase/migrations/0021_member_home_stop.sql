-- Doctors and university employees (owner's request): at first login, after the forced password change,
-- they pick their nearest stop from the university's stop library instead of the student questionnaire.
-- Re-runnable.

alter table public.students add column if not exists home_stop_id uuid;
alter table public.students drop constraint if exists students_home_stop_id_fkey;
alter table public.students add constraint students_home_stop_id_fkey
  foreign key (home_stop_id) references public.stops(id) on delete set null;
create index if not exists students_home_stop_idx on public.students (home_stop_id) where home_stop_id is not null;

create or replace function public.complete_member_setup(p_stop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_stop text;
begin
  select * into v_student from public.students where profile_id = auth.uid();
  if v_student.id is null then
    raise exception 'NOT_A_STUDENT' using errcode = '22023';
  end if;
  if v_student.kind = 'student' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_student.setup_completed_at is not null then
    raise exception 'SETUP_LOCKED' using errcode = '42501';
  end if;
  select s.name into v_stop from public.stops s
  where s.id = p_stop_id and s.university_id = v_student.university_id and s.is_active;
  if v_stop is null then
    raise exception 'STOP_INVALID' using errcode = '22023';
  end if;

  update public.students set home_stop_id = p_stop_id, setup_completed_at = now() where id = v_student.id;

  perform private.write_audit('student.setup', 'students', v_student.id, null,
                              jsonb_build_object('home_stop', v_stop), v_student.university_id);
end;
$$;
revoke execute on function public.complete_member_setup(uuid) from public, anon;
grant execute on function public.complete_member_setup(uuid) to authenticated;
