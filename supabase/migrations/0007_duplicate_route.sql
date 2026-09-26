-- 0007_duplicate_route.sql — copy a route with its stops in one transaction. Re-runnable.

create or replace function public.duplicate_route(p_route_id uuid, p_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_route public.routes%rowtype;
  v_new uuid;
  v_name text;
begin
  select * into v_route from public.routes where id = p_route_id;
  if v_route.id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.is_university_staff(v_route.university_id) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  v_name := coalesce(nullif(btrim(coalesce(p_name, '')), ''), v_route.name || ' (نسخة)');

  insert into public.routes (university_id, name, direction, departure_time, active_days, notes, is_active)
  values (v_route.university_id, v_name, v_route.direction, v_route.departure_time, v_route.active_days,
          v_route.notes, v_route.is_active)
  returning id into v_new;

  insert into public.route_stops (route_id, seq, stop_id, name, area_id, maps_url, lat, lng, departure_time)
  select v_new, rs.seq, rs.stop_id, rs.name, rs.area_id, rs.maps_url, rs.lat, rs.lng, rs.departure_time
  from public.route_stops rs
  where rs.route_id = p_route_id;

  perform private.write_audit('route.duplicate', 'routes', v_new, jsonb_build_object('source', p_route_id),
                              jsonb_build_object('name', v_name), v_route.university_id);
  return v_new;
end;
$$;

revoke execute on function public.duplicate_route(uuid, text) from public, anon;
grant execute on function public.duplicate_route(uuid, text) to authenticated, service_role;
