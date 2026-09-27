-- Deleting stops from the library (owner's request). A stop used in routes is removed from them
-- after confirmation; students' past pickup choices keep the stop's name, so the archive of
-- «أين سيقفون غداً» stays complete after the stop is gone.

-- name snapshots on pickup choices, filled from the library on every write
alter table public.pickup_choices
  add column if not exists stop_name text,
  add column if not exists return_stop_name text;
update public.pickup_choices pc set stop_name = s.name from public.stops s where s.id = pc.stop_id and pc.stop_name is null;
update public.pickup_choices pc set return_stop_name = s.name from public.stops s where s.id = pc.return_stop_id and pc.return_stop_name is null;

create or replace function private.pickup_stop_names()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- keep the saved name when the stop is not found (it is being deleted right now)
  new.stop_name := coalesce((select s.name from public.stops s where s.id = new.stop_id), new.stop_name);
  new.return_stop_name := coalesce((select s.name from public.stops s where s.id = new.return_stop_id), new.return_stop_name);
  return new;
end;
$$;
drop trigger if exists pickup_stop_names on public.pickup_choices;
create trigger pickup_stop_names before insert or update of stop_id, return_stop_id on public.pickup_choices
  for each row execute function private.pickup_stop_names();

-- a deleted stop leaves the choice in place (with its name), pointing nowhere
alter table public.pickup_choices alter column stop_id drop not null;
alter table public.pickup_choices drop constraint if exists pickup_choices_stop_id_fkey;
alter table public.pickup_choices add constraint pickup_choices_stop_id_fkey
  foreign key (stop_id) references public.stops(id) on delete set null;
alter table public.pickup_choices drop constraint if exists pickup_choices_return_stop_id_fkey;
alter table public.pickup_choices add constraint pickup_choices_return_stop_id_fkey
  foreign key (return_stop_id) references public.stops(id) on delete set null;

-- statistics read the snapshot when the stop no longer exists
create or replace function public.pickup_stats(p_university_id uuid, p_date date)
returns table (area_id uuid, area_name text, stop_id uuid, stop_name text, students integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.staff_can(p_university_id, 'pickups') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    select s.area_id, a.name, pc.stop_id, coalesce(s.name, pc.stop_name), count(*)::int
    from public.pickup_choices pc
    left join public.stops s on s.id = pc.stop_id
    left join public.areas a on a.id = s.area_id
    where pc.university_id = p_university_id and pc.service_date = p_date
    group by s.area_id, a.name, pc.stop_id, coalesce(s.name, pc.stop_name)
    order by count(*) desc, 4;
end;
$$;

create or replace function public.pickup_return_stats(p_university_id uuid, p_date date)
returns table (return_time time, area_id uuid, area_name text, stop_id uuid, stop_name text, students integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.staff_can(p_university_id, 'pickups') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return query
    select pc.return_time, s.area_id, a.name, pc.return_stop_id, coalesce(s.name, pc.return_stop_name), count(*)::int
    from public.pickup_choices pc
    left join public.stops s on s.id = pc.return_stop_id
    left join public.areas a on a.id = s.area_id
    where pc.university_id = p_university_id and pc.service_date = p_date and pc.return_time is not null
    group by pc.return_time, s.area_id, a.name, pc.return_stop_id, coalesce(s.name, pc.return_stop_name)
    order by pc.return_time, count(*) desc, 5;
end;
$$;

-- Delete a stop. Used in routes → nothing happens and the routes are returned, unless the caller
-- confirmed with p_remove_from_routes, which takes it out of those routes first.
create or replace function public.delete_stop(p_stop_id uuid, p_remove_from_routes boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stop public.stops%rowtype;
  v_routes text[];
begin
  select * into v_stop from public.stops where id = p_stop_id;
  if v_stop.id is null then
    raise exception 'NOT_FOUND' using errcode = '22023';
  end if;
  if not public.staff_can(v_stop.university_id, 'routes') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select array_agg(distinct r.name order by r.name) into v_routes
  from public.route_stops rs join public.routes r on r.id = rs.route_id
  where rs.stop_id = p_stop_id;
  if v_routes is not null and not p_remove_from_routes then
    return jsonb_build_object('deleted', false, 'routes', to_jsonb(v_routes));
  end if;

  delete from public.route_stops where stop_id = p_stop_id;
  delete from public.stops where id = p_stop_id;
  perform private.write_audit('stop.delete', 'stops', p_stop_id,
                              to_jsonb(v_stop) || jsonb_build_object('routes', coalesce(to_jsonb(v_routes), '[]'::jsonb)),
                              null, v_stop.university_id);
  return jsonb_build_object('deleted', true, 'routes', coalesce(to_jsonb(v_routes), '[]'::jsonb));
end;
$$;
revoke execute on function public.delete_stop(uuid, boolean) from public, anon;
grant execute on function public.delete_stop(uuid, boolean) to authenticated;
