-- Database CPU at 60% (owner's report, 2026-11-07). Every change to a table in the realtime publication is
-- decoded and permission-checked for its listeners; the audit log gets a row for almost every change in the
-- system and no screen needs it live, so it leaves the publication (0013 adds it on every apply, this removes it
-- again). The app now also listens to far fewer tables and only to each user's own rows (lib/realtime.ts).
-- Re-runnable.

do $$
begin
  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'audit_log') then
    alter publication supabase_realtime drop table public.audit_log;
  end if;
end;
$$;
