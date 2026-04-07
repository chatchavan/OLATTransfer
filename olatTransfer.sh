#!/usr/bin/env bash

# WebDAV credentials
SERVER="lms.uzh.ch"
WEBDAV_PREFIX="/Volumes/$SERVER"

# ------------------------------------------------------------------
# USAGE

usage() {
    echo "Usage: $(basename "$0") <source> <destination>"
    echo "  One of source or destination must begin with $WEBDAV_PREFIX"
    echo "  Upload example: $(basename "$0") \"/local/path\" \"$WEBDAV_PREFIX/remote/path\""
    echo "  Download example: $(basename "$0") \"$WEBDAV_PREFIX/remote/path\" \"/local/path\""
    exit 1
}

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

echo "Source:      $SRC"
echo "Destination: $DEST"
echo "Direction: $DIRECTION"

# ------------------------------------------------------------------
# PERFORM THE RSYNC

echo "Starting rsync------------------"

rsync -av --progress --inplace --exclude='.*' $RSYNC_EXTRA_FLAGS "$SRC/" "$DEST/"

RSYNC_EXIT=$?

if [[ $RSYNC_EXIT -ne 0 ]]; then
    echo "⚠️  rsync finished with errors (exit code $RSYNC_EXIT)."
else
    echo "✅  Transfer finished."
fi

# ------------------------------------------------------------------
# CLEAN UP

osascript -e "tell application \"Finder\" to eject \"$SERVER\""
echo "Disconnected from WebDAV."