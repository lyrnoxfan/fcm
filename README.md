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

### 首次授权、锁定与设备解绑

- Android 首次打开时显示权限引导。使用情况访问和无障碍服务由使用者在系统设置中手动授权；Android 13+ 的通知许可可选。可以跳过，也可以从系统设置撤销。
- 全局锁定时，应用尽力拦截普通应用（包括普通白名单应用），限制页仅显示「设备已被锁定」。系统锁屏、紧急呼叫、系统设置及权限撤销入口不受该限制。普通应用无障碍权限不等同于 Device Owner，不能保证不可绕过，不保证覆盖所有 Android 版本、分屏或厂商系统行为。
- 网页端在设备详情底部可确认解绑。只有设备所属账号能执行；旧凭证即时撤销，待处理指令过期，策略解除绑定，服务器历史不被物理删除。设备在线同步收到拒绝后回到未配对状态；离线时无法立即收到撤销结果。重新连接必须使用新配对码。
- 启用网页解绑前，先在目标环境应用后端迁移 `0007_device_unbinding.sql`，再部署对应 Worker 和网页。验收请使用隔离数据库和新建测试设备，不要对生产设备执行测试解绑。
