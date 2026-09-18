# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single macOS Bash script (`olatTransfer.sh`) that syncs files between a local
directory and UZH OLAT's WebDAV course-folder storage, using `rsync` over a
Finder-mounted WebDAV volume. `config.yml` holds the one tunable setting
(quick-push lookback window). There is no build system, package manifest,
linter, or test suite — this is the entire project.

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
   connection-rate limiting from repeated mount/unmount cycles.

When modifying behavior, preserve this stage order and the "leave mounted by
default" / "exit early on failure" / "quick mode never deletes" conventions
— they're intentional, not incidental.
