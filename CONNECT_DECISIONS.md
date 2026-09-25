# Connect-phase decisions

1. **Review stack**: `npm run review` runs `docker-compose.yml` under the compose project `somar-review`, probing free ports (app 8080 → 8787…, gateway 8000…, db 54322 → 55432…) and storing them in the gitignored `.review.json`, so re-runs reuse the same ports and data. `--rebuild` rebuilds the app image after code changes; `review:stop -- --wipe` deletes the volumes.
2. **Review credentials** are the public Supabase demo JWT keys and fixed demo passwords (`Admin@12345`, `Demo@12345`); they exist only in the local review stack.
3. **Tour isolation**: `npm run tour` creates a temporary "tour" university (cooldown 0) for the first-login and scan screenshots and deletes it afterwards, so the demo data never changes; admin screens show the demo university.
4. **Tour browser**: the installed Microsoft Edge with Chromium's fake camera flags; the camera screenshot therefore shows the browser's synthetic test pattern.
5. **UI fixes found by the tour**: the full-screen camera and the scan result popup now sit above the bottom tab bar (z-index 60/70), and the college name in the scan popup is no longer rendered in the monospace font.
