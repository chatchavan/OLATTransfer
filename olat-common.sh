# Shared helpers for OLATTransfer scripts. Meant to be sourced, not executed.

SERVER="lms.uzh.ch"
WEBDAV_PREFIX="/Volumes/$SERVER"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/config.yml"

STATE_DIR="$HOME/Library/Application Support/OLATTransfer"
STAMP_FILE="$STATE_DIR/last_used"

LOG_DIR="$HOME/Library/Logs/OLATTransfer"
LOG_FILE="$LOG_DIR/idle-eject.log"
LOG_MAX_BYTES=$((5 * 1024 * 1024))

AGENT_LABEL="com.local.olattransfer.idle-eject"
AGENT_PLIST="$HOME/Library/LaunchAgents/$AGENT_LABEL.plist"

HELPER_SOURCE="$SCRIPT_DIR/olat-finder-helper.swift"
HELPER_APP="$STATE_DIR/OLATFinderHelper.app"
HELPER_APP_EXE="$HELPER_APP/Contents/MacOS/OLATFinderHelper"

CODESIGN_IDENTITY_CN="OLATFinderHelper Local Signing"

mkdir -p "$STATE_DIR" "$LOG_DIR"

# read_config_value <key> <default> - reads a "key: <integer>" line from
# config.yml. No YAML library dependency, just a simple key: value reader.
read_config_value() {
    local key="$1" default="$2" value=""
    if [[ -f "$CONFIG_FILE" ]]; then
        value=$(grep -E "^[[:space:]]*${key}:" "$CONFIG_FILE" \
                 | head -1 \
                 | sed -E "s/^[[:space:]]*${key}:[[:space:]]*([0-9]+).*/\1/")
    fi
    [[ -z $value ]] && value="$default"
    echo "$value"
}

touch_last_used() {
    touch "$STAMP_FILE"
}

# ensure_signing_identity - generates (once) a local self-signed
# code-signing certificate and imports it into the login keychain, so
# OLATFinderHelper.app can be signed with a stable, non-ad-hoc identity -
# ad-hoc signatures have no Team ID and change on every rebuild, so macOS
# doesn't track them as a distinct Automation permission entry at all; it
# silently falls back to whatever already-granted ancestor process (e.g.
# Terminal) invoked it. Generating/importing the cert is safe and
# non-interactive. Trusting it for code signing is NOT done here: that
# needs an interactive approval dialog that hangs a non-interactive script
# (confirmed by testing) - it's a one-time manual step, see README/TESTS.md.
ensure_signing_identity() {
    if security find-certificate -c "$CODESIGN_IDENTITY_CN" >/dev/null 2>&1; then
        return
    fi
    if ! command -v openssl >/dev/null 2>&1; then
        log_line "openssl not found; can't generate a local code-signing identity. OLATFinderHelper.app will stay ad-hoc signed (generic Automation permission)."
        return
    fi

    local tmp pass
    tmp=$(mktemp -d)
    pass=$(openssl rand -hex 16)

    openssl req -x509 -newkey rsa:2048 -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
        -days 3650 -nodes -subj "/CN=$CODESIGN_IDENTITY_CN" \
        -addext "keyUsage=critical,digitalSignature" \
        -addext "extendedKeyUsage=critical,codeSigning" \
        -addext "basicConstraints=critical,CA:false" >/dev/null 2>&1

    openssl pkcs12 -export -out "$tmp/cert.p12" -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
        -passout "pass:$pass" -legacy >/dev/null 2>&1

    if [[ ! -f "$tmp/cert.p12" ]]; then
        log_line "Failed to generate local code-signing certificate."
        rm -rf "$tmp"
        return
    fi

    security import "$tmp/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P "$pass" -T /usr/bin/codesign >/dev/null 2>&1
    rm -rf "$tmp"

    log_line "Generated local code-signing certificate '$CODESIGN_IDENTITY_CN'. One-time manual step needed: open Keychain Access, find it under 'My Certificates' (login keychain), expand Trust, set 'Code Signing' to 'Always Trust', and enter your password when prompted. Until then, OLATFinderHelper.app stays ad-hoc signed."
}

