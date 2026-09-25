# Somar Tours — University Transport System

Mobile-first Arabic (RTL) PWA for Somar Tours (سومر تورز) student bus transport in Aleppo:
students hold a seasonal package of *trips per week* (1 trip = 1 day = outbound + return),
supervisors scan the student's QR card at the bus door, admins manage everything.

- **Web**: Vite + React 18 + TypeScript + Tailwind (shadcn-style components), installable PWA — `apps/web`
- **API**: Fastify (privileged operations with the Supabase `service_role` key) that also serves the SPA — `apps/api`
- **Shared**: normalizers, week math, import engine, Arabic dictionary — `packages/shared`
- **Database**: Supabase Postgres; all business rules (scan engine, balances, jobs) live in SQL — `supabase/migrations`
- **One container, one port** (8080).

---

## 1. Runbook — English

Follow these steps in order.

### 1.1 Create the Supabase project
Create a project on supabase.com (or point at your self-hosted Supabase). Note the **Project URL**, the **anon key**
and the **service_role key** (Project Settings → API).

### 1.2 Apply the migrations
Either:
```bash
npx supabase link --project-ref <your-project-ref>
npm run db:push            # = supabase db push
```
or open **SQL Editor** and paste, **in order**, the contents of:
`supabase/migrations/0001_init.sql`, `0002_functions.sql`, `0003_rls.sql`, `0004_storage.sql`.
Every file is re-runnable (`if not exists`, `create or replace`, `drop policy if exists`), so running them again is safe.
You can also use `DATABASE_URL=postgresql://… npm run db:apply` with the project's direct connection string.

### 1.3 Storage buckets
`0004_storage.sql` creates the two **private** buckets (`student-photos`, `university-logos`) and their read policies.
If your SQL role cannot write `storage.buckets`, create them in **Storage → New bucket** (both *private*) and then
re-run `0004_storage.sql` for the policies. Students never write to storage; uploads go through the API.

### 1.4 Auth settings (Authentication → Providers / Settings)
- Email provider: **enabled**
- Confirm email: **disabled**
- Allow new users to sign up: **disabled** (every account is created by the admin/API)

Logins are `login code + password`; the app turns the code into the synthetic email
`lower(code)@SUPABASE_STUDENT_EMAIL_DOMAIN` (default `somar.local`). Students never see it.

### 1.5 Environment variables (Coolify → Environment Variables)
| Variable | Required | Notes |
|---|---|---|
| `PORT` | – | default `8080` |
| `NODE_ENV` | – | `production` |
| `APP_BASE_URL` | – | public URL, e.g. `https://transport.example.com` |
| `TZ` | – | `Asia/Damascus` (business logic never depends on it; set for logs) |
| `SUPABASE_URL` | ✔ | project URL as reachable **from the server** |
| `SUPABASE_ANON_KEY` | ✔ | anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✔ | **secret**, server only |
| `SUPABASE_STUDENT_EMAIL_DOMAIN` | – | default `somar.local`; never change after accounts exist |
| `SUPABASE_PHOTO_BUCKET` / `SUPABASE_LOGO_BUCKET` | – | defaults `student-photos` / `university-logos` |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | ✔ (build) | browser-facing values — **build arguments** |
| `VITE_API_BASE_URL` | – | default `/api` |
| `VITE_APP_NAME` | – | app title |
| `VITE_STUDENT_EMAIL_DOMAIN` | – | must equal `SUPABASE_STUDENT_EMAIL_DOMAIN` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | push | web push; push is disabled (in-app bell still works) when empty |
| `VITE_VAPID_PUBLIC_KEY` | push | same public key, for the browser |
| `BOOTSTRAP_ADMIN_CODE` / `BOOTSTRAP_ADMIN_PASSWORD` | once | first admin (step 1.8) |
| `DISABLE_CRON` | – | `true` to disable the scheduler (e.g. a second replica) |
| `DATABASE_URL` | tooling | only for `npm run db:apply`, tests and seeding — not used by the container |

> **Important — `VITE_*` are baked in at build time.** In Coolify tick **"Build Variable"** for every `VITE_*`
> variable so it is passed as a Docker build argument. As a safety net the server also injects
> `window.__APP_CONFIG__` into `index.html` from its **runtime** env (`VITE_SUPABASE_URL` → `SUPABASE_URL`,
> `VITE_SUPABASE_ANON_KEY` → `SUPABASE_ANON_KEY`, `VAPID_PUBLIC_KEY`), and the SPA prefers those values —
> so you can change the Supabase URL/key without rebuilding.

