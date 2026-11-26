#!/usr/bin/env bash
set -euo pipefail
# Disposable emulator test. Both APKs use this runner's debug signing key.
bash ci/android-smoke-prepare.sh
legacy="$GITHUB_WORKSPACE/legacy-fcm"
fixture="$RUNNER_TEMP/focusguard-smoke"
mkdir -p "$legacy/android/app/src/debug/res/xml"
cat > "$legacy/android/app/src/debug/AndroidManifest.xml" <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:networkSecurityConfig="@xml/smoke_network" /></manifest>
XML
cat > "$legacy/android/app/src/debug/res/xml/smoke_network.xml" <<'XML'
<network-security-config><base-config cleartextTrafficPermitted="false"/><domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config></network-security-config>
XML
ln -s "$GITHUB_WORKSPACE/backend/node_modules" "$legacy/backend/node_modules"
cat > "$fixture/legacy-wrangler.toml" <<TOML
name = "focusguard-android-isolated"
main = "$legacy/backend/src/index.ts"
compatibility_date = "2025-09-06"
[[d1_databases]]
binding = "DB"
database_name = "focusguard-fixture"
database_id = "00000000-0000-4000-8000-000000000001"
migrations_dir = "$GITHUB_WORKSPACE/backend/migrations"
TOML
(cd "$legacy" && ./gradlew --no-daemon :android:app:assembleDebug)
