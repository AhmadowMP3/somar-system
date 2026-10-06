-- Every stop is also an area (owner's request, 2026-10-06): a stop saved without an area gets the area
-- of its name (created when missing, private.area_for_stop from 0023), so students who pick a stop are
-- always grouped by area. Existing stops without an area are linked here too. Re-runnable.

create or replace function private.stop_area_on_save()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.area_id is null then
    perform private.area_for_stop(new.id);
  end if;
  return null;
end;
$$;

-- after the row exists (area_for_stop reads and updates it); a stop given an area keeps it
drop trigger if exists stop_area_on_save on public.stops;
create trigger stop_area_on_save after insert or update of area_id, name on public.stops
  for each row when (new.area_id is null) execute function private.stop_area_on_save();

select private.area_for_stop(s.id) from public.stops s where s.area_id is null;
