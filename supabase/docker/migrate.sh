#!/bin/sh
# Waits for the auth + storage schemas (created by those services), then applies the app migrations.
set -e
export PGPASSWORD="$POSTGRES_PASSWORD"
until psql -h db -U postgres -d postgres -tAc "select 1 from storage.buckets limit 1; select 1 from auth.users limit 1;" >/dev/null 2>&1; do
  echo "waiting for auth/storage schemas..."; sleep 2
done
for f in /migrations/*.sql; do
  echo "applying $f"
  psql -v ON_ERROR_STOP=1 -h db -U postgres -d postgres -q -f "$f"
done
psql -h db -U postgres -d postgres -c "notify pgrst, 'reload schema'"
echo "migrations applied"
