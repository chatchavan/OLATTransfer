#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/olat-common.sh"

# ------------------------------------------------------------------
# USAGE

usage() {
    echo "Usage: $(basename "$0") [-d] [-q] <source> <destination>"
    echo "  One of source or destination must begin with $WEBDAV_PREFIX"
    echo "  Upload example: $(basename "$0") \"/local/path\" \"$WEBDAV_PREFIX/remote/path\""
    echo "  Download example: $(basename "$0") \"$WEBDAV_PREFIX/remote/path\" \"/local/path\""
    echo "  -d   Execute the final 'eject' and status message."
    echo "  -q   Quick push (upload only): only sync top-level source folders that"
    echo "       contain a file changed within the lookback window. Never deletes"
    echo "       remote files/folders; run a normal upload for that. Lookback window"
    echo "       is read from $CONFIG_FILE (key: lookback_days)."
    exit 1
}

# ------------------------------------------------------------------
# OPTION PARSING -----------------------------------------------------

# default: do NOT eject at the end
DO_EJECT=0
QUICK_MODE=0

while getopts "dq" opt; do
  case $opt in
    d) DO_EJECT=1 ;;
    q) QUICK_MODE=1 ;;
    *) usage ;;          # unknown option -> show help
  esac
done

# shift the processed options out of $@ so that $1/$2 are the positional args
shift $((OPTIND - 1))

# ------------------------------------------------------------------
# PARSE ARGUMENTS

if [[ $# -ne 2 ]]; then
    usage
fi

SRC="$1"
DEST="$2"

# ------------------------------------------------------------------
# FETCH PASSWORD FROM THE KEYCHAIN

USERNAME=$(security find-internet-password -l "lms.uzh.ch" 2>/dev/null \
           | awk -F'"' '/acct/ {print $4}')

PASSWORD=$(security find-internet-password -l "$SERVER" -w)

if [[ -z $USERNAME ]]; then
    echo "❌  Unable to fetch username for \"$SERVER\" from Keychain."
    exit 1
fi

if [[ -z $PASSWORD ]]; then
    echo "❌  Unable to fetch password for \"$SERVER\" from Keychain."
    exit 1
fi
echo "Retrieved WebDAV login info from Keychain."

# ------------------------------------------------------------------
# MOUNT THE WebDAV VOLUME (via AppleScript/Finder)

osascript <<EOF
tell application "Finder"
    try
        mount volume "https://$USERNAME:$PASSWORD@$SERVER/"
    on error err
        display dialog "❌  Error mounting WebDAV: " & err buttons {"OK"} default button 1
        error err
    end try
end tell
EOF

if [[ $? -ne 0 ]]; then
    echo "❌  Failed to mount WebDAV volume. Aborting."
    exit 1
fi

# ------------------------------------------------------------------
# WAIT UNTIL THE MOUNT POINT IS AVAILABLE

MAX_RETRIES=3
RETRY_COUNT=0

while [[ ! -d "$WEBDAV_PREFIX" ]] && [[ $RETRY_COUNT -lt $MAX_RETRIES ]]; do
    sleep 2
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [[ ! -d "$WEBDAV_PREFIX" ]]; then
    echo "❌  Mount point \"$WEBDAV_PREFIX\" not found after $MAX_RETRIES attempts."
    exit 1
fi

echo "Successfully mounting the WebDAV."

touch_last_used
ensure_finder_helper
ensure_idle_agent

# ------------------------------------------------------------------
# VALIDATE SOURCE AND DESTINATION

if [[ ! -d "$SRC" ]]; then
    echo "❌  Source directory not found: $SRC"
    exit 1
fi

if [[ ! -d "$DEST" ]]; then
    echo "❌  Destination directory not found: $DEST"
    exit 1
fi

# ------------------------------------------------------------------
# DETERMINE DIRECTION

if [[ "$DEST" == "$WEBDAV_PREFIX"* ]]; then
    DIRECTION="upload"
    RSYNC_EXTRA_FLAGS="--delete"
elif [[ "$SRC" == "$WEBDAV_PREFIX"* ]]; then
    DIRECTION="download"
    RSYNC_EXTRA_FLAGS=""   # no --delete: preserve local files
else
    echo "❌  Neither source nor destination is on the WebDAV volume ($WEBDAV_PREFIX)."
    usage
fi

if [[ $QUICK_MODE -eq 1 && "$DIRECTION" != "upload" ]]; then
    echo "❌  Quick mode (-q) only supports uploads (local source -> WebDAV destination)."
    exit 1
fi

if [[ $QUICK_MODE -eq 1 ]]; then
    RSYNC_EXTRA_FLAGS=""   # quick mode never deletes; run a normal upload for that
fi

echo "Source:      $SRC"
echo "Destination: $DEST"
echo "Direction: $DIRECTION"
[[ $QUICK_MODE -eq 1 ]] && echo "Mode: quick push (recently changed top-level folders only)"

# ------------------------------------------------------------------
# PERFORM THE RSYNC

echo "Starting rsync------------------"

RSYNC_EXIT=0

if [[ $QUICK_MODE -eq 1 ]]; then
    LOOKBACK_DAYS=$(read_config_value lookback_days 14)
    SINCE=$(date -v-"${LOOKBACK_DAYS}"d '+%Y-%m-%d %H:%M:%S')
    echo "Lookback window: $LOOKBACK_DAYS day(s) (from $CONFIG_FILE)"

    CHANGED_COUNT=0

    for dir in "$SRC"/*/; do
        [[ -d "$dir" ]] || continue   # no subfolders: glob left unexpanded
        dir="${dir%/}"
        name="$(basename "$dir")"
        [[ "$name" == .* ]] && continue   # skip hidden folders, same as --exclude='.*'

        if find "$dir" -type f -not -path '*/.*' -newermt "$SINCE" -print -quit | grep -q .; then
            CHANGED_COUNT=$((CHANGED_COUNT + 1))
            echo "  -> changed: $name"
            rsync -av --progress --inplace --size-only --exclude='.*' "$dir/" "$DEST/$name/"
            code=$?
            [[ $code -ne 0 && $code -ne 23 ]] && RSYNC_EXIT=$code
            [[ $code -eq 23 && $RSYNC_EXIT -eq 0 ]] && RSYNC_EXIT=23
        fi
    done

    if [[ $CHANGED_COUNT -eq 0 ]]; then
        echo "Nothing changed in the last $LOOKBACK_DAYS day(s). Nothing to push."
    fi
else
    rsync -av --progress --inplace --size-only --exclude='.*' $RSYNC_EXTRA_FLAGS "$SRC/" "$DEST/"
    RSYNC_EXIT=$?
fi


if [[ $RSYNC_EXIT -eq 23 ]]; then
    echo "☝️ rsync exit code $RSYNC_EXIT. Some folders may not be synchronized. This is usually the case if there are more student folders on OLAT than local."
elif [[ $RSYNC_EXIT -ne 0 ]]; then
    echo "⚠️  rsync finished with errors (exit code $RSYNC_EXIT)."
else
    echo "✅  Transfer finished."
fi


# ------------------------------------------------------------------
# CLEAN UP

if [[ $DO_EJECT -eq 1 ]]; then
    eject_webdav >/dev/null
    echo "Disconnected from WebDAV."
else
    echo "WebDAV connection remains mounted."
fi
