# Go-live progress (connect phase)

Resume rule: on a new session read this file and continue from the first unchecked gate.

- [x] Gate 1 — Local review — approved by the owner, no changes requested (2026-09-25 23:36 UTC)
- [x] Gate 2 — Domains — both valid Let's Encrypt certs, Supabase gateway answers 401 without key (expected) (2026-09-25 23:56 UTC)
- [x] Gate 3 — Keys valid (anon/service_role, same instance, exp 2126), no leak, Postgres 15.8 reachable on the public port (2026-09-26 00:05 UTC)
- [x] Gate 4 — GoTrue: signup disabled, email on + autoconfirm, phone off; synthetic-email probe on somar.local passed and cleaned up (2026-09-26 00:15 UTC)
- [x] Gate 5 — 4 migrations applied and tracked, db:verify all PASS (18 tables with RLS, functions, indexes, empty clock, anon sees nothing) (2026-09-26 00:19 UTC)
- [ ] Gate 6 — Storage buckets + logo — buckets private, policies, round trip + public signed-URL host PASS (2026-09-26 00:19 UTC); waiting for assets/somar_logo.png
- [ ] Gate 7 — `npm run doctor`
- [ ] Gate 8 — VAPID keys
- [ ] Gate 9 — Deploy on Coolify
- [ ] Gate 10 — Admin account
- [ ] Gate 11 — Real data setup
- [ ] Gate 12 — Routes and stops
- [ ] Gate 13 — Import real students
- [ ] Gate 14 — Live field test + operations docs

## Values chosen by the owner (no secrets)

| Item | Value |
|---|---|
| Local review URL | http://localhost:8787 (8080 is used by Steam) |
| Supabase API domain | https://somar-supa.ahmad-zaven.io |
| App domain | https://somar.ahmad-zaven.io |
| Postgres access | exposed publicly on the server IP, port 5432 (owner's choice) |
| Student email domain | somar.local (probe passed; no change needed) |
