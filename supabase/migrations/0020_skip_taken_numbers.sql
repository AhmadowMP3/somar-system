-- Bug fix: a staff account had been given the login code SHB0003, the next student transport number, so
-- every new student got SHB0003, account creation failed on the taken login and the number was handed back
-- → manual creation and import failed forever. Allocation now skips any number already used as a login
-- code or a transport number. (The API also refuses staff login codes shaped like transport numbers.)
-- Re-runnable.

create or replace function private.number_taken(p_code text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.profiles where lower(login_code) = lower(p_code))
      or exists (select 1 from public.students where upper(transport_number) = upper(p_code));
$$;
revoke execute on function private.number_taken(text) from public, anon, authenticated;

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
  v_code text;
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
  loop
    update public.university_counters set last_value = last_value + 1
    where university_id = p_university_id
    returning last_value into v_next;
    v_code := v_prefix || v_separator || case when v_next < 10000 then lpad(v_next::text, 4, '0') else v_next::text end;
    exit when not private.number_taken(v_code);
  end loop;
  return v_code;
end;
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
  v_code text;
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
  perform 1 from public.member_counters where university_id = p_university_id and kind = p_kind for update;
  loop
    update public.member_counters set last_value = last_value + 1
    where university_id = p_university_id and kind = p_kind
    returning last_value into v_next;
    v_code := v_prefix || '-' || private.member_letter(p_kind)
              || case when v_next < 1000 then lpad(v_next::text, 3, '0') else v_next::text end;
    exit when not private.number_taken(v_code);
  end loop;
  return v_code;
end;
$$;

revoke execute on function public.allocate_transport_number(uuid) from public, anon, authenticated;
grant execute on function public.allocate_transport_number(uuid) to service_role;
revoke execute on function public.allocate_member_number(uuid, text) from public, anon, authenticated;
grant execute on function public.allocate_member_number(uuid, text) to service_role;
