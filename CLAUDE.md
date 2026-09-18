# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A macOS Bash tool that syncs files between a local directory and UZH OLAT's
WebDAV course-folder storage, using `rsync` over a Finder-mounted WebDAV
volume:

- `olatTransfer.sh` — the entry point, run directly or via a `.command` file.
- `olat-common.sh` — shared helpers (config reading, the idle-eject
  LaunchAgent, logging), sourced by both `olatTransfer.sh` and
  `olat-idle-eject-check.sh`. Not meant to be run directly.
- `olat-idle-eject-check.sh` — invoked periodically by a self-installed
  LaunchAgent to auto-disconnect an idle WebDAV connection (see below). Not
  meant to be run manually, though it's harmless to do so.
- `config.yml` — the only tunable settings (quick-push lookback window,
  idle-disconnect timing).

There is no build system, package manifest, linter, or test suite — this is
the entire project.

rsync here is **macOS's built-in `openrsync`** (BSD, protocol 29), not GNU
rsync — it has no `--update`/`-u` flag. Don't assume GNU-rsync flags are
available; check `rsync --help` on the target machine first.

## Running / testing changes

There are no automated tests. To verify a change, run the script directly
against a real (or test) OLAT WebDAV path, e.g.:

```
./olatTransfer.sh [-d] [-q] <source> <destination>
```

