# Decisions and assumptions

One line per decision where the brief was silent, ambiguous or technically constrained.

1. **PDF generation**: cards are printed by the browser (`Print → Save as PDF`) from a dedicated print route with exact `mm` CSS; no pdf-lib/Puppeteer, because Arabic shaping/bidi in pdf-lib is unreliable and Chromium would add ~400 MB to the image.
2. **Role helper names**: `current_role()` collides with the SQL keyword `CURRENT_ROLE`, so the helpers are `current_user_role()`, `current_university_id()`, `is_admin()` (+ `is_university_staff(uuid)`, `current_student_id()`), all `security definer`, `stable`, `search_path=''`.
3. **Test clock**: SQL business time comes from `app_now()`, which reads a one-row `private.test_clock` table (empty in production, not reachable through the Data API); integration tests freeze time by writing that row.
4. **Scan endpoint**: the SPA calls `POST /api/scan`, which executes `perform_scan()` **as the supervisor** (user JWT) and then adds a 60-minute signed photo URL with the service key; the SQL function stays the single source of truth and returns `photo_path`.
5. **Notification fan-out**: every student-targeted notification (broadcast, schedule change, low balance, expiring) is stored as one row per student (`student_id` set); rows with `student_id = null` are staff digests for admins/general supervisors. Broadcast history lives in a `broadcasts` table.
6. **Push delivery**: a single dispatcher sends web push for any `notifications` row with `push_sent_at is null` (created in the last 24 h), running every minute and right after a broadcast — this covers rows created by SQL triggers too.
7. **Daily job scheduling**: `node-cron` runs hourly; `run_daily_jobs()` evaluates each university once its `daily_job_hour` (Damascus) has passed and is idempotent per `(student, type, service_date)` and per `(university, digest, service_date)`; it also expires subscriptions past `ends_on`.
8. **Expired vs. missing subscription**: `SUBSCRIPTION_EXPIRED` when the active subscription is past `ends_on` or the student only has `expired` subscriptions; `NO_ACTIVE_SUBSCRIPTION` otherwise (none, cancelled, or not started yet).
9. **Balance source**: the balance uses the non-cancelled subscription covering the date (preferring `active`); a subscription starting mid-week gets the full weekly quota for that week.
10. **Cancel scan permission**: §5 says admin only, the role table says general supervisors can do everything except packages; `cancel_scan` allows admins and the general supervisor of that university.
11. **Promotion/creation of supervisors**: admin only (§4.1, §7.2); general supervisors can activate/deactivate supervisors of their university.
12. **Promoted student login**: a promoted student keeps logging in with the transport number; in the seed the third supervisor is the promoted student `SHB-0003` (not a `SUP-03` login code).
13. **Deactivating a student** also deactivates the login of a plain student (trigger); a promoted student keeps supervisor access.
14. **Immutable columns**: a trigger stops signed-in clients from changing `transport_number`, `qr_token`, `profile_id`, `university_id`, `photo_path`; those change only through the privileged API. Profiles' `role`/`login_code` change only through the promote/demote functions.
15. **Password change** goes through `POST /api/me/password` so the policy (min length from settings, uppercase, digit, symbol, confirmation) is enforced server-side; after the first change the client signs out. Voluntary changes require the current password.
16. **Supervisor password reset**: students are reset to their transport number; standalone staff are reset to an admin-chosen password (GoTrue's 6-character minimum rules out short codes like `GS-01`), both with `must_change_password = true`.
17. **Settings scope**: a university row, when present, fully overrides the global row (no per-field inheritance); the admin creates a university override from the settings screen. Settings are admin-write only (§4.5).
18. **Import required columns**: Timestamp, name, student number, phone, college, primary area, work days and shift start; residence, second area, "other" text and the card-image column are optional.
19. **Fuzzy headers**: exact normalized match first, then Levenshtein similarity ≥ 0.85 (also comparing with the Arabic article `ال` stripped), never by position; the wizard lets the admin fix the mapping.
20. **Duplicates**: within-file dedupe applies to rows with a valid student number; the latest `Timestamp` wins (ties → later row) even if the winning row is later rejected for another reason. Duplicate phones are flagged only within the file.
21. **Unknown area names** (not `أخرى`, not in the list) are kept as `area_other_text` with a warning, so they appear on the mapping screen.
22. **New colleges** in the file are listed as warnings in the preview and created at commit.
23. **Transport numbers** are allocated with `FOR UPDATE` on `university_counters` before the auth user is created; if provisioning fails the number is given back only when it is still the latest allocation (otherwise a gap remains, like a sequence).
24. **Import batching**: updates run in one SQL transaction per 100 rows; new students are provisioned per row (auth user → profile+student in one SQL transaction, auth user deleted on failure) in batches of 100 with 4 concurrent workers.
25. **Timestamps in the sheet**: date cells are used as-is; text timestamps are parsed as Y/M/D, or D/M/Y unless the second part is > 12 (then M/D/Y).
26. **Phone validation** uses `libphonenumber-js` `isValid()` (min metadata) for non-Syrian numbers; Syrian mobiles are normalized to `+9639XXXXXXXX` by rule.
27. **Syrian display format** `09XX XXX XXX`; foreign numbers use international formatting.
28. **Area mapping** sets `area_primary_id` and keeps the typed text for history (`needs_area_mapping` becomes false).
29. **Email domain on the client**: a `VITE_STUDENT_EMAIL_DOMAIN` variable (plus the runtime config) was added so the SPA can derive the synthetic login email.
30. **Public vs. internal Supabase URL**: the runtime config prefers `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` and falls back to `SUPABASE_URL`/`SUPABASE_ANON_KEY`; signed URLs issued by the server are rewritten to the public URL when they differ (e.g. docker-compose).
31. **Health check** always answers HTTP 200 with `ok: true` while the process is healthy; database reachability is reported separately as `db: up|down` so an outage of Supabase does not make the orchestrator restart-loop the container.
32. **Service worker**: precaches only hashed JS/CSS/fonts/icons; navigations are network-first (index.html carries the runtime config) with a cached fallback; API and Supabase calls are never cached; no offline scanning.
33. **Supervisor's own scans**: supervisors cannot read `students`, so "مسحاتي اليوم" uses a `security definer` RPC `my_scans_today()` returning only their scans of the day.
34. **Map view** of scan points uses Leaflet with OpenStreetMap tiles (loaded lazily only on that screen); each row also links to Google Maps.
35. **Charts** are hand-drawn SVG (no chart library) to keep the bundle small; bars run right-to-left for RTL.
36. **i18n**: all UI strings are in `apps/web/src/i18n/ar.ts`; strings shared with the API live in `packages/shared/src/i18n/ar.ts` and are re-exported. SQL-generated notification texts and scan rejection messages (`message_ar`, as specified) are stored in Arabic in the database.
37. **Audit logging**: triggers log writes made by signed-in users through the Data API (students, subscriptions, adjustments, settings, role/active changes, packages, universities, route time changes); the privileged API writes its own entries (import run, QR regeneration, photo reset, password reset/change, broadcast, supervisor creation).
38. **Demo seed**: package semesters start today (as specified) but seeded subscriptions start 28 days ago so three weeks of history fit inside them; students at remaining 0/1 are produced with single-week negative adjustments, which works whatever weekday the seed runs on.
39. **Seed passwords**: `SHB-0001..0003` and all staff get `Demo@12345` without forced change so every role is browsable; other students keep the real flow (password = transport number, forced change, forced photo).
40. **Tests & data**: integration tests create and delete their own university fixtures (same colleges/areas as the seed) and E2E tests create an isolated university per run; the print test uses the seeded demo university. Tests therefore never alter demo data.
41. **E2E browser**: Playwright can use the installed Microsoft Edge (`PW_CHANNEL=msedge`) instead of downloading Chromium.
42. **Local port**: 8080 was occupied on the build machine, so local runs used `PORT=8787`; the container still listens on 8080.
43. **Supabase CLI config**: sign-ups disabled globally, email provider enabled, sign-in rate limits raised for the local test stack only.
44. **SheetJS**: installed from the official `cdn.sheetjs.com` tarball (the npm `xlsx` package is outdated and has known advisories).
45. **Excel export** of rejected rows and scan logs is generated client-side as `.xlsx` with an RTL sheet.
46. **Placeholder brand assets**: no logo file was supplied, so a crimson hawk-over-"ST" SVG was drawn and PWA icons are generated from it by `scripts/generate-icons.ts`; replace `apps/web/public/icons/logo.svg` and rerun the script.
47. **`subscriptions.package_id`** uses the default `NO ACTION` foreign key (not `RESTRICT`) so deleting a whole university cascades cleanly; packages with subscriptions still cannot be deleted on their own.
48. **Photo validation**: MIME type from the upload is checked and the image is decoded by `sharp` (format must be jpeg/png/webp); EXIF is dropped by re-encoding after auto-rotation.
49. **Node 20 + supabase-js**: the brief mandates `node:20-slim`; current supabase-js needs a native WebSocket (Node ≥ 22), so server clients pass the `ws` package as the realtime transport. supabase-js prints a Node 20 deprecation notice; moving the Dockerfile to `node:22-slim` later needs no code change.
50. **Image size**: production dependencies are installed in a separate stage and npm/yarn/corepack are removed from the runtime; the unpacked image filesystem is ~280 MB (Docker Desktop's containerd store additionally counts compressed layer blobs in its size column).
51. **docker-compose** runs a minimal self-hosted Supabase (Postgres, GoTrue, PostgREST, Storage, Kong) with the public demo JWT keys, a one-shot `migrate` service that waits for the auth/storage schemas, and the app; right after start `/api/healthz` can briefly report `db: down` while PostgREST reloads its schema.
