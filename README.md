# FocusGuard

Android + Web + Cloudflare D1/Workers phone usage management system.

## Repository layout

- `android/`: Android application using Kotlin, Compose, UsageStatsManager, Room, and local aggregation.
- `core-tests/`: JVM test harness for the pure usage aggregation domain logic.
- `backend/`: Cloudflare Workers REST API, D1 migrations, user sessions, device pairing, device tokens, policy sync, usage upload, and command acknowledgements.
- `web/`: Astro + React administrator console with `/api/v1` session-based API integration.

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
- Configure the Web console with the Worker origin (it automatically targets `/api/v1`).
- Generate a one-time pairing code from the authenticated Web console, then enter it on the Android device; the device token is stored separately in Android Keystore-backed DataStore.
- Android sync uses a 15-minute WorkManager job and on-demand hook; local PolicyEngine enforcement continues while offline.
- Do not commit credentials, FCM service keys, or local environment files.

## Delivery boundary

The repository contains the complete source and CI build definitions. Android APK compilation and real-device Accessibility/UsageStats validation require an Android SDK and a physical/emulator device. Cloudflare production deployment requires a real D1 `database_id`, DNS/HTTPS, and production secrets. FCM remains optional; REST polling is the reliable command fallback.
