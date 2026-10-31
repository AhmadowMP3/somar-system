-- «الملاحظات والشكاوى» (owner's request, 2026-10-31). Re-runnable.
-- Students, doctors, employees and supervisors send a note or a complaint with up to two photos; the staff
-- (permission 'feedback') see them, set a status and reply. Sending goes through the API (it stores the
-- photos); the reply reaches a rider as a notification, and every new submission notifies the staff.

-- ---------------------------------------------------------------- permission key

alter table public.profiles drop constraint if exists profiles_permissions_check;
alter table public.profiles add constraint profiles_permissions_check check (
  permissions is null or permissions <@ array['dashboard', 'students', 'import', 'packages', 'routes', 'org', 'stats',
                                              'pickups', 'scans', 'scan', 'notifications', 'supervisors', 'settings', 'audit',
                                              'feedback']);

-- ---------------------------------------------------------------- notification types

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('LOW_BALANCE', 'SUBSCRIPTION_EXPIRING', 'SCHEDULE_CHANGED', 'BROADCAST',
                  'LOW_BALANCE_DIGEST', 'EXPIRING_DIGEST', 'RECURRING', 'FEEDBACK', 'FEEDBACK_REPLY'));

-- ---------------------------------------------------------------- submissions

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  author_profile_id uuid references public.profiles(id) on delete set null,
  author_student_id uuid references public.students(id) on delete set null,
  -- kept with the submission: the account may change or be deleted later
  author_name text not null,
  author_code text,
  author_type text not null check (author_type in ('student', 'doctor', 'employee', 'supervisor')),
  kind text not null check (kind in ('note', 'complaint')),
  body text not null check (char_length(btrim(body)) between 3 and 2000),
  image_paths text[] not null default '{}' check (cardinality(image_paths) <= 2),
  status text not null default 'new' check (status in ('new', 'in_progress', 'resolved')),
  reply text check (reply is null or char_length(btrim(reply)) between 1 and 2000),
  replied_at timestamptz,
  replied_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists feedback_university_idx on public.feedback (university_id, created_at desc);
create index if not exists feedback_author_idx on public.feedback (author_profile_id, created_at desc);

drop trigger if exists set_updated_at on public.feedback;
create trigger set_updated_at before update on public.feedback
  for each row execute function public.set_updated_at();
drop trigger if exists audit_row on public.feedback;
create trigger audit_row after update or delete on public.feedback
  for each row execute function private.audit_row('feedback');

alter table public.feedback enable row level security;
drop policy if exists feedback_select on public.feedback;
create policy feedback_select on public.feedback for select to authenticated
  using (author_profile_id = auth.uid() or public.staff_can(university_id, 'feedback'));
-- no write policies: sending goes through the API, answering through answer_feedback()

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'feedback') then
    alter publication supabase_realtime add table public.feedback;
  end if;
end;
$$;

-- ---------------------------------------------------------------- photos

-- Photos live at {university_id}/{feedback_id}/{n}.jpg in a private bucket; written by the API only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('feedback-images', 'feedback-images', false, 5242880, array['image/jpeg'])
on conflict (id) do update set public = false;

-- A photo is readable by whoever can read its submission: the sender, or staff with the permission.
create or replace function public.can_read_feedback_image(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.feedback%rowtype;
begin
  if public.is_admin() then
    return true;
  end if;
  select * into v_row from public.feedback f where p_name = any (f.image_paths) limit 1;
  if v_row.id is null then
    return false;
  end if;
  return v_row.author_profile_id = auth.uid() or public.staff_can(v_row.university_id, 'feedback');
end;
$$;
revoke execute on function public.can_read_feedback_image(text) from public, anon;
grant execute on function public.can_read_feedback_image(text) to authenticated;

drop policy if exists feedback_images_read on storage.objects;
create policy feedback_images_read on storage.objects for select to authenticated
  using (bucket_id = 'feedback-images' and public.can_read_feedback_image(name));

-- ---------------------------------------------------------------- staff: status and reply

-- A reply (new or changed) is sent to the rider as a notification; supervisors without a rider account read
-- it on their page.
create or replace function public.answer_feedback(p_id uuid, p_status text, p_reply text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.feedback%rowtype;
  v_reply text := nullif(btrim(coalesce(p_reply, '')), '');
begin
  select * into v_row from public.feedback where id = p_id;
  if v_row.id is null or not public.staff_can(v_row.university_id, 'feedback') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_status not in ('new', 'in_progress', 'resolved') then
    raise exception 'VALIDATION' using errcode = '22023';
  end if;
  update public.feedback
  set status = p_status,
      reply = v_reply,
      replied_at = case when v_reply is distinct from v_row.reply then
                     case when v_reply is null then null else now() end
                   else replied_at end,
      replied_by = case when v_reply is distinct from v_row.reply then
                     case when v_reply is null then null else auth.uid() end
                   else replied_by end
  where id = p_id;

  if v_reply is not null and v_reply is distinct from v_row.reply and v_row.author_student_id is not null then
    insert into public.notifications (university_id, student_id, audience, type, title, body, data, created_by)
    values (v_row.university_id, v_row.author_student_id, jsonb_build_object('kind', 'student'), 'FEEDBACK_REPLY',
            case v_row.kind when 'complaint' then 'رد على شكواك' else 'رد على ملاحظتك' end,
            v_reply, jsonb_build_object('feedback_id', v_row.id), auth.uid());
  end if;
end;
$$;
revoke execute on function public.answer_feedback(uuid, text, text) from public, anon;
grant execute on function public.answer_feedback(uuid, text, text) to authenticated;