`example-download.command`, `example-upload.command`, and
`example-quick-upload.command` are personal, machine-specific wrapper
scripts (hardcoded absolute paths under a specific user's home directory)
used to double-click-run common transfers from Finder — they are templates
meant to be copied and adjusted per course, not run as-is or generalized
into a single parameterized script (each course gets its own `.command`
pair, intentionally — see "Quick push" below).

Manual checks worth doing after editing `olatTransfer.sh`:
- `bash -n olatTransfer.sh` to catch syntax errors.
- Run both an upload (local → `/Volumes/lms.uzh.ch/...`) and a download
  (`/Volumes/lms.uzh.ch/...` → local) since direction is auto-detected from
  which argument has the WebDAV prefix, and each path uses different rsync
  flags (see below).
- For `-q` changes, the top-level-folder selection logic can be exercised
  against plain local directories (no WebDAV mount needed) by copying just
  the `for dir in "$SRC"/*/; do ... done` loop into a throwaway script —
  that's how the selection logic was validated during development, since
  mounting real WebDAV isn't needed to test folder/mtime filtering.
- For idle-eject changes, test `ensure_idle_agent` and the checker script
  in isolation rather than against the real LaunchAgent/mount: override
  `HOME` to a scratch directory (redirects `STATE_DIR`/`LOG_DIR`/
  `AGENT_PLIST` without touching `~/Library`), override `AGENT_LABEL` to a
  distinct test label (e.g. `com.local.olattransfer-test.idle-eject`), and
  override `CONFIG_FILE`/`SERVER`/`WEBDAV_PREFIX` as needed to point at
  scratch files instead of the real config or a real mount — all of these
  are plain shell variables set in `olat-common.sh` and can be reassigned
  after sourcing it, before calling a function. This was how the feature
  was validated without ever touching the real `~/Library/LaunchAgents`,
  `config.yml`, or an already-live WebDAV connection during development.
  Always `launchctl bootout` and remove the test plist afterwards.

## Architecture / control flow

`olatTransfer.sh` runs as a straight-line sequence of stages; each stage
exits early (`exit 1`) on failure, so later stages can assume earlier ones
succeeded:

1. **Option/arg parsing** — `-d` (eject WebDAV at the end), `-q` (quick push,
   see below), plus exactly two positional args, source and destination.
2. **Credential lookup** — reads the OLAT WebDAV username/password from the
   macOS Keychain (item `lms.uzh.ch`) via `security find-internet-password`.
   There is no credential prompt; the Keychain entry must already exist
   (see README "Preparation").
3. **Mount** — mounts `https://user:pass@lms.uzh.ch/` as a volume via
   `osascript`/Finder (not `mount_webdav` directly), then polls for up to
   3 retries (2s apart) for `/Volumes/lms.uzh.ch` to appear.
4. **Direction detection** — whichever of source/destination starts with
   `/Volumes/lms.uzh.ch` determines `upload` vs `download`. This choice also
   picks rsync flags: uploads add `--delete` (mirror local → remote exactly);
   downloads omit it (never delete local files based on remote state).
   `-q` is rejected outright if direction resolves to `download` — quick
   push is upload-only — and forces `--delete` off even for uploads (see
   below).
5. **Transfer**:
   - Normal mode: one `rsync -av --progress --inplace --size-only
     --exclude='.*' ...` call across the whole `$SRC/` → `$DEST/` tree.
   - Quick mode (`-q`): loops over `$SRC`'s top-level subfolders, and for
     each one whose contents include a file newer than `lookback_days` ago
     (`config.yml`, read via a `grep`/`sed` one-liner — no YAML library
     dependency), runs the same rsync call scoped to just that subfolder
     (`"$dir/" "$DEST/$name/"`). Folders with nothing recently changed are
     skipped entirely, which is the whole point: it avoids rsync/WebDAV
     having to list/stat unchanged folders at all. Loose files directly
     under `$SRC` (not inside a subfolder) are never picked up by this
     loop — only files inside a subfolder trigger that subfolder's push.
   - `--size-only` is a deliberate choice in both modes (see README
     "Pragmatic choices"): OLAT's WebDAV doesn't preserve mtimes, so rsync
     falls back to comparing file size only. rsync exit code `23` is
     treated as a soft/expected warning (partial transfer, common when
     OLAT has more student folders than exist locally), not a hard
     failure — in quick mode this is tracked across all the per-folder
     rsync calls, not just one.
6. **Cleanup** — the WebDAV volume is ejected only if `-d` was passed;
   otherwise it's left mounted deliberately, to avoid tripping UZH's
   connection-rate limiting from repeated mount/unmount cycles. This is
   exactly the case the idle-eject LaunchAgent (below) exists for.

Right after the mount is confirmed (stage 3 above, before SRC/DEST
validation — a successful mount counts as "used" regardless of whether the
paths given turn out to be valid), every run also calls two functions from
`olat-common.sh`:
- `touch_last_used` — touches a shared stamp file
  (`~/Library/Application Support/OLATTransfer/last_used`). This is the
  single source of truth for "when was OLATTransfer last used," read by the
  idle checker below.
- `ensure_idle_agent` — installs/reinstalls the per-user LaunchAgent
  described next. Idempotent: a no-op unless the plist is missing, not
  loaded, or `idle_poll_minutes` in `config.yml` no longer matches the
  currently-installed interval.

When modifying behavior, preserve this stage order and the "leave mounted by
default" / "exit early on failure" / "quick mode never deletes" conventions
— they're intentional, not incidental.

## Idle auto-disconnect architecture

This is the one piece of persistent state/infrastructure in an otherwise
one-shot-script project, so it's worth understanding as its own unit:

- **`com.local.olattransfer.idle-eject`** is a per-user LaunchAgent
  (`~/Library/LaunchAgents/com.local.olattransfer.idle-eject.plist`,
  `StartInterval` = `idle_poll_minutes` from `config.yml`), generated and
  loaded by `ensure_idle_agent` (in `olat-common.sh`). It runs
  `olat-idle-eject-check.sh` on every tick. It is never installed by a
  separate setup step — the first `olatTransfer.sh` run of any kind installs
  it.
- **`olat-idle-eject-check.sh`** (the LaunchAgent's payload) does two
  checks against the shared stamp file, in order:
  1. **TTL check** — if idle time since the stamp ≥ `idle_agent_ttl_hours`
     (default 12h), it ejects the volume if still mounted, then
     `launchctl bootout`s itself and deletes its own plist. This is a
     deliberate "give up and clean up" path so the poller doesn't run
     forever once you stop using the tool; `ensure_idle_agent` reinstalls
     it automatically on your next transfer.
  2. **Idle-disconnect check** — otherwise, if the volume is mounted and
     idle time ≥ `idle_disconnect_minutes` (default 10), it attempts to
     eject. A failed eject (e.g. Finder still has the volume open) is
     logged and left for the next poll to retry — it never force-ejects.
- **Logging**: `log_line` (in `olat-common.sh`) appends timestamped entries
  to `~/Library/Logs/OLATTransfer/idle-eject.log`, truncating the file to
  roughly `LOG_MAX_BYTES / 2` (currently ~2.5 MB) whenever it exceeds
  `LOG_MAX_BYTES` (5 MB), keeping only the most recent content.
- **Known open question**: the LaunchAgent's `osascript`/Finder eject call
  runs from a background process launched by `launchd`, not from an
  interactive Terminal session. It's unverified whether this inherits the
  same macOS Automation permission (System Settings → Privacy & Security →
  Automation) that Terminal already has for the existing mount step — if
  not, every automatic eject may silently fail (logged as a normal
  "likely busy" retry) until that permission is granted separately. Check
  the log file if idle-disconnect doesn't seem to be firing.
