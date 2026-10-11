-- Stop order (owner's request, 2026-10-11): staff arrange the stop library from «نقاط الوقوف» and
-- students see that order in «احجز مقعدك غداً» (and the first-login stop question).
-- Existing stops start in name order; a new stop goes to the end. Re-runnable.

alter table public.stops add column if not exists sort_order integer;

-- only stops that never had an order: a re-run keeps what staff arranged
with numbered as (
  select s.id,
         coalesce((select max(x.sort_order) from public.stops x where x.university_id = s.university_id), 0)
           + row_number() over (partition by s.university_id order by s.name) as n
  from public.stops s
  where s.sort_order is null
)
update public.stops s set sort_order = numbered.n from numbered where numbered.id = s.id;

create index if not exists stops_order_idx on public.stops (university_id, sort_order);

create or replace function private.stop_default_order()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sort_order is null then
    new.sort_order := coalesce((select max(s.sort_order) from public.stops s where s.university_id = new.university_id), 0) + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists stop_default_order on public.stops;
create trigger stop_default_order before insert on public.stops
  for each row execute function private.stop_default_order();

-- The whole new order in one call: p_ids lists the university's stops top to bottom. Stops left out
-- (e.g. added meanwhile in another tab) keep their relative order after the listed ones.
create or replace function public.reorder_stops(p_university_id uuid, p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.staff_can(p_university_id, 'routes') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  with wanted as (
    select s.id,
           row_number() over (order by coalesce(o.pos, 2147483647), s.sort_order, s.name) as n
    from public.stops s
    left join unnest(p_ids) with ordinality as o(id, pos) on o.id = s.id
    where s.university_id = p_university_id
  )
  update public.stops s set sort_order = wanted.n
  from wanted
  where wanted.id = s.id and s.sort_order is distinct from wanted.n;
end;
$$;
revoke execute on function public.reorder_stops(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_stops(uuid, uuid[]) to authenticated;
