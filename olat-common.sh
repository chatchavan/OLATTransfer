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

# ensure_finder_helper - (re)compiles OLATFinderHelper.app from
# olat-finder-helper.swift into a minimal .app bundle in STATE_DIR, so
# macOS's Automation permission for controlling Finder is granted to this
# specific tool rather than to the generic /bin/bash binary (which would
# otherwise cover every bash script on the machine). A no-op unless the
# compiled binary is missing or older than the source. Requires the Xcode
# Command Line Tools (swiftc); if that's unavailable, eject_webdav and
# finder_window_open_on_webdav degrade gracefully (see below), they don't
# block a transfer from completing.
ensure_finder_helper() {
    if [[ -x "$HELPER_APP_EXE" && "$HELPER_SOURCE" -ot "$HELPER_APP_EXE" ]]; then
        return
    fi
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
</dict>
</plist>
PLIST

    codesign --sign - --force "$HELPER_APP" >/dev/null 2>&1
    log_line "Compiled OLATFinderHelper.app (fresh build or source changed)."
}

eject_webdav() {
    if [[ ! -x "$HELPER_APP_EXE" ]]; then
        echo "ERROR: OLATFinderHelper.app not built (see log)"
        return 1
    fi
    "$HELPER_APP_EXE" eject "$SERVER" 2>&1
}

# finder_window_open_on_webdav - true if any open Finder window is currently
# browsing the WebDAV volume. Used to defer auto-eject while you're actively
# looking at it, rather than yanking it out from under you. Fails open (i.e.
# returns false / "no window open") if the helper can't tell, e.g. it isn't
# built yet or lacks Automation permission.
finder_window_open_on_webdav() {
    [[ -x "$HELPER_APP_EXE" ]] || return 1
    local count
    count=$("$HELPER_APP_EXE" check-window "$WEBDAV_PREFIX" 2>/dev/null)
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
