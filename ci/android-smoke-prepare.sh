#!/usr/bin/env bash
set -euo pipefail
: "${RUNNER_TEMP:?This fixture is only for the disposable CI runner}"
fixture="$RUNNER_TEMP/focusguard-smoke"
mkdir -p "$fixture"
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj '/CN=FocusGuard smoke CA' -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$fixture/ca.key" -out "$fixture/ca.pem" >/dev/null 2>&1
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=127.0.0.1' \
  -keyout "$fixture/server.key" -out "$fixture/server.csr" >/dev/null 2>&1
printf '%s\n' 'subjectAltName=IP:127.0.0.1' 'extendedKeyUsage=serverAuth' > "$fixture/leaf.ext"
openssl x509 -req -in "$fixture/server.csr" -CA "$fixture/ca.pem" -CAkey "$fixture/ca.key" \
  -CAcreateserial -days 1 -sha256 -extfile "$fixture/leaf.ext" -out "$fixture/server.pem"
# Temporary Debug-only trust of this job's ephemeral CA. No change to the application manifest or trust store in Git.
test ! -e android/app/src/debug/AndroidManifest.xml
mkdir -p android/app/src/debug/res/{xml,raw}
cp "$fixture/ca.pem" android/app/src/debug/res/raw/smoke_ca.pem
cat > android/app/src/debug/res/xml/smoke_network.xml <<'XML'
<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="@raw/smoke_ca" /></trust-anchors></base-config></network-security-config>
XML
cat > android/app/src/debug/AndroidManifest.xml <<'XML'
<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:networkSecurityConfig="@xml/smoke_network" /></manifest>
XML
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
