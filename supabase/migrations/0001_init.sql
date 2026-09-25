-- 0001_init.sql — core schema. Re-runnable.

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Test clock: empty in production. Integration tests insert a frozen instant here.
create table if not exists private.test_clock (
  id smallint primary key default 1 check (id = 1),
  frozen_at timestamptz not null
);

create or replace function public.app_now()
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select frozen_at from private.test_clock where id = 1), now());
$$;

create or replace function public.damascus_date(ts timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (ts at time zone 'Asia/Damascus')::date;
$$;

create or replace function public.damascus_today()
returns date
language sql
stable
set search_path = ''
as $$
  select public.damascus_date(public.app_now());
$$;

-- week_start(d, dow) = most recent date <= d whose ISO weekday = dow
create or replace function public.week_start(d date, dow smallint)
returns date
language sql
immutable
set search_path = ''
as $$
  select d - ((extract(isodow from d)::int - dow + 7) % 7);
$$;

-- ---------------------------------------------------------------- organization

create table if not exists public.universities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  logo_path text,
  transport_prefix text not null unique check (transport_prefix ~ '^[A-Z0-9]{1,10}$'),
  week_start_dow smallint not null default 6 check (week_start_dow between 1 and 7),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.university_counters (
  university_id uuid primary key references public.universities(id) on delete cascade,
  last_value integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.colleges (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (university_id, name)
);

create table if not exists public.areas (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (university_id, name)
);

create table if not exists public.packages (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  name text not null,
  trips_per_week smallint not null check (trips_per_week > 0),
  price numeric(12, 2),
  semester_start date not null,
  semester_end date not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (semester_end >= semester_start)
);

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  name text not null,
  direction text not null default 'both' check (direction in ('outbound', 'return', 'both')),
  departure_time time,
  active_days smallint[],
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  seq integer not null,
  name text not null,
  area_id uuid references public.areas(id) on delete set null,
  maps_url text,
  lat numeric,
  lng numeric,
  departure_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists route_stops_route_idx on public.route_stops (route_id, seq);

-- ---------------------------------------------------------------- identity

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login_code text not null unique,
  role text not null check (role in ('admin', 'university_supervisor', 'supervisor', 'student')),
  university_id uuid references public.universities(id) on delete cascade,
  full_name text not null,
  phone text,
  is_active boolean not null default true,
  must_change_password boolean not null default true,
  password_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (role = 'admin' or university_id is not null)
);
create unique index if not exists profiles_login_code_lower_idx on public.profiles (lower(login_code));

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid unique references public.profiles(id) on delete cascade,
  university_id uuid not null references public.universities(id) on delete cascade,
  college_id uuid not null references public.colleges(id),
  transport_number text not null unique,
  qr_token uuid not null unique default gen_random_uuid(),
  full_name text not null,
  university_student_no text not null check (university_student_no ~ '^[0-9]+$'),
  phone_e164 text not null,
  residence_text text,
  area_primary_id uuid references public.areas(id) on delete set null,
  area_secondary_id uuid references public.areas(id) on delete set null,
  area_other_text text,
  needs_area_mapping boolean generated always as (area_primary_id is null and area_other_text is not null) stored,
  work_days smallint[] not null check (cardinality(work_days) > 0 and work_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  shift_start time not null,
  photo_path text,
  photo_uploaded_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (university_id, university_student_no)
);
create index if not exists students_university_idx on public.students (university_id);
create index if not exists students_college_idx on public.students (college_id);

-- ---------------------------------------------------------------- subscriptions

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  package_id uuid not null references public.packages(id),
  trips_per_week smallint not null check (trips_per_week >= 0),
  starts_on date not null,
  ends_on date not null,
  status text not null default 'active' check (status in ('active', 'cancelled', 'expired')),
  assigned_by uuid references public.profiles(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create unique index if not exists subscriptions_one_active_idx on public.subscriptions (student_id) where status = 'active';
create index if not exists subscriptions_package_idx on public.subscriptions (package_id, status);

create table if not exists public.subscription_adjustments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  week_start date,
  delta_trips smallint not null check (delta_trips <> 0),
  reason text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists subscription_adjustments_sub_idx on public.subscription_adjustments (subscription_id);

-- ---------------------------------------------------------------- scans

create table if not exists public.scans (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students(id) on delete cascade,
  university_id uuid not null references public.universities(id) on delete cascade,
  supervisor_id uuid references public.profiles(id) on delete set null,
  scanned_at timestamptz not null default now(),
  service_date date not null,
  week_start date not null,
  direction text not null check (direction in ('outbound', 'return')),
  method text not null check (method in ('qr', 'manual')),
  lat numeric,
  lng numeric,
  accuracy_m numeric,
  geo_denied boolean not null default false,
  offday_override boolean not null default false,
  override_reason text,
  remaining_after smallint not null,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists scans_student_day_idx on public.scans (student_id, service_date);
create index if not exists scans_service_date_idx on public.scans (service_date);
create index if not exists scans_supervisor_idx on public.scans (supervisor_id, scanned_at);
create index if not exists scans_university_day_idx on public.scans (university_id, service_date);
create unique index if not exists scans_one_direction_per_day_idx
  on public.scans (student_id, service_date, direction) where cancelled_at is null;

-- ---------------------------------------------------------------- settings

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  university_id uuid references public.universities(id) on delete cascade,
  scan_cooldown_minutes integer not null default 5 check (scan_cooldown_minutes >= 0),
  allow_offday_override boolean not null default false,
  require_supervisor_geo boolean not null default true,
  low_balance_threshold smallint not null default 2 check (low_balance_threshold >= 0),
  expiry_warning_days smallint not null default 7 check (expiry_warning_days >= 0),
  daily_job_hour smallint not null default 9 check (daily_job_hour between 0 and 23),
  max_photo_mb smallint not null default 5 check (max_photo_mb between 1 and 50),
  password_min_length smallint not null default 8 check (password_min_length between 6 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists settings_scope_idx
  on public.settings (coalesce(university_id, '00000000-0000-0000-0000-000000000000'::uuid));
insert into public.settings (university_id)
select null
where not exists (select 1 from public.settings where university_id is null);

-- ---------------------------------------------------------------- notifications

create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  title text not null,
  body text not null,
  audience jsonb not null,
  recipients integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  student_id uuid references public.students(id) on delete cascade,
  audience jsonb not null default '{}'::jsonb,
  type text not null check (type in ('LOW_BALANCE', 'SUBSCRIPTION_EXPIRING', 'SCHEDULE_CHANGED', 'BROADCAST',
                                      'LOW_BALANCE_DIGEST', 'EXPIRING_DIGEST')),
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  service_date date,
  push_sent_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notifications_student_idx on public.notifications (student_id, created_at desc);
create index if not exists notifications_push_pending_idx on public.notifications (created_at) where push_sent_at is null;
create unique index if not exists notifications_student_daily_idx
  on public.notifications (student_id, type, service_date) where student_id is not null and service_date is not null;
create unique index if not exists notifications_staff_daily_idx
  on public.notifications (university_id, type, service_date) where student_id is null and service_date is not null;

create table if not exists public.notification_reads (
  notification_id uuid not null references public.notifications(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, profile_id)
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  last_success_at timestamptz,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_profile_idx on public.push_subscriptions (profile_id);

-- ---------------------------------------------------------------- audit

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid,
  university_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity, entity_id);

-- ---------------------------------------------------------------- updated_at triggers

do $$
declare
  t text;
begin
  foreach t in array array['universities', 'university_counters', 'colleges', 'areas', 'packages', 'routes',
                           'route_stops', 'profiles', 'students', 'subscriptions', 'subscription_adjustments',
                           'scans', 'settings', 'broadcasts', 'notifications', 'push_subscriptions']
  loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format('create trigger set_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t);
  end loop;
end;
$$;
