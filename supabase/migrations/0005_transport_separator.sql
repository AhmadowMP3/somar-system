-- 0005_transport_separator.sql — per-university separator between prefix and sequence
-- ('-' → SHB-0001, '' → SHB0001). Re-runnable.

alter table public.universities add column if not exists transport_separator text not null default '-';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'universities_transport_separator_check') then
    alter table public.universities
      add constraint universities_transport_separator_check check (transport_separator in ('-', ''));
  end if;
end;
$$;

create or replace function public.allocate_transport_number(p_university_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_separator text;
  v_next integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select transport_prefix, transport_separator into v_prefix, v_separator
  from public.universities where id = p_university_id;
  if v_prefix is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.university_counters (university_id) values (p_university_id) on conflict do nothing;
  perform 1 from public.university_counters where university_id = p_university_id for update;
  update public.university_counters set last_value = last_value + 1
  where university_id = p_university_id
  returning last_value into v_next;
  return v_prefix || v_separator || case when v_next < 10000 then lpad(v_next::text, 4, '0') else v_next::text end;
end;
$$;

-- The sequence is the trailing digits, whatever the separator.
create or replace function public.release_transport_number(p_university_id uuid, p_transport_number text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq integer := nullif(substring(p_transport_number from '(\d+)$'), '')::int;
  v_n integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  update public.university_counters set last_value = last_value - 1
  where university_id = p_university_id and last_value = v_seq
    and not exists (select 1 from public.students where transport_number = p_transport_number);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke execute on function public.allocate_transport_number(uuid) from public, anon, authenticated;
grant execute on function public.allocate_transport_number(uuid) to service_role;
revoke execute on function public.release_transport_number(uuid, text) from public, anon, authenticated;
grant execute on function public.release_transport_number(uuid, text) to service_role;
