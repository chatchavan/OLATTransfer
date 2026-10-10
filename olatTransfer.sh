#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/olat-common.sh"

# ------------------------------------------------------------------
# USAGE

usage() {
    echo "Usage: $(basename "$0") [-d] [-q] [-n] [-s] [-m <pattern>]... <source> <destination>"
    echo "  One of source or destination must begin with $WEBDAV_PREFIX"
    echo "  Upload example: $(basename "$0") \"/local/path\" \"$WEBDAV_PREFIX/remote/path\""
    echo "  Download example: $(basename "$0") \"$WEBDAV_PREFIX/remote/path\" \"/local/path\""
    echo "  -d   Execute the final 'eject' and status message."
    echo "  -q   Quick push (upload only): only sync top-level source folders that"
    echo "       contain a file changed within the lookback window. Never deletes"
    echo "       remote files/folders; run a normal upload for that. Lookback window"
    echo "       is read from $CONFIG_FILE (key: lookback_days)."
    echo "  -m   Pattern mode (upload or download): transfer only paths matching the"
    echo "       rsync-wildcard pattern, relative to the source folder, e.g."
    echo "       -m \"*/Participant Drop Box/a1.1\". Repeat -m for several patterns."
    echo "       Never deletes anything. Cannot be combined with -q."
    echo "  -n   Dry run: show what would be transferred, change nothing."
    echo "  -s   After an upload, delete the hidden ._name sidecar files that macOS's"
    echo "       WebDAV client may have created next to the files/folders just uploaded"
    echo "       (see README). Off by default; never touches other ._ files."
    exit 1
}

# ------------------------------------------------------------------
# OPTION PARSING -----------------------------------------------------

# default: do NOT eject at the end
DO_EJECT=0
QUICK_MODE=0
DRY_RUN=0
CLEAN_SIDECARS=0
PATTERNS=()

while getopts "dqnsm:" opt; do
  case $opt in
    d) DO_EJECT=1 ;;
    q) QUICK_MODE=1 ;;
    n) DRY_RUN=1 ;;
    s) CLEAN_SIDECARS=1 ;;
    m) PATTERNS+=("$OPTARG") ;;
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

