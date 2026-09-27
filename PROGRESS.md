# Go-live progress (connect phase)

Resume rule: on a new session read this file and continue from the first unchecked gate.

- [x] Gate 1 — Local review — approved by the owner, no changes requested (2026-09-25 23:36 UTC)
- [x] Gate 2 — Domains — both valid Let's Encrypt certs, Supabase gateway answers 401 without key (expected) (2026-09-25 23:56 UTC)
- [x] Gate 3 — Keys valid (anon/service_role, same instance, exp 2126), no leak, Postgres 15.8 reachable on the public port (2026-09-26 00:05 UTC)
- [x] Gate 4 — GoTrue: signup disabled, email on + autoconfirm, phone off; synthetic-email probe on somar.local passed and cleaned up (2026-09-26 00:15 UTC)
- [x] Gate 5 — 4 migrations applied and tracked, db:verify all PASS (18 tables with RLS, functions, indexes, empty clock, anon sees nothing) (2026-09-26 00:19 UTC)
- [x] Gate 6 — Buckets private + policies + round trip (public signed-URL host); brand logo installed (login, header, card, PWA icons, favicon) (2026-09-26 00:27 UTC)
- [x] Gate 7 — doctor built; production: 42 PASS, expected FAILs only (#10 upload, #12 VAPID, #13 app config → fixed by gates 8–9) in 12.5 s (2026-09-26 00:31 UTC)
- [x] Gate 8 — VAPID pair generated into .env.production (public BOL…kdvG8Q), doctor #12 PASS (2026-09-26 00:33 UTC); VAPID_SUBJECT email to confirm
- [x] Gate 9 — App live on node:22-slim: healthz ok/db up, __APP_CONFIG__ injected, VITE_* baked into the bundle, 10 MB upload through Traefik OK, doctor 48 PASS / 0 FAIL (2026-09-26 09:56 UTC)
- [x] Gate 10 — Admin "Sajed" created (idempotent re-run), headless login on the live domain renders the dashboard with 0 console errors (2026-09-26 10:01 UTC)
- [x] Gate 11 — Demo guard verified on production; migration 0005 (no-dash numbers) applied; university onboarded: 3 colleges, 39 areas, 3 packages (2026-09-26 10:20 UTC)
- [ ] Gate 12 — Routes and stops — owner enters them in the UI; stop library added on request (migration 0006 applied to production); first-login setup + schedule stats + collapsible route cards added (migration 0009 — pending on production)
- [ ] Gate 13 — Import real students — CLI built and tested (dry-run / commit / idempotent re-run); waiting for the real file at assets/students.xlsx and for routes to be finished
- [ ] Gate 14 — Live field test + operations docs

## Values chosen by the owner (no secrets)

| Item | Value |
|---|---|
| Local review URL | http://localhost:8787 (8080 is used by Steam) |
| Supabase API domain | https://somar-supa.ahmad-zaven.io |
| App domain | https://somar.ahmad-zaven.io |
| Postgres access | exposed publicly on the server IP, port 5432 (owner's choice) |
| Student email domain | somar.local (probe passed; no change needed) |
| Admin login code | Sajed |
| University | جامعة الشهباء الخاصة |
| Transport numbers | SHB0001, SHB0002, … (no dash) |
| Week start | Friday (ISO 5) |
| Semester | 2026-10-03 → 2027-02-06 |
| Packages | باقة يومين بالاسبوع: 2 trips, 125 $ · باقة 3 ايام بالاسبوع: 3 trips, 175 $ · باقة 5 ايام بالاسبوع: 5 trips, 205 $ (no 4- or 6-day package — owner's choice) |
| University logo | not set (only the Somar logo exists; the Al-Shahba logo can be uploaded from «الجامعات») |
