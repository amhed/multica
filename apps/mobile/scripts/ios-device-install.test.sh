#!/usr/bin/env bash
# Tests for scripts/ios-device-install.sh.
#
# The script builds with xcodebuild and installs with devicectl instead of
# `expo run:ios`, whose Simulator.app prerequisite fails on Xcode installs that
# ship no Simulator app. These tests run a copy of the script in a fake mobile
# tree and stub every external tool on PATH, so they need no node_modules, no
# Xcode, and no device.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/multica-ios-device-install.XXXXXX")
BIN_DIR="$TEST_DIR/bin"
MOBILE_DIR="$TEST_DIR/mobile"
CALLS_FILE="$TEST_DIR/calls.log"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

mkdir -p "$BIN_DIR" "$MOBILE_DIR/scripts" "$MOBILE_DIR/ios"
# The script reports paths from $PWD; normalize so a trailing-slash TMPDIR matches.
MOBILE_DIR=$(cd "$MOBILE_DIR" && pwd)
cp "$SCRIPT_DIR/ios-device-install.sh" "$MOBILE_DIR/scripts/"
export MULTICA_TEST_CALLS="$CALLS_FILE"

# Prebuild would write this; the script reads the app target from it.
cat >"$MOBILE_DIR/ios/Podfile" <<'EOF'
platform :ios, '16.0'
target 'CarropanaMultica' do
  use_expo_modules!
end
EOF
# The script reads the app's deployment target from the prebuilt project.
mkdir -p "$MOBILE_DIR/ios/CarropanaMultica.xcodeproj"
cat >"$MOBILE_DIR/ios/CarropanaMultica.xcodeproj/project.pbxproj" <<'EOF'
				IPHONEOS_DEPLOYMENT_TARGET = 15.1;
				IPHONEOS_DEPLOYMENT_TARGET = 15.1;
EOF
export EXPO_APPLE_TEAM_ID=TEAM123

# Record-only stubs.
for tool in pnpm pod xcodebuild; do
  cat >"$BIN_DIR/$tool" <<EOF
#!/usr/bin/env bash
printf '%s %s\n' "$tool" "\$*" >>"\$MULTICA_TEST_CALLS"
EOF
  chmod +x "$BIN_DIR/$tool"
done

cat >"$BIN_DIR/plutil" <<'EOF'
#!/usr/bin/env bash
printf 'plutil %s\n' "$*" >>"$MULTICA_TEST_CALLS"
echo "ai.multica.mobile"
EOF
chmod +x "$BIN_DIR/plutil"

# devicectl stub: `list devices --json-output <path>` writes one simulator and
# one physical device; every other call is recorded.
cat >"$BIN_DIR/xcrun" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $2 $3" = "devicectl list devices" ]; then
  out=""
  while [ $# -gt 0 ]; do
    if [ "$1" = "--json-output" ]; then out="$2"; fi
    shift
  done
  cat >"$out" <<'JSON'
{"result":{"devices":[
  {"deviceProperties":{"name":"iPhone 17 Pro"},"hardwareProperties":{"udid":"SIM-1","reality":"simulated"}},
  {"deviceProperties":{"name":"Test Phone"},"hardwareProperties":{"udid":"PHONE-1","reality":"physical"}}
]}}
JSON
  exit 0
fi
printf 'xcrun %s\n' "$*" >>"$MULTICA_TEST_CALLS"
EOF
chmod +x "$BIN_DIR/xcrun"

PATH="$BIN_DIR:$PATH"
export PATH

fail() {
  echo "FAIL: $1" >&2
  echo "--- recorded calls ---" >&2
  cat "$CALLS_FILE" >&2 || true
  exit 1
}

APP="$MOBILE_DIR/ios/build/Build/Products/Release-iphoneos/CarropanaMultica.app"

assert_line() {
  local n=$1 expected=$2
  [ "$(sed -n "${n}p" "$CALLS_FILE")" = "$expected" ] ||
    fail "call $n should be: $expected
got: $(sed -n "${n}p" "$CALLS_FILE")"
}

assert_sequence() {
  local udid=$1
  assert_line 1 'pnpm exec expo prebuild -p ios --no-install'
  assert_line 2 'pod install'
  assert_line 3 "xcodebuild -workspace ios/CarropanaMultica.xcworkspace -scheme CarropanaMultica -configuration Release -destination id=$udid -derivedDataPath ios/build -allowProvisioningUpdates DEVELOPMENT_TEAM=TEAM123 IPHONEOS_DEPLOYMENT_TARGET=15.1 build"
  assert_line 4 "plutil -extract CFBundleIdentifier raw $APP/Info.plist"
  assert_line 5 "xcrun devicectl device install app --device $udid $APP"
  assert_line 6 "xcrun devicectl device process launch --device $udid ai.multica.mobile"
  [ "$(wc -l <"$CALLS_FILE" | tr -d ' ')" = 6 ] || fail "expected exactly 6 calls"
}

# --- no argument: first physical device, simulators skipped ----------------
: >"$CALLS_FILE"
"$MOBILE_DIR/scripts/ios-device-install.sh" >/dev/null
assert_sequence PHONE-1

# --- device selected by name ------------------------------------------------
: >"$CALLS_FILE"
"$MOBILE_DIR/scripts/ios-device-install.sh" "Test Phone" >/dev/null
assert_sequence PHONE-1

# --- unknown device aborts before building ----------------------------------
: >"$CALLS_FILE"
if "$MOBILE_DIR/scripts/ios-device-install.sh" "Nope" >/dev/null 2>&1; then
  fail "an unknown device should exit non-zero"
fi
[ ! -s "$CALLS_FILE" ] || fail "nothing should run for an unknown device"

# --- missing team id aborts before building ---------------------------------
: >"$CALLS_FILE"
if EXPO_APPLE_TEAM_ID= "$MOBILE_DIR/scripts/ios-device-install.sh" >/dev/null 2>&1; then
  fail "a missing EXPO_APPLE_TEAM_ID should exit non-zero"
fi
[ ! -s "$CALLS_FILE" ] || fail "nothing should run without a team id"

echo "ios-device-install.sh tests passed"
