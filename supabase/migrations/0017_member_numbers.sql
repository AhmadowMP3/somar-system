-- Doctors and university employees get their own transport-number series so they never look like a
-- student's number: SHB-D001, SHB-D002, … for doctors and SHB-E001, … for employees (owner's choice:
-- always with a dash, three digits, more digits after 999). Re-runnable.

create table if not exists public.member_counters (
  university_id uuid not null references public.universities(id) on delete cascade,
  kind text not null check (kind in ('doctor', 'employee')),
  last_value integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (university_id, kind)
);
alter table public.member_counters enable row level security;
revoke all on public.member_counters from anon, authenticated;

drop trigger if exists set_updated_at on public.member_counters;
create trigger set_updated_at before update on public.member_counters
  for each row execute function public.set_updated_at();

create or replace function private.member_letter(p_kind text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_kind when 'doctor' then 'D' when 'employee' then 'E' end;
$$;

create or replace function public.allocate_member_number(p_university_id uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_next integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if private.member_letter(p_kind) is null then
    raise exception 'VALIDATION' using errcode = '22023';
  end if;
  select transport_prefix into v_prefix from public.universities where id = p_university_id;
  if v_prefix is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.member_counters (university_id, kind) values (p_university_id, p_kind) on conflict do nothing;
  update public.member_counters set last_value = last_value + 1
  where university_id = p_university_id and kind = p_kind
  returning last_value into v_next;
  return v_prefix || '-' || private.member_letter(p_kind)
         || case when v_next < 1000 then lpad(v_next::text, 3, '0') else v_next::text end;
end;
$$;

-- Give a number back only if it is still the latest of its series (no gap after a failed provisioning).
create or replace function public.release_member_number(p_university_id uuid, p_kind text, p_transport_number text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_head text;
  v_rest text;
  v_n integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select transport_prefix || '-' || private.member_letter(p_kind) into v_head
  from public.universities where id = p_university_id;
  if v_head is null or left(p_transport_number, length(v_head)) <> v_head then
    return false;
  end if;
  v_rest := substr(p_transport_number, length(v_head) + 1);
  if v_rest !~ '^\d+$' then
    return false;
  end if;
  update public.member_counters set last_value = last_value - 1
  where university_id = p_university_id and kind = p_kind and last_value = v_rest::int
    and not exists (select 1 from public.students where transport_number = p_transport_number);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke execute on function public.allocate_member_number(uuid, text) from public, anon, authenticated;
grant execute on function public.allocate_member_number(uuid, text) to service_role;
revoke execute on function public.release_member_number(uuid, text, text) from public, anon, authenticated;
grant execute on function public.release_member_number(uuid, text, text) to service_role;
