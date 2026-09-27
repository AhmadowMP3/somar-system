-- Map view of routes (owner's request): the road path through a route's stops, computed by the API
-- with a routing service (OSRM) and cached here, so phones never call the routing service themselves.
-- The cache is keyed by a hash of the stops' coordinates in order: any change to the stops recomputes it.

create table if not exists public.route_paths (
  route_id uuid primary key references public.routes(id) on delete cascade,
  university_id uuid not null references public.universities(id) on delete cascade,
  coords_hash text not null,
  points jsonb not null,                                   -- [[lat, lng], …] along the road
  source text not null check (source in ('road', 'straight')), -- straight = routing unavailable, lines between stops
  computed_at timestamptz not null default now()
);

alter table public.route_paths enable row level security;
drop policy if exists route_paths_select on public.route_paths;
create policy route_paths_select on public.route_paths for select to authenticated
  using (public.is_admin() or university_id = public.current_university_id());
-- no write policies: only the API (service role) writes the cache.
