#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?This fixture is only for the disposable CI runner}"
fixture="$RUNNER_TEMP/focusguard-smoke"
mkdir -p "$fixture"
# Disposable CI only: route app traffic to the runner via adb reverse. Production
# remains restricted to 113.44.6.95 and this test does not verify the public host.
python3 - <<'INNER'
from pathlib import Path
p = Path('android/app/src/main/java/com/focusguard/sync/SyncSettingsStore.kt')
p.write_text(p.read_text().replace('http://113.44.6.95:8081', 'http://127.0.0.1:18787'))
p = Path('android/app/src/main/res/xml/network_security_config.xml')
p.write_text(p.read_text().replace('113.44.6.95', '127.0.0.1'))
INNER
(cd backend && npm ci)
cat > "$fixture/wrangler.toml" <<TOML
name = "focusguard-android-isolated"
main = "$PWD/backend/src/index.ts"
compatibility_date = "2025-09-06"
[[d1_databases]]
binding = "DB"
database_name = "focusguard-fixture"
database_id = "00000000-0000-4000-8000-000000000001"
migrations_dir = "$PWD/backend/migrations"
TOML
export WRANGLER_SEND_METRICS=false
backend/node_modules/.bin/wrangler d1 migrations apply focusguard-fixture --local --persist-to "$fixture/state" --config "$fixture/wrangler.toml"
yes | "${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null || test "${PIPESTATUS[1]}" = 0
"${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager" --install 'platforms;android-35' 'build-tools;35.0.0'
./gradlew --no-daemon :android:app:testDebugUnitTest :android:app:assembleDebug
