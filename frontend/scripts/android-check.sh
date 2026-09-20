#!/usr/bin/env bash
# On-device check of the built Play Store TWA — `npm run test:android`.
#
# Installs the Bubblewrap-built APK on ONE connected emulator/device and checks
# what the emulated-browser suite cannot: that Android really treats it as
# Groovepede's app (URL bar gone = asset links verified), that it shows up as a
# share target, and that the share intent opens it. Not run in CI (it needs an
# emulator); run it after a build, before uploading to Play.
#
#   npm run test:android [-- path/to/app-release-signed.apk]
#
# Default APK: ../android/app-release-signed.apk (download it from the android.yml
# workflow artifact). Env: ADB (adb binary), OUT_DIR (screenshots/dumps).
#
# One-time emulator setup (needs JDK 17, KVM):
#   sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;x86_64"
#   avdmanager create avd -n groovepede -k "system-images;android-36;google_apis;x86_64"
#   emulator -avd groovepede &
#
# Exit codes: 0 = all checks passed OR nothing could be tested (loud SKIPPED
# banner); 1 = a check failed.
set -euo pipefail

PKG="pl.gregolsky.groovepede"
HOST="groovepede.gregolsky.pl"
# Same real album the post-deploy smoke suite resolves against the live resolver.
SHARE_URL="https://open.spotify.com/album/0c0hlchA9Q66PcL7xlPPfp"

cd "$(dirname "$0")/.."
ADB="${ADB:-adb}"
APK="${1:-../android/app-release-signed.apk}"
OUT_DIR="${OUT_DIR:-android-check-out}"

skip() {
  echo
  echo "================================================================"
  echo " SKIPPED — nothing was verified on a device"
  echo " $*"
  echo "================================================================"
  exit 0
}
fail() { echo "  FAIL: $*" >&2; exit 1; }
pass() { echo "  ok:   $*"; }
step() { echo; echo "== $* =="; }

command -v "$ADB" >/dev/null 2>&1 || skip "adb not found (install Android platform-tools, or set ADB=)."
devices=$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')
count=$(printf '%s\n' "$devices" | grep -c . || true)
[ "$count" -ge 1 ] || skip "no emulator or device connected (see the header for AVD setup)."
[ "$count" -eq 1 ] || { echo "Several devices connected; disconnect all but one:" >&2; printf '%s\n' "$devices" >&2; exit 1; }
[ -f "$APK" ] || skip "no APK at $APK (download app-release-signed.apk from the android.yml artifact)."

mkdir -p "$OUT_DIR"
shot() { "$ADB" exec-out screencap -p > "$OUT_DIR/$1.png"; echo "  saved $OUT_DIR/$1.png"; }
ui_dump() { "$ADB" shell uiautomator dump /sdcard/gp-ui.xml >/dev/null 2>&1; "$ADB" exec-out cat /sdcard/gp-ui.xml; }
focus() { "$ADB" shell dumpsys window | grep -E "mCurrentFocus|mFocusedApp" || true; }

step "1. Install and launch"
"$ADB" install -r "$APK" >/dev/null || fail "adb install failed (signature clash with an installed copy? try: adb uninstall $PKG)"
pass "installed $(basename "$APK")"
"$ADB" shell am force-stop "$PKG"
"$ADB" shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
launched=""
for _ in $(seq 1 20); do
  if focus | grep -q "$PKG"; then launched=yes; break; fi
  sleep 1
done
[ -n "$launched" ] || { shot launch-failed; fail "$PKG never took focus. Current: $(focus)"; }
pass "$PKG is in the foreground"
sleep 3   # let the page load before inspecting the UI
shot launched

step "2. Asset links: no browser chrome (the check that catches a wrong fingerprint)"
# An unverified TWA falls back to a Custom Tab with a URL/security toolbar.
dump=$(ui_dump)
if printf '%s' "$dump" | grep -qE 'id/(url_bar|security_button|toolbar)'; then
  shot url-bar-visible
  fail "browser toolbar is visible: Digital Asset Links did not verify. Is the fingerprint of the key that signed this APK (the upload key for a sideload, Google's key for a Play install) in .well-known/assetlinks.json on $HOST?"
fi
pass "no browser toolbar: the TWA is running full-screen"
# Android 12+ also tracks App Links verification per domain; informational only.
"$ADB" shell pm verify-app-links --re-verify "$PKG" >/dev/null 2>&1 || true
sleep 2
links=$("$ADB" shell pm get-app-links "$PKG" 2>/dev/null || true)
if printf '%s' "$links" | grep -q "$HOST: verified"; then pass "pm get-app-links: $HOST verified"
elif [ -n "$links" ]; then echo "  note: pm get-app-links reports: $(printf '%s' "$links" | grep "$HOST" || echo 'no entry for '"$HOST")"
else echo "  note: pm get-app-links unavailable on this Android version"; fi

step "3. Share target"
handlers=$("$ADB" shell cmd package query-activities -a android.intent.action.SEND -t text/plain 2>/dev/null || true)
if [ -n "$handlers" ]; then
  printf '%s' "$handlers" | grep -q "$PKG" || fail "$PKG is not offered as a handler for SEND text/plain: the share_target did not become an intent filter"
  pass "$PKG handles SEND text/plain"
else
  echo "  note: cmd package query-activities unavailable; relying on the launch below"
fi
"$ADB" shell am force-stop "$PKG"
out=$("$ADB" shell am start -a android.intent.action.SEND -t text/plain \
        --es android.intent.extra.TEXT "$SHARE_URL" -p "$PKG" 2>&1) || fail "share intent failed: $out"
printf '%s' "$out" | grep -qiE "error|exception" && fail "share intent was rejected: $out"
pass "share intent delivered"
sleep 6   # resolver round-trip + the overlay's own timing
shot after-share
focus | grep -q "$PKG" || echo "  note: app is no longer focused (a share launch closes its window once the album is added). Screenshot saved."

echo
echo "All checks passed. Review $OUT_DIR/*.png by eye: launcher icon, no clipped"
echo "artwork, and the album from $SHARE_URL in the queue."