# ensure_finder_helper - (re)compiles OLATFinderHelper.app from
# olat-finder-helper.swift into a minimal .app bundle in STATE_DIR, so
# macOS's Automation permission for controlling Finder is granted to this
# specific tool rather than to the generic /bin/bash binary (which would
# otherwise cover every bash script on the machine). Rebuild is a no-op
# unless the compiled binary is missing or older than the source. Requires
# the Xcode Command Line Tools (swiftc); if that's unavailable, eject_webdav
# and finder_window_open_on_webdav degrade gracefully (see below), they
# don't block a transfer from completing.
ensure_finder_helper() {
    local needs_build=0
    if [[ ! -x "$HELPER_APP_EXE" || "$HELPER_SOURCE" -nt "$HELPER_APP_EXE" ]]; then
        needs_build=1
    fi

    if [[ $needs_build -eq 1 ]]; then
        if ! command -v swiftc >/dev/null 2>&1; then
            log_line "swiftc not found; can't build OLATFinderHelper.app. Install the Xcode Command Line Tools (xcode-select --install) for the idle-eject Finder checks to work."
            return
        fi

        mkdir -p "$HELPER_APP/Contents/MacOS"
        local build_output
        build_output=$(swiftc "$HELPER_SOURCE" -o "$HELPER_APP_EXE" 2>&1)
        if [[ ! -x "$HELPER_APP_EXE" ]]; then
            log_line "Failed to compile OLATFinderHelper.app: $build_output"
            return
        fi

        cat > "$HELPER_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>OLATFinderHelper</string>
    <key>CFBundleIdentifier</key>
    <string>com.local.olattransfer.finderhelper</string>
    <key>CFBundleName</key>
    <string>OLATFinderHelper</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSAppleEventsUsageDescription</key>
    <string>OLATFinderHelper needs to control Finder to mount/eject the OLAT WebDAV volume.</string>
</dict>
</plist>
PLIST
    fi

    # (Re-)signing runs on every call, not just on a rebuild: it's cheap,
    # and it lets completing the one-time trust step (ensure_signing_identity)
    # upgrade an already-built ad-hoc app to a properly-signed one right
    # away, without waiting for the Swift source to change.
    local was_adhoc=0
    codesign -dv "$HELPER_APP" 2>&1 | grep -q "Signature=adhoc" && was_adhoc=1

    ensure_signing_identity
    if codesign --sign "$CODESIGN_IDENTITY_CN" --force "$HELPER_APP" >/dev/null 2>&1; then
        if [[ $needs_build -eq 1 || $was_adhoc -eq 1 ]]; then
            log_line "OLATFinderHelper.app signed with local identity '$CODESIGN_IDENTITY_CN'."
        fi
    else
        codesign --sign - --force "$HELPER_APP" >/dev/null 2>&1
        [[ $needs_build -eq 1 ]] && log_line "Compiled OLATFinderHelper.app (ad-hoc signed; '$CODESIGN_IDENTITY_CN' not yet trusted for code signing - see the log line above for the one-time setup step)."
    fi
}

# call_finder_helper <cmd> <arg> - launches OLATFinderHelper.app via
# `open -W` (a real NSApplication, launched through LaunchServices) and
# returns its result. This specific combination - real NSApplication +
# `open` launch + NSAppleEventsUsageDescription in Info.plist - is what
# actually gets macOS to track this as its own distinct, prompted
# Automation permission entry; see olat-finder-helper.swift and CLAUDE.md
# for what was tried and ruled out before landing here. `open` doesn't
# forward the launched app's stdout to the caller, so the result comes
# back via a throwaway output file instead.
call_finder_helper() {
    local cmd="$1" arg="$2" outfile result
    outfile=$(mktemp "${TMPDIR:-/tmp}/olat-finder-helper.XXXXXX")
    open -W -a "$HELPER_APP" --args "$cmd" "$arg" "$outfile" 2>&1
    result=$(cat "$outfile" 2>/dev/null)
    rm -f "$outfile"
    echo "$result"
}

eject_webdav() {
    if [[ ! -d "$HELPER_APP" ]]; then
        echo "ERROR: OLATFinderHelper.app not built (see log)"
        return 1
    fi
    call_finder_helper eject "$SERVER"
}

# finder_window_open_on_webdav - true if any open Finder window is currently
# browsing the WebDAV volume. Used to defer auto-eject while you're actively
# looking at it, rather than yanking it out from under you. Fails open (i.e.
# returns false / "no window open") if the helper can't tell, e.g. it isn't
# built yet or lacks Automation permission.
finder_window_open_on_webdav() {
    [[ -d "$HELPER_APP" ]] || return 1
    local count
    count=$(call_finder_helper check-window "$WEBDAV_PREFIX")
    [[ -n $count && $count -gt 0 ]]
}

# log_line <message> - appends a timestamped line to LOG_FILE, keeping it
# under LOG_MAX_BYTES by dropping older content once it grows past the cap.
log_line() {
    if [[ -f "$LOG_FILE" ]]; then
        local size
        size=$(stat -f%z "$LOG_FILE" 2>/dev/null || echo 0)
        if (( size > LOG_MAX_BYTES )); then
            tail -c $((LOG_MAX_BYTES / 2)) "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null \
                && mv "$LOG_FILE.tmp" "$LOG_FILE"
        fi
    fi
    echo "$(date '+%Y-%m-%d %H:%M:%S')  $1" >> "$LOG_FILE"
}

# ensure_idle_agent - installs/reloads the per-user LaunchAgent that ejects
# the WebDAV volume after idle_disconnect_minutes of inactivity, and
# (re)installs it whenever idle_poll_minutes changes in config.yml. Safe to
# call on every olatTransfer.sh run; it's a no-op if nothing changed and the
# agent is already loaded.
ensure_idle_agent() {
    local poll_minutes interval_secs checker_script needs_write=1

    poll_minutes=$(read_config_value idle_poll_minutes 5)
    interval_secs=$((poll_minutes * 60))
    checker_script="$SCRIPT_DIR/olat-idle-eject-check.sh"

    if [[ -f "$AGENT_PLIST" ]] && grep -q "<integer>$interval_secs</integer>" "$AGENT_PLIST" 2>/dev/null; then
        needs_write=0
    fi

    if [[ $needs_write -eq 1 ]]; then
        mkdir -p "$HOME/Library/LaunchAgents"
        cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$AGENT_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$checker_script</string>
    </array>
    <key>StartInterval</key>
    <integer>$interval_secs</integer>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
</dict>
</plist>
PLIST
        launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1
        launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" >/dev/null 2>&1
        log_line "Idle-eject agent (re)installed: poll every ${poll_minutes} min."
    elif ! launchctl print "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1; then
        launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" >/dev/null 2>&1
        log_line "Idle-eject agent reloaded (was not running)."
    fi
}
