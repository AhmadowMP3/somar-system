-- Bus time slots (owner's decision, 2026-10-06): every saved schedule time is rounded on write, whatever
-- client saved it (an older app version, the staff editor, a script). Same rules as
-- packages/shared/src/schedule.ts: outbound 8 / 10 / 12 / 14, return 11:30 / 14 / 15:30 / 16, and a
-- return not after the outbound moves to the next return slot. Re-runnable.

create or replace function private.snap_outbound(p time)
returns time
language sql
immutable
set search_path = ''
as $$
  select case
           when p < time '09:00' then time '08:00'
           when p < time '10:50' then time '10:00'
           when p < time '13:00' then time '12:00'
           else time '14:00'
         end;
$$;

create or replace function private.snap_return(p time)
returns time
language sql
immutable
set search_path = ''
as $$
  select case
           when p <= time '11:30' then time '11:30'
           when p <= time '14:00' then time '14:00'
           when p <= time '15:30' then time '15:30'
           else time '16:00'
         end;
$$;

create or replace function private.snap_schedule_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.outbound_time := private.snap_outbound(new.outbound_time);
  new.return_time := private.snap_return(new.return_time);
  if new.return_time <= new.outbound_time then
    new.return_time := coalesce(
      (select s from unnest(array[time '11:30', time '14:00', time '15:30', time '16:00']) s
       where s > new.outbound_time order by s limit 1),
      time '16:00');
  end if;
  return new;
end;
$$;

-- before the table's check (return after outbound) is evaluated
drop trigger if exists snap_schedule_row on public.student_schedule;
create trigger snap_schedule_row before insert or update of outbound_time, return_time on public.student_schedule
  for each row execute function private.snap_schedule_row();
