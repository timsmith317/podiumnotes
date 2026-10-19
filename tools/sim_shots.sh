#!/usr/bin/env bash
# File: sim_shots.sh → ~/Projects/podiumnotes/tools/sim_shots.sh
#
# App Store screenshots from the iOS Simulator with a clean status bar.
#
# Apple's marketing shots all read 9:41 with full signal and a full battery.
# The simulator shows real time, real battery and a "Carrier" label unless you
# override it — and the override is wiped on every reboot, so it has to be
# reapplied rather than set once.
#
# Simulator screenshots come out at native resolution, which already matches
# what App Store Connect wants. No scaling, no export step.
#
#   chmod +x tools/sim_shots.sh          # once
#   run from the PROJECT ROOT, not from tools/
#
#   ./tools/sim_shots.sh devices                       # what's installed
#   ./tools/sim_shots.sh boot "iPad Pro 13-inch (M4)"  # create if needed, boot
#   ./tools/sim_shots.sh clean                         # reapply after a reboot
#   ./tools/sim_shots.sh shot listen-ipad              # capture
#
# Shots land in ./screenshots/<name>-<WIDTHxHEIGHT>.png so the dimensions are
# in the filename — App Store Connect rejects wrong sizes and the error does
# not tell you which file was wrong.
#
# v2: `simctl boot` takes a device NAME, but a fresh Xcode install ships device
# TYPES with no devices created from them, so booting by type name failed
# silently. Now creates the device first when it is missing. Also launches
# Simulator.app by full path — `open -a Simulator` fails whenever LaunchServices
# has not registered the copy buried inside Xcode.app.

set -euo pipefail

OUT_DIR="${SIM_SHOT_DIR:-screenshots}"

die() { echo "error: $*" >&2; exit 1; }

require_booted() {
    xcrun simctl list devices booted | grep -q "Booted" \
        || die "no simulator is booted — run: $0 boot \"<device name>\""
}

open_simulator() {
    local app
    app="$(xcode-select -p)/Applications/Simulator.app"
    [ -d "$app" ] || die "Simulator.app not found at $app — check xcode-select -p"
    open "$app"
}

# Newest installed iOS runtime identifier. Runtimes list ascending, so the
# last iOS line is the newest.
newest_ios_runtime() {
    xcrun simctl list runtimes \
        | awk '/^iOS /{last=$NF} END{if (last=="") exit 1; print last}' \
        || die "no iOS simulator runtime installed (Xcode > Settings > Components)"
}

# Device type identifier for an exact type name, e.g. "iPad Pro 13-inch (M4)".
# Several types share a prefix ("… (M4)" and "… (M4) (16GB)"), so match the
# name followed by " (com." to pin the base variant.
devicetype_id() {
    local name="$1" id
    id="$(xcrun simctl list devicetypes \
          | grep -F "$name (com." \
          | sed -n 's/.*(\(com\.apple[^)]*\)).*/\1/p' \
          | head -1)"
    [ -n "$id" ] || die "no device type named '$name' — run: $0 devices"
    echo "$id"
}

device_exists() {
    xcrun simctl list devices available | grep -qF "$1 ("
}

clean_bar() {
    require_booted
    xcrun simctl status_bar booted override \
        --time "9:41" \
        --dataNetwork wifi \
        --wifiMode active \
        --wifiBars 3 \
        --cellularMode active \
        --cellularBars 4 \
        --batteryState charged \
        --batteryLevel 100 \
        --operatorName ""
    echo "status bar set: 9:41, full bars, 100% charged, no carrier"
}

case "${1:-}" in
    devices)
        echo "— installed device types —"
        xcrun simctl list devicetypes
        echo
        echo "— created devices —"
        xcrun simctl list devices available
        ;;

    boot)
        [ $# -ge 2 ] || die "usage: $0 boot \"iPad Pro 13-inch (M4)\""
        name="$2"

        if ! device_exists "$name"; then
            echo "no device named '$name' yet — creating it"
            dt="$(devicetype_id "$name")"
            rt="$(newest_ios_runtime)"
            xcrun simctl create "$name" "$dt" "$rt" >/dev/null
            echo "created on $rt"
        fi

        # Already-booted is not an error worth stopping for.
        xcrun simctl boot "$name" 2>/dev/null || true
        open_simulator
        echo "waiting for boot…"
        xcrun simctl bootstatus "$name" -b >/dev/null 2>&1 || sleep 8
        clean_bar
        ;;

    clean)
        clean_bar
        ;;

    shot)
        [ $# -ge 2 ] || die "usage: $0 shot <name>"
        require_booted
        mkdir -p "$OUT_DIR"
        tmp="$(mktemp -t simshot).png"
        xcrun simctl io booted screenshot "$tmp" >/dev/null

        # Put the real pixel dimensions in the filename — App Store Connect
        # rejects mismatched sizes without saying which file offended.
        dims="$(sips -g pixelWidth -g pixelHeight "$tmp" \
                | awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w "x" h}')"
        dest="$OUT_DIR/$2-$dims.png"
        mv "$tmp" "$dest"
        echo "$dest"
        ;;

    reset)
        require_booted
        xcrun simctl status_bar booted clear
        echo "status bar back to simulator defaults"
        ;;

    *)
        cat <<'USAGE'
usage (run from the project root):
  sim_shots.sh devices              device types installed, devices created
  sim_shots.sh boot "<device>"      create if needed, boot, set the clean bar
  sim_shots.sh clean                reapply the clean bar after a reboot
  sim_shots.sh shot <name>          capture to ./screenshots/<name>-WxH.png
  sim_shots.sh reset                restore the simulator's own status bar

The status bar override does not survive a reboot. If a shot comes out with
the real time on it, run `clean` and take it again.
USAGE
        exit 1
        ;;
esac
