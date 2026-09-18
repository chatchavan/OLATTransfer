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

eject_webdav() {
    osascript -e "tell application \"Finder\" to eject \"$SERVER\"" 2>&1
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
