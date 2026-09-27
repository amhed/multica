#!/usr/bin/env bash
# Build a Release copy of the app and install it on a physical iPhone without
# `expo run:ios`.
#
# run:ios always asserts that Simulator.app exists (SimulatorAppPrerequisite
# in @expo/cli), even for a device build, and fails on Xcode installs that ship
# without the Simulator app. This script does the same steps with Xcode's own
# tools: prebuild, pod install, xcodebuild, then devicectl install + launch.
#
# Usage (APP_ENV and the .env file come from the calling package.json script):
#   pnpm ios:device:prod:install                     # first paired iPhone
#   pnpm ios:device:prod:install "iPhone 16 Amhed"   # by name or UDID
#
# EXPO_APPLE_TEAM_ID is required: xcodebuild has no interactive team picker,
# and prebuild pins DEVELOPMENT_TEAM from it (see ios.appleTeamId in
# app.config.ts).
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${EXPO_APPLE_TEAM_ID:-}" ]; then
  echo "EXPO_APPLE_TEAM_ID is not set; add it to the variant's gitignored .env.*.local file." >&2
  exit 1
fi

devices_json=$(mktemp "${TMPDIR:-/tmp}/multica-devices.XXXXXX")
trap 'rm -f "$devices_json"' EXIT
xcrun devicectl list devices --json-output "$devices_json" >/dev/null

# Match by name or UDID; with no argument, take the first physical device.
udid=$(node -e '
  const [file, wanted] = process.argv.slice(1);
  const devices = JSON.parse(require("fs").readFileSync(file, "utf8")).result.devices
    .filter((d) => d.hardwareProperties.reality === "physical");
  const match = wanted
    ? devices.find((d) => d.deviceProperties.name === wanted || d.hardwareProperties.udid === wanted)
    : devices[0];
  if (match) console.log(match.hardwareProperties.udid);
' "$devices_json" "${1:-}")

if [ -z "$udid" ]; then
  echo "No paired physical device matches '${1:-<any>}'. Run: xcrun devicectl list devices" >&2
  exit 1
fi

pnpm exec expo prebuild -p ios --no-install
(cd ios && pod install)

# Prebuild names the Xcode project after the app; the Podfile target is the
# reliable way to recover it.
scheme=$(sed -n "s/^target '\(.*\)' do$/\1/p" ios/Podfile | head -n 1)

# Some pod resource-bundle targets declare iOS 6-12, below what current Xcode
# accepts. A command-line setting applies to every target, so pin them all to
# the app's own deployment target.
deployment_target=$(sed -n 's/.*IPHONEOS_DEPLOYMENT_TARGET = \([0-9.]*\);/\1/p' \
  "ios/$scheme.xcodeproj/project.pbxproj" | head -n 1)

xcodebuild \
  -workspace "ios/$scheme.xcworkspace" \
  -scheme "$scheme" \
  -configuration Release \
  -destination "id=$udid" \
  -derivedDataPath ios/build \
  -allowProvisioningUpdates \
  "DEVELOPMENT_TEAM=$EXPO_APPLE_TEAM_ID" \
  "IPHONEOS_DEPLOYMENT_TARGET=$deployment_target" \
  build

app="$PWD/ios/build/Build/Products/Release-iphoneos/$scheme.app"
bundle_id=$(plutil -extract CFBundleIdentifier raw "$app/Info.plist")

xcrun devicectl device install app --device "$udid" "$app"
xcrun devicectl device process launch --device "$udid" "$bundle_id"
