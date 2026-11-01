-- The notification about a new note or complaint is for the admin account only (owner's request, 2026-11-01):
-- university supervisors no longer see it in their bell or inbox, including the ones already sent. Supervisors
-- with the 'feedback' permission still open the page. The phone push follows the same rule (services/push.ts).
-- Re-runnable.

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select to authenticated
  using (student_id = public.current_student_id()
         or (student_id is null and type <> 'FEEDBACK' and public.is_university_staff(university_id))
         or public.is_admin());

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
         or (n.student_id is null and public.is_university_staff(n.university_id)
             and (n.type <> 'FEEDBACK' or public.is_admin())))
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
     or (n.student_id is null and public.is_university_staff(n.university_id)
         and (n.type <> 'FEEDBACK' or public.is_admin()))
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
