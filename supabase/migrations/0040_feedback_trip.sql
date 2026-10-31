-- A complaint names the trip it is about (owner's request, 2026-11-01): outbound or return, the bus time
-- (the system's slots) and the line, picked from the registered lines of that direction and time. The line's
-- name is kept with the complaint so it still reads right after the line is renamed or deleted. Notes do not
-- ask for it. The API checks the choice. Re-runnable.

alter table public.feedback
  add column if not exists trip_direction text check (trip_direction in ('outbound', 'return')),
  add column if not exists trip_time time,
  add column if not exists route_id uuid references public.routes(id) on delete set null,
  add column if not exists route_name text;
