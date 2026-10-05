-- Students often name a library stop (e.g. «دوار السياسية») as their area, but areas and stops are
-- separate lists, so those students landed in «مناطق بحاجة ربط» and the linking list had no such entry.
-- A stop can now be the target: it gets an area of the same name (created when missing, and linked to
-- the stop), and exact name matches can be linked in one click. Re-runnable.

-- Comparison key, same folding as the app (foldArabic) plus spaces and punctuation removed.
create or replace function private.name_key(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
           lower(translate(regexp_replace(coalesce(p, ''), '[ـً-ْٰ]', '', 'g'), 'أإآٱىةؤئ٠١٢٣٤٥٦٧٨٩', 'اااايهوي0123456789')),
           '[[:space:][:punct:]]', '', 'g');
$$;

-- The area standing for a stop: the stop's own area when it has one, else an area with the stop's name
-- (created when missing), which then becomes the stop's area.
create or replace function private.area_for_stop(p_stop_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stop public.stops%rowtype;
  v_area uuid;
begin
  select * into v_stop from public.stops where id = p_stop_id;
  if v_stop.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stop.area_id is not null then
    return v_stop.area_id;
  end if;
  select a.id into v_area from public.areas a
  where a.university_id = v_stop.university_id and private.name_key(a.name) = private.name_key(v_stop.name)
  order by a.is_active desc, a.created_at limit 1;
  if v_area is null then
    insert into public.areas (university_id, name) values (v_stop.university_id, btrim(v_stop.name))
    on conflict (university_id, name) do update set is_active = true
    returning id into v_area;
  end if;
  update public.stops set area_id = v_area where id = p_stop_id and area_id is null;
  return v_area;
end;
$$;
revoke execute on function private.area_for_stop(uuid) from public, anon, authenticated;

-- Import (service role): the areas for the given stops, created when missing.
create or replace function public.ensure_stop_areas(p_university_id uuid, p_stop_ids uuid[])
returns table (stop_id uuid, area_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_trusted() and not (public.staff_can(p_university_id, 'import') or public.staff_can(p_university_id, 'org')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    select s.id, private.area_for_stop(s.id)
    from public.stops s
    where s.university_id = p_university_id and s.id = any (p_stop_ids);
end;
$$;
revoke execute on function public.ensure_stop_areas(uuid, uuid[]) from public, anon;
grant execute on function public.ensure_stop_areas(uuid, uuid[]) to authenticated;

-- «مناطق بحاجة ربط»: link a written place to a library stop.
create or replace function public.map_area_other_text_to_stop(p_university_id uuid, p_other_text text, p_stop_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_area uuid;
begin
  if not (public.staff_can(p_university_id, 'org') or public.staff_can(p_university_id, 'import')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if not exists (select 1 from public.stops where id = p_stop_id and university_id = p_university_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_area := private.area_for_stop(p_stop_id);
  return public.map_area_other_text(p_university_id, p_other_text, v_area);
end;
$$;
revoke execute on function public.map_area_other_text_to_stop(uuid, text, uuid) from public, anon;
grant execute on function public.map_area_other_text_to_stop(uuid, text, uuid) to authenticated;

-- One click: every written place whose name equals an area's or a stop's (spelling variants and spaces
-- ignored) is linked. Returns how many places and students were linked.
create or replace function public.auto_map_area_texts(p_university_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_area uuid;
  v_stop uuid;
  v_places integer := 0;
  v_students integer := 0;
begin
  if not (public.staff_can(p_university_id, 'org') or public.staff_can(p_university_id, 'import')) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  for r in
    select distinct s.area_other_text as txt from public.students s
    where s.university_id = p_university_id and s.needs_area_mapping
  loop
    v_area := null;
    v_stop := null;
    select a.id into v_area from public.areas a
    where a.university_id = p_university_id and a.is_active and private.name_key(a.name) = private.name_key(r.txt)
    limit 1;
    if v_area is null then
      select st.id into v_stop from public.stops st
      where st.university_id = p_university_id and st.is_active and private.name_key(st.name) = private.name_key(r.txt)
      limit 1;
      if v_stop is not null then
        v_area := private.area_for_stop(v_stop);
      end if;
    end if;
    continue when v_area is null;
    v_places := v_places + 1;
    v_students := v_students + public.map_area_other_text(p_university_id, r.txt, v_area);
  end loop;
  return jsonb_build_object('places', v_places, 'students', v_students);
end;
$$;
revoke execute on function public.auto_map_area_texts(uuid) from public, anon;
grant execute on function public.auto_map_area_texts(uuid) to authenticated;
