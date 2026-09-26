-- 0006_stop_library.sql — a per-university library of stops; routes reference them. Re-runnable.

create table if not exists public.stops (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  name text not null,
  area_id uuid references public.areas(id) on delete set null,
  maps_url text,
  lat numeric,
  lng numeric,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (university_id, name)
);

drop trigger if exists set_updated_at on public.stops;
create trigger set_updated_at before update on public.stops
  for each row execute function public.set_updated_at();

alter table public.stops enable row level security;
drop policy if exists stops_select on public.stops;
create policy stops_select on public.stops for select to authenticated
  using (public.is_admin() or university_id = public.current_university_id());
drop policy if exists stops_write on public.stops;
create policy stops_write on public.stops for all to authenticated
  using (public.is_university_staff(university_id))
  with check (public.is_university_staff(university_id));

-- route_stops now points at the library; name/maps_url/lat/lng on route_stops are legacy (kept nullable).
alter table public.route_stops add column if not exists stop_id uuid references public.stops(id) on delete restrict;
alter table public.route_stops alter column name drop not null;

-- Backfill: every legacy route stop becomes (or reuses) a library stop with the same name.
insert into public.stops (university_id, name, area_id, maps_url, lat, lng)
select distinct on (r.university_id, rs.name) r.university_id, rs.name, rs.area_id, rs.maps_url, rs.lat, rs.lng
from public.route_stops rs join public.routes r on r.id = rs.route_id
where rs.stop_id is null and rs.name is not null
order by r.university_id, rs.name, rs.created_at
on conflict (university_id, name) do nothing;

update public.route_stops rs set stop_id = s.id
from public.routes r, public.stops s
where r.id = rs.route_id and s.university_id = r.university_id and s.name = rs.name and rs.stop_id is null;

create unique index if not exists route_stops_route_stop_idx on public.route_stops (route_id, stop_id) where stop_id is not null;

-- Schedule-change notification: take the stop name from the library.
create or replace function private.on_route_time_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_route public.routes%rowtype;
  v_stop_name text;
begin
  if new.departure_time is not distinct from old.departure_time or new.departure_time is null then
    return new;
  end if;
  if tg_table_name = 'routes' then
    perform private.notify_schedule_change(
      new.university_id,
      'تم تغيير موعد انطلاق خط «' || new.name || '» إلى ' || to_char(new.departure_time, 'HH24:MI'),
      jsonb_build_object('route_id', new.id, 'departure_time', to_char(new.departure_time, 'HH24:MI')));
    perform private.write_audit('route.time_change', 'routes', new.id,
                                jsonb_build_object('departure_time', old.departure_time),
                                jsonb_build_object('departure_time', new.departure_time), new.university_id);
  else
    select * into v_route from public.routes where id = new.route_id;
    select s.name into v_stop_name from public.stops s where s.id = new.stop_id;
    v_stop_name := coalesce(v_stop_name, new.name, '');
    perform private.notify_schedule_change(
      v_route.university_id,
      'تم تغيير موعد نقطة «' || v_stop_name || '» على خط «' || v_route.name || '» إلى ' || to_char(new.departure_time, 'HH24:MI'),
      jsonb_build_object('route_id', v_route.id, 'stop_id', new.stop_id, 'departure_time', to_char(new.departure_time, 'HH24:MI')));
    perform private.write_audit('route.time_change', 'route_stops', new.id,
                                jsonb_build_object('departure_time', old.departure_time),
                                jsonb_build_object('departure_time', new.departure_time), v_route.university_id);
  end if;
  return new;
end;
$$;
