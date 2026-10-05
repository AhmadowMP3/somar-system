-- Outbound slots are 8, 10 and 12 o'clock only (owner's correction, 2026-10-06): 10:50 and later
-- becomes 12:00, including the earlier 14:00 slot. Return slots are unchanged. The trigger from 0024
-- calls this function, so new saves follow at once; existing rows are rounded here too. Re-runnable.

create or replace function private.snap_outbound(p time)
returns time
language sql
immutable
set search_path = ''
as $$
  select case
           when p < time '09:00' then time '08:00'
           when p < time '10:50' then time '10:00'
           else time '12:00'
         end;
$$;

-- re-save every off-slot row through the trigger (it rounds both times and keeps the return after)
update public.student_schedule
set outbound_time = outbound_time
where outbound_time not in (time '08:00', time '10:00', time '12:00');