### 1.6 VAPID keys
```bash
npm run generate:vapid
```
Copy `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VITE_VAPID_PUBLIC_KEY` into Coolify.

### 1.7 Deploy on Coolify
1. New resource → your Git repository → **Build Pack: Dockerfile**.
2. Port **8080**; health check path **`/api/healthz`** (the image also has a Docker `HEALTHCHECK`).
3. Add the variables from 1.5 (mark `VITE_*` as build variables).
4. Attach the domain and enable **HTTPS** — required: the camera, geolocation and service worker do not work over plain HTTP.
5. Run **one** replica (the scheduler runs in-process). For more replicas set `DISABLE_CRON=true` on all but one.

### 1.8 Create the first admin
Set `BOOTSTRAP_ADMIN_CODE` (default `ADMIN`) and a strong `BOOTSTRAP_ADMIN_PASSWORD` (8+ chars, uppercase, digit, symbol), then run
once in the running container (Coolify → Terminal):
```bash
node apps/api/dist/bootstrap-admin.js
```
or locally against the project: `npm run bootstrap:admin`. Re-running is harmless.

### 1.9 First configuration in the app
Log in as the admin → **الجامعات** (name, logo, transport prefix e.g. `SHB`, week start) → **الكليات** →
**المناطق** → **الباقات** → **الخطوط ونقاط الوقوف** → **استيراد الطلاب** (the Google-Forms `.xlsx`) → fix
**مناطق بحاجة ربط** → assign packages → **طباعة البطاقات** (browser *Print → Save as PDF*).

### 1.10 Troubleshooting
- **Camera does not open on iPhone**: the site must be HTTPS; Settings → Safari → Camera → *Ask/Allow*. Manual scan by number always works.
- **Push notifications on iPhone**: only after *Share → Add to Home Screen* and opening the installed app (iOS 16.4+). The in-app bell works everywhere.
- **Geolocation denied / "يجب تفعيل صلاحية الموقع"**: HTTPS is required; allow location for the site (iOS: Settings → Privacy → Location Services → Safari Websites → While Using). An admin can turn off `require_supervisor_geo` in **الإعدادات**.
- **CORS errors**: the SPA and API are same-origin; Supabase must accept the site origin (hosted Supabase allows all origins by default; for self-hosted check the Kong CORS plugin).
- **`/api/healthz` shows `db: "down"`**: check `SUPABASE_URL` is reachable from the container, the service-role key is correct, and the migrations were applied (the probe reads `public.settings`).
- **Students cannot log in**: make sure `SUPABASE_STUDENT_EMAIL_DOMAIN` and `VITE_STUDENT_EMAIL_DOMAIN` are identical and email sign-in is enabled.

---

## 2. دليل التشغيل — العربية

اتبع الخطوات بالترتيب.

1. **إنشاء مشروع Supabase** على supabase.com (أو استخدام نسخة مستضافة ذاتياً)، واحفظ رابط المشروع ومفتاح `anon` ومفتاح `service_role`.
2. **تطبيق ملفات قاعدة البيانات**: إما `npx supabase link` ثم `npm run db:push`، أو لصق محتوى الملفات
   `0001_init.sql` ثم `0002_functions.sql` ثم `0003_rls.sql` ثم `0004_storage.sql` في محرر SQL بالترتيب. يمكن إعادة تشغيلها بأمان.
