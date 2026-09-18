#!/usr/bin/env bash
# Run periodically by the com.local.olattransfer.idle-eject LaunchAgent
# (installed/updated by ensure_idle_agent in olat-common.sh). Not meant to
# be run manually, though it's harmless to do so.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/olat-common.sh"

if [[ ! -f "$STAMP_FILE" ]]; then
    exit 0   # olatTransfer.sh has never run; nothing to do
fi

NOW=$(date +%s)
STAMP=$(stat -f%m "$STAMP_FILE")
IDLE_MINUTES=$(( (NOW - STAMP) / 60 ))

TTL_HOURS=$(read_config_value idle_agent_ttl_hours 12)
TTL_MINUTES=$((TTL_HOURS * 60))

if (( IDLE_MINUTES >= TTL_MINUTES )); then
    if [[ -d "$WEBDAV_PREFIX" ]]; then
        RESULT=$(eject_webdav)
        log_line "Idle ${IDLE_MINUTES} min (>= ${TTL_HOURS}h TTL): ejected WebDAV before self-uninstall. ($RESULT)"
    fi
    launchctl bootout "gui/$(id -u)/$AGENT_LABEL" >/dev/null 2>&1
    rm -f "$AGENT_PLIST"
    log_line "No olatTransfer.sh activity in ${TTL_HOURS}h; idle-eject agent uninstalled itself. It will reinstall on next use."
    exit 0
fi

if [[ ! -d "$WEBDAV_PREFIX" ]]; then
    exit 0   # nothing mounted right now
fi

DISCONNECT_MINUTES=$(read_config_value idle_disconnect_minutes 10)

if (( IDLE_MINUTES >= DISCONNECT_MINUTES )); then
    RESULT=$(eject_webdav)
    if [[ -d "$WEBDAV_PREFIX" ]]; then
        log_line "Idle ${IDLE_MINUTES} min (>= ${DISCONNECT_MINUTES} min): eject attempt failed, volume likely busy. Will retry next poll. ($RESULT)"
    else
        log_line "Idle ${IDLE_MINUTES} min (>= ${DISCONNECT_MINUTES} min): disconnected WebDAV."
    fi
fi
