# FocusGuard

Android + Web + Cloudflare D1/Workers phone usage management system.

## Repository layout

- `android/`: Android application using Kotlin, Compose, UsageStatsManager, Room, and local aggregation.
- `core-tests/`: JVM test harness for the pure usage aggregation domain logic.
- `backend/`: Cloudflare Workers REST API and D1 migration.
- `web/`: Astro + React administrator console.

## Verification

```bash
# Pure Kotlin usage aggregation tests
/opt/gradle-8.9/bin/gradle :core-tests:test

# Backend
cd backend
npm run typecheck
npm test

# Web
cd ../web
npm run typecheck
npm run build
```

The Android APK build additionally requires an Android SDK with `ANDROID_HOME` or `android/local.properties` configured. The Android implementation reports foreground app usage, persists a deduplicated local event ledger, and evaluates offline device/app policies for day/week/month limits, schedules, whitelists, protected system packages, force-stop state, and temporary extensions. A user-enabled AccessibilityService can show a visible restriction page; ordinary mode is explicitly not an unbypassable system lock and does not hide or enable permissions.

## Deployment notes

- Set a real D1 `database_id` in `backend/wrangler.toml` before deployment.
- Configure the backend authentication secret with `wrangler secret put AUTH_TOKEN`.
- Do not commit credentials, FCM service keys, or local environment files.