3. **حاويات التخزين**: الملف `0004_storage.sql` ينشئ الحاويتين الخاصتين `student-photos` و`university-logos` مع صلاحيات القراءة. إن لم يُسمح بذلك أنشئهما يدوياً (خاصتين) ثم أعد تشغيل الملف.
4. **إعدادات المصادقة**: تفعيل مزود البريد، **إيقاف** تأكيد البريد، **إيقاف** التسجيل الذاتي (جميع الحسابات ينشئها المدير).
5. **متغيرات البيئة في Coolify**: انسخ `SUPABASE_URL` ومفتاح `anon` ومفتاح `service_role`، وأضف متغيرات `VITE_*` كـ **متغيرات بناء (Build Variable)** لأنها تُدمج في الواجهة وقت البناء. (الخادم يحقن أيضاً إعدادات وقت التشغيل في الصفحة، لذا يمكن تغيير رابط Supabase دون إعادة البناء.)
6. **مفاتيح الإشعارات**: شغّل `npm run generate:vapid` وضع القيم الثلاث في المتغيرات.
7. **النشر على Coolify**: نوع البناء Dockerfile، المنفذ 8080، مسار الفحص `/api/healthz`، اربط النطاق وفعّل **HTTPS** (إلزامي للكاميرا والموقع وعامل الخدمة). استخدم نسخة واحدة فقط.
8. **إنشاء المدير الأول**: ضع `BOOTSTRAP_ADMIN_CODE` و`BOOTSTRAP_ADMIN_PASSWORD` (8 أحرف على الأقل مع حرف كبير ورقم ورمز) ثم نفّذ داخل الحاوية: `node apps/api/dist/bootstrap-admin.js`.
9. **الإعداد الأول**: ادخل كمدير ← الجامعات (الاسم، الشعار، البادئة، بداية الأسبوع) ← الكليات ← المناطق ← الباقات ← الخطوط ← استيراد ملف الطلاب ← ربط المناطق ← تعيين الباقات ← طباعة البطاقات (طباعة ← حفظ كـ PDF من المتصفح).
10. **حل المشاكل**:
    - الكاميرا لا تعمل على iPhone: يجب أن يكون الموقع HTTPS مع السماح بالكاميرا من إعدادات Safari. المسح اليدوي بالرقم يعمل دائماً.
    - الإشعارات على iPhone تعمل فقط بعد «إضافة إلى الشاشة الرئيسية» وفتح التطبيق المثبت. جرس الإشعارات داخل التطبيق يعمل دائماً.
    - رفض إذن الموقع: يلزم HTTPS والسماح بالموقع للمتصفح، ويمكن للمدير إيقاف إلزام الموقع من الإعدادات.
    - أخطاء CORS: الواجهة والـ API من نفس المصدر؛ تأكد أن Supabase يقبل عنوان الموقع.
    - `/api/healthz` يعرض `db: down`: تحقق من إمكانية الوصول إلى `SUPABASE_URL` من الحاوية، ومن مفتاح `service_role`، ومن تطبيق ملفات قاعدة البيانات.

---

## 3. Local development

Requirements: Node ≥ 20, Docker Desktop.

**Option A — Supabase CLI (recommended, used by the test suite)**
```bash
npm install
npm run supabase:start          # local Supabase: db 54322, API 54321 (migrations applied automatically)
npx supabase status -o env      # copy API_URL / ANON_KEY / SERVICE_ROLE_KEY into .env (see .env.example)
npm run seed:demo               # demo university, 80 students, 3 weeks of scans (add -- --reset to rebuild)
npm run build && npm start      # http://localhost:8080
npm run dev                     # or: API with watch + Vite dev server on http://localhost:5173
```

**Option B — docker compose (no Supabase CLI)**
```bash
docker compose up --build       # app http://localhost:8080, Supabase gateway http://localhost:8000
# then, from the host, seed with: SUPABASE_URL=http://localhost:8000 SUPABASE_SERVICE_ROLE_KEY=<demo service key from docker-compose.yml> npm run seed:demo
```

Demo logins after `npm run seed:demo` (password `Demo@12345` unless noted):
`ADMIN` / `BOOTSTRAP_ADMIN_PASSWORD` (default `Admin@12345`) · general supervisor `GS-01` · supervisors `SUP-01`, `SUP-02`
and the promoted student `SHB-0003` · students `SHB-0001`, `SHB-0002` (all other students: password = transport number,
forced change on first login).

## 4. Scripts

| Script | What it does |
|---|---|
| `npm run verify` | lint + typecheck + unit + integration + build |
| `npm run test:unit` | Vitest unit tests (`packages/shared`) |
| `npm run test:int` | integration tests against the local Supabase stack (applies migrations first) |
| `npm run test:e2e` | Playwright (mobile viewport) against the built app — needs the stack + `seed:demo`; `PW_CHANNEL=msedge` uses the installed Edge instead of downloading Chromium |
| `npm run seed:demo` | demo data (`-- --reset` to rebuild) and `supabase/seed/demo-import.xlsx` |
| `npm run seed:import-file` | regenerate only `demo-import.xlsx` |
| `npm run bootstrap:admin` | first admin from env |
| `npm run generate:vapid` | VAPID key pair |
| `npm run db:push` / `npm run db:apply` | push migrations with the CLI / apply them via `DATABASE_URL` |

See `DECISIONS.md` for every assumption made during the build.
