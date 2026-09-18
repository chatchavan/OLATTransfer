# Manual test plan

There is no automated test suite (see `CLAUDE.md`). This is the manual
procedure used to validate `olatTransfer.sh` and the idle auto-disconnect
feature, and the one to re-run after touching either.

**Run all of this in your own interactive Terminal window**, not through an
agent's own sandboxed shell tool. Mounting/ejecting the WebDAV volume goes
through `osascript`/Finder Automation, and macOS grants that permission per
calling process — an agent's own sandboxed shell is a different process
than your Terminal and will fail with `-1743 Not authorized to send Apple
events to Finder` even though the real thing works fine for you.

## 1. Quick push (`-q`) folder selection

No WebDAV mount needed — this only exercises the local folder-scanning
logic.

1. Create a scratch source tree with a couple of subfolders, one with an
   old file and one with a fresh one:
   ```bash
   mkdir -p /tmp/qp-test/{old-topic,new-topic,dest}
   touch -t 202001010000 /tmp/qp-test/old-topic/handout.pdf
   touch /tmp/qp-test/new-topic/slides.pdf
   ```
2. Copy just the selection loop out of `olatTransfer.sh` (the
   `for dir in "$SRC"/*/; do ... done` block) into a throwaway script
   pointed at `/tmp/qp-test/{old-topic,new-topic}` → `/tmp/qp-test/dest`,
   or read through the loop by eye against these two folders.
3. Expect: only `new-topic` is selected/copied; `old-topic` and any hidden
   folders are skipped.

## 2. Idle auto-disconnect

### 2.1 Trigger self-install

Run against a source that doesn't exist, so nothing actually transfers —
this only needs to get as far as a successful mount:

```bash
bash /Users/chat/local_git/OLATTransfer/olatTransfer.sh "/tmp/does-not-exist" "/Volumes/lms.uzh.ch"
```

Expect it to fail at `❌ Source directory not found` — that's fine, the
mount (and the stamp-touch + agent-install it triggers) already happened
before that check.

### 2.2 Verify the agent installed and is loaded

```bash
launchctl print "gui/$(id -u)/com.local.olattransfer.idle-eject" | grep -E "run interval|state"
cat ~/Library/LaunchAgents/com.local.olattransfer.idle-eject.plist
stat -f "%Sm  %N" "$HOME/Library/Application Support/OLATTransfer/last_used"
```

Expect a `run interval` matching `idle_poll_minutes * 60` from
`config.yml`, and a recent stamp-file mtime.

### 2.3 Fast end-to-end idle-disconnect test

Temporarily shrink the thresholds so you don't have to wait 10+ minutes:

```bash
cd /Users/chat/local_git/OLATTransfer
sed -i '' -E 's/^idle_disconnect_minutes:.*/idle_disconnect_minutes: 1/; s/^idle_poll_minutes:.*/idle_poll_minutes: 1/' config.yml
```

Re-run step 2.1's command once more so `ensure_idle_agent` picks up the new
poll interval and reinstalls:

```bash
bash /Users/chat/local_git/OLATTransfer/olatTransfer.sh "/tmp/does-not-exist" "/Volumes/lms.uzh.ch"
launchctl print "gui/$(id -u)/com.local.olattransfer.idle-eject" | grep "run interval"
```

Wait ~2–3 minutes without touching the script again, then check:

```bash
mount | grep lms.uzh.ch
cat ~/Library/Logs/OLATTransfer/idle-eject.log
```

Expect `mount` to print nothing (disconnected), and the log to end with
`Idle N min (>= 1 min): disconnected WebDAV.`

### 2.4 Reuse restarts the countdown

Run step 2.1's command again, then run it a second time *before* the
disconnect threshold elapses. Expect (via `mount` and log timestamps) that
disconnect happens ~1 minute after the *second* run, not the first.

### 2.5 Finder-window-open protection

1. With the volume mounted, open a Finder window on it and leave it open.
2. Wait for the idle threshold to pass.
3. Check the log:
   ```bash
   tail -5 ~/Library/Logs/OLATTransfer/idle-eject.log
   ```
   Expect `Idle N min (>= ... min) but a Finder window is open on the
   volume; skipping eject, will retry next poll.` — the volume and window
   should stay put while the window remains open.
4. Close the Finder window and wait one more poll interval. Expect it to
   disconnect normally on the next check.

**If this ever regresses** (the volume gets disconnected/the window closes
despite being open), the fastest way to debug is running the check's
AppleScript directly with logging, while the window is open:

```bash
osascript <<'APPLESCRIPT'
tell application "Finder"
    set n to 0
    set winCount to count of windows
    repeat with i from 1 to winCount
        try
            set p to POSIX path of ((target of window i) as alias)
            log p
            if p starts with "/Volumes/lms.uzh.ch" then set n to n + 1
        on error errMsg
            log "ERROR: " & errMsg
        end try
    end repeat
    return n
end tell
APPLESCRIPT
```

This should print the resolved POSIX path of each open Finder window (or a
caught error for windows that don't resolve, which is normal) and end with
a count ≥ 1 if a window is open on the volume. A past bug here: iterating
with `repeat with w in windows` instead of by index made every window
throw `Can't make «class fvtg» ... into type alias`, silently swallowed by
the `try`, so the check always reported "no window open." If you see that
error pattern again, check `finder_window_open_on_webdav` in
`olat-common.sh` is still iterating by index (`target of window i`), not
`repeat with w in windows`.

### 2.6 TTL self-uninstall

```bash
cd /Users/chat/local_git/OLATTransfer
sed -i '' -E 's/^idle_agent_ttl_hours:.*/idle_agent_ttl_hours: 0/' config.yml
bash /Users/chat/local_git/OLATTransfer/olatTransfer.sh "/tmp/does-not-exist" "/Volumes/lms.uzh.ch"
```

Wait one poll interval (`idle_poll_minutes` from `config.yml`, currently
still whatever step 2.3 left it at), then check:

```bash
ls ~/Library/LaunchAgents/com.local.olattransfer.idle-eject.plist
launchctl print "gui/$(id -u)/com.local.olattransfer.idle-eject"
tail -3 ~/Library/Logs/OLATTransfer/idle-eject.log
```

Expect: `ls` reports no such file, `launchctl print` reports "could not
find service," and the log ends with `...idle-eject agent uninstalled
itself. It will reinstall on next use.`

Then confirm it reinstalls automatically:

```bash
bash /Users/chat/local_git/OLATTransfer/olatTransfer.sh "/tmp/does-not-exist" "/Volumes/lms.uzh.ch"
launchctl print "gui/$(id -u)/com.local.olattransfer.idle-eject" | grep "run interval"
```

**Past bug here**: the self-uninstall code used to run `launchctl bootout`
*before* deleting its own plist and logging the uninstall. Since this
script is itself that job's running invocation, bootout-ing it terminated
the process immediately, so the plist deletion and final log line silently
never ran (the eject beforehand still succeeded and got logged, making it
look like it worked). If a future edit reintroduces this, symptom is: the
"ejected WebDAV before self-uninstall" log line appears but the plist file
never actually goes away. Fix is to keep file cleanup + logging before
`launchctl bootout`, not after.

### 2.7 Cleanup — restore real config values

```bash
cd /Users/chat/local_git/OLATTransfer
git checkout config.yml
bash /Users/chat/local_git/OLATTransfer/olatTransfer.sh "/tmp/does-not-exist" "/Volumes/lms.uzh.ch"
```

The last run picks up the real `idle_poll_minutes: 5` /
`idle_disconnect_minutes: 10` / `idle_agent_ttl_hours: 12` and reinstalls
the agent with those.
