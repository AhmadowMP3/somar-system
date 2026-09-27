-- 1) Recurring notifications: staff pick weekdays + a time; every active student of the university gets it.
-- 2) «مكان انطلاقتي غداً»: from 18:00 (Damascus) each day, a student picks the stop they will wait at tomorrow.

-- ---------------------------------------------------------------- recurring notifications

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in ('LOW_BALANCE', 'SUBSCRIPTION_EXPIRING', 'SCHEDULE_CHANGED', 'BROADCAST',
                  'LOW_BALANCE_DIGEST', 'EXPIRING_DIGEST', 'RECURRING'));

create table if not exists public.recurring_notifications (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  days smallint[] not null check (cardinality(days) between 1 and 7 and days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  send_time time not null,
  is_active boolean not null default true,
  last_sent_on date,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists recurring_notifications_university_idx on public.recurring_notifications (university_id);

drop trigger if exists set_updated_at on public.recurring_notifications;
create trigger set_updated_at before update on public.recurring_notifications
  for each row execute function public.set_updated_at();
drop trigger if exists audit_row on public.recurring_notifications;
create trigger audit_row after insert or update or delete on public.recurring_notifications
  for each row execute function private.audit_row('recurring_notification');

alter table public.recurring_notifications enable row level security;
drop policy if exists recurring_notifications_staff on public.recurring_notifications;
create policy recurring_notifications_staff on public.recurring_notifications for all to authenticated
  using (public.is_university_staff(university_id))
  with check (public.is_university_staff(university_id));

-- Called every minute by the API. A notification fires once per day, on a chosen weekday, within the hour
-- after its time (so a short restart does not lose it), and never for a time that had already passed
-- when it was created. Returns the number of student notifications written.
create or replace function public.run_recurring_notifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_local timestamp := public.app_now() at time zone 'Asia/Damascus';
  v_today date := v_local::date;
  v_dow smallint := extract(isodow from v_local)::smallint;
  v_time time := v_local::time;
  v_total integer := 0;
  v_n integer;
  r record;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  for r in
    select rn.* from public.recurring_notifications rn
    where rn.is_active
      and v_dow = any (rn.days)
      and (rn.last_sent_on is null or rn.last_sent_on < v_today)
      and v_time >= rn.send_time
      and v_time - rn.send_time < interval '1 hour'
      and rn.created_at <= ((v_today + rn.send_time) at time zone 'Asia/Damascus')
    for update skip locked
  loop
    insert into public.notifications (university_id, student_id, audience, type, title, body, data, created_by)
    select r.university_id, s.id, jsonb_build_object('kind', 'university'), 'RECURRING', r.title, r.body,
           jsonb_build_object('recurring_id', r.id), r.created_by
    from public.students s
    where s.university_id = r.university_id and s.is_active;
    get diagnostics v_n = row_count;
    update public.recurring_notifications set last_sent_on = v_today where id = r.id;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end;
$$;
revoke execute on function public.run_recurring_notifications() from public, anon, authenticated;

-- ---------------------------------------------------------------- tomorrow's pickup stop

create table if not exists public.pickup_choices (
  student_id uuid not null references public.students(id) on delete cascade,
  service_date date not null,
  university_id uuid not null references public.universities(id) on delete cascade,
  stop_id uuid not null references public.stops(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (student_id, service_date)
);
create index if not exists pickup_choices_day_idx on public.pickup_choices (university_id, service_date);

drop trigger if exists set_updated_at on public.pickup_choices;
create trigger set_updated_at before update on public.pickup_choices
  for each row execute function public.set_updated_at();

alter table public.pickup_choices enable row level security;
drop policy if exists pickup_choices_select on public.pickup_choices;
create policy pickup_choices_select on public.pickup_choices for select to authenticated
  using (student_id = public.current_student_id() or public.is_university_staff(university_id));
-- no write policies: students write through choose_my_pickup only.

-- The page opens at 18:00 Damascus time and the choice is always for the next day; it can be changed until midnight.
create or replace function public.pickup_window()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with n as (select public.app_now() at time zone 'Asia/Damascus' as l)
  select jsonb_build_object(
    'open', (n.l::time >= time '18:00'),
    'opens_at', '18:00',
    'today', n.l::date,
    'service_date', n.l::date + 1
  ) from n;
$$;
grant execute on function public.pickup_window() to authenticated;

create or replace function public.choose_my_pickup(p_stop_id uuid)
returns date
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_student public.students%rowtype;
  v_local timestamp := public.app_now() at time zone 'Asia/Damascus';
  v_date date := v_local::date + 1;
begin
  select * into v_student from public.students where profile_id = auth.uid();
  if v_student.id is null or not v_student.is_active then
    raise exception 'NOT_A_STUDENT' using errcode = '22023';
  end if;
  if v_local::time < time '18:00' then
    raise exception 'PICKUP_CLOSED' using errcode = '22023';
  end if;
  if not exists (select 1 from public.stops s where s.id = p_stop_id and s.university_id = v_student.university_id and s.is_active) then
    raise exception 'STOP_INVALID' using errcode = '22023';
  end if;
  insert into public.pickup_choices (student_id, service_date, university_id, stop_id)
  values (v_student.id, v_date, v_student.university_id, p_stop_id)
  on conflict (student_id, service_date) do update set stop_id = excluded.stop_id;
  return v_date;
end;
$$;
revoke execute on function public.choose_my_pickup(uuid) from public, anon;
grant execute on function public.choose_my_pickup(uuid) to authenticated;

-- Staff: how many students wait at each stop (grouped by the stop's area) on a given day.
create or replace function public.pickup_stats(p_university_id uuid, p_date date)
returns table (area_id uuid, area_name text, stop_id uuid, stop_name text, students integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_university_staff(p_university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    select s.area_id, a.name, s.id, s.name, count(*)::int
    from public.pickup_choices pc
    join public.stops s on s.id = pc.stop_id
    left join public.areas a on a.id = s.area_id
    where pc.university_id = p_university_id and pc.service_date = p_date
    group by s.area_id, a.name, s.id, s.name
    order by count(*) desc, s.name;
end;
$$;

-- Staff: the archive — every day that has choices, newest first.
create or replace function public.pickup_days(p_university_id uuid)
returns table (service_date date, students integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.is_university_staff(p_university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    select pc.service_date, count(*)::int
    from public.pickup_choices pc
    where pc.university_id = p_university_id
    group by pc.service_date
    order by pc.service_date desc
    limit 366;
end;
$$;