# Checked before touching the Keychain/WebDAV so a bad command line fails fast.
if [[ ${#PATTERNS[@]} -gt 0 && $QUICK_MODE -eq 1 ]]; then
    echo "❌  -m (pattern mode) and -q (quick push) cannot be combined."
    exit 1
fi

for pattern in "${PATTERNS[@]}"; do
    if ! reason=$(validate_pattern "$pattern"); then
        echo "❌  Invalid -m pattern \"$pattern\": $reason."
        exit 1
    fi
done

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

# rsync's archive flag (-a) also asks to set modification times and
# permissions on every item, on every run, because OLAT's WebDAV never keeps
# them. Each such update makes the macOS WebDAV client write a hidden "._name"
# sidecar for the item (visible on OLAT) whenever the process carries
# com.apple.provenance - even when no data changed (confirmed experimentally:
# -a, -rt and -rp all create sidecars, -rl creates none). So uploads use plain
# recursive + symlinks and leave times/permissions alone; --size-only already
# decides what to send, so nothing is lost. Downloads write to a local disk
# and keep -a.
if [[ "$DIRECTION" == "upload" ]]; then
    RSYNC_FLAGS="-rlvi"
else
    RSYNC_FLAGS="-avi"
fi

# Pattern mode: restrict the transfer to the -m patterns (see
# build_pattern_filters in olat-common.sh) and never delete - same rule as -q.
RSYNC_FILTER_ARGS=()
if [[ ${#PATTERNS[@]} -gt 0 ]]; then
    RSYNC_EXTRA_FLAGS=""
    build_pattern_filters "${PATTERNS[@]}"
    RSYNC_FILTER_ARGS=("${PATTERN_FILTER_ARGS[@]}")
fi

RSYNC_DRY_ARGS=()
[[ $DRY_RUN -eq 1 ]] && RSYNC_DRY_ARGS=(-n)

echo "Source:      $SRC"
echo "Destination: $DEST"
echo "Direction: $DIRECTION"
[[ $QUICK_MODE -eq 1 ]] && echo "Mode: quick push (recently changed top-level folders only)"
if [[ ${#PATTERNS[@]} -gt 0 ]]; then
    echo "Mode: pattern (${#PATTERNS[@]} pattern(s), relative to the source folder)"
    for pattern in "${PATTERNS[@]}"; do
        echo "  -m $pattern"
    done
fi
[[ $DRY_RUN -eq 1 ]] && echo "Dry run: nothing will be transferred."

# ------------------------------------------------------------------
# PERFORM THE RSYNC

echo "Starting rsync------------------"

RSYNC_EXIT=0
TRANSFERRED_FILES=()
DELETED_FILES=()
CREATED_DIRS=()

# extract_rsync_summary <logfile> <prefix>
#
# rsync's -i (--itemize-changes) prefixes each changed regular file with an
# "<f"/">f" code (see `man rsync`); parse those lines back out of a tee'd
# log (rather than suppressing rsync's normal streaming output) and append
# them to TRANSFERRED_FILES/DELETED_FILES. <prefix> disambiguates same-named
# files across different top-level folders in quick mode.
extract_rsync_summary() {
    local log="$1" prefix="$2"

    while IFS= read -r line; do
        TRANSFERRED_FILES+=("${prefix}${line}")
    done < <(grep -E '^[<>]f' "$log" | sed -E 's/^[^[:space:]]+[[:space:]]+//')

    while IFS= read -r line; do
        DELETED_FILES+=("${prefix}${line}")
    done < <(grep '^\*deleting ' "$log" | sed 's/^\*deleting //')

    # Folders rsync created ("cd+++++++ name/"); only used to find their
    # macOS sidecars after an upload (see remove_upload_sidecars).
    while IFS= read -r line; do
        CREATED_DIRS+=("${prefix}${line}")
    done < <(grep -E '^cd' "$log" | sed -E 's/^[^[:space:]]+[[:space:]]+//')
}

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
            ITER_LOG=$(mktemp)
            # rsync doesn't itemize the top-level folder it creates, so note it
            # here for remove_upload_sidecars.
            top_dir_is_new=0
            [[ -d "$DEST/$name" ]] || top_dir_is_new=1
            rsync $RSYNC_FLAGS --progress --inplace --size-only --exclude='.*' "${RSYNC_DRY_ARGS[@]}" "$dir/" "$DEST/$name/" | tee -a "$ITER_LOG"
            code=${PIPESTATUS[0]}
            [[ $code -ne 0 && $code -ne 23 ]] && RSYNC_EXIT=$code
            [[ $code -eq 23 && $RSYNC_EXIT -eq 0 ]] && RSYNC_EXIT=23
            extract_rsync_summary "$ITER_LOG" "$name/"
            [[ $top_dir_is_new -eq 1 && -d "$DEST/$name" ]] && CREATED_DIRS+=("$name")
            rm -f "$ITER_LOG"
        fi
    done

    if [[ $CHANGED_COUNT -eq 0 ]]; then
        echo "Nothing changed in the last $LOOKBACK_DAYS day(s). Nothing to push."
    fi
else
    RSYNC_LOG=$(mktemp)
    rsync $RSYNC_FLAGS --progress --inplace --size-only --exclude='.*' "${RSYNC_FILTER_ARGS[@]}" "${RSYNC_DRY_ARGS[@]}" $RSYNC_EXTRA_FLAGS "$SRC/" "$DEST/" | tee -a "$RSYNC_LOG"
    RSYNC_EXIT=${PIPESTATUS[0]}
    extract_rsync_summary "$RSYNC_LOG" ""
    rm -f "$RSYNC_LOG"
fi


# Only with -s, and only for uploads (a download writes to a local disk, which
# keeps the attribute natively): remove the "._name" files the WebDAV client
# created next to what was just uploaded. Not on a dry run, where nothing was
# written.
if [[ $CLEAN_SIDECARS -eq 1 && "$DIRECTION" == "upload" && $DRY_RUN -eq 0 ]]; then
    SIDECARS_REMOVED=$(remove_upload_sidecars "$DEST")
    [[ $SIDECARS_REMOVED -gt 0 ]] && echo "Removed $SIDECARS_REMOVED macOS sidecar file(s) (._*) that the WebDAV client created for the uploaded items."
fi

if [[ $RSYNC_EXIT -eq 23 ]]; then
    echo "☝️ rsync exit code $RSYNC_EXIT. Some folders may not be synchronized. This is usually the case if there are more student folders on OLAT than local."
elif [[ $RSYNC_EXIT -ne 0 ]]; then
    echo "⚠️  rsync finished with errors (exit code $RSYNC_EXIT)."
else
    echo "✅  Transfer finished."
fi

# ------------------------------------------------------------------
# SUMMARIZE TRANSFERRED FILES

VERB="Uploaded"
[[ "$DIRECTION" == "download" ]] && VERB="Downloaded"
if [[ $DRY_RUN -eq 1 ]]; then
    VERB="Would upload"
    [[ "$DIRECTION" == "download" ]] && VERB="Would download"
fi

echo ""
echo "$VERB ${#TRANSFERRED_FILES[@]} file(s):"
for f in "${TRANSFERRED_FILES[@]}"; do
    echo "  $f"
done

if [[ ${#DELETED_FILES[@]} -gt 0 ]]; then
    echo "$( [[ $DRY_RUN -eq 1 ]] && echo "Would delete" || echo "Deleted" ) ${#DELETED_FILES[@]} file(s):"
    for f in "${DELETED_FILES[@]}"; do
        echo "  $f"
    done
fi


# ------------------------------------------------------------------
# CLEAN UP

if [[ $DO_EJECT -eq 1 ]]; then
    eject_webdav >/dev/null
    echo "Disconnected from WebDAV."
else
    echo "WebDAV connection remains mounted."
fi
