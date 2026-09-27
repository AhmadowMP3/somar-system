-- 0008_release_number_fix.sql — read the sequence after the university's own prefix + separator
-- (trailing-digit parsing was wrong for prefixes ending in a digit, e.g. 'TA1' + '' + '0002'). Re-runnable.

create or replace function public.release_transport_number(p_university_id uuid, p_transport_number text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_separator text;
  v_rest text;
  v_seq integer;
  v_n integer;
begin
  if not private.is_trusted() then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select transport_prefix, transport_separator into v_prefix, v_separator
  from public.universities where id = p_university_id;
  if v_prefix is null or left(p_transport_number, length(v_prefix) + length(v_separator)) <> v_prefix || v_separator then
    return false;
  end if;
  v_rest := substr(p_transport_number, length(v_prefix) + length(v_separator) + 1);
  if v_rest !~ '^\d+$' then
    return false;
  end if;
  v_seq := v_rest::int;
  update public.university_counters set last_value = last_value - 1
  where university_id = p_university_id and last_value = v_seq
    and not exists (select 1 from public.students where transport_number = p_transport_number);
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

revoke execute on function public.release_transport_number(uuid, text) from public, anon, authenticated;
grant execute on function public.release_transport_number(uuid, text) to service_role;
