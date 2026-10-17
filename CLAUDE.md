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
- `olat-finder-helper.swift` — source for a minimal helper app, compiled
  automatically (see `ensure_finder_helper` below) so the Finder-automation
  calls have their own specific macOS Automation permission entry instead
  of a generic one shared by every bash script on the machine. Not meant to
  be run directly (it's not even executable as a script — it's compiled).
- `tests/pattern-offline.sh` — the one automated test: exercises `-m`/`-n`
  and the `-q`/plain regressions against scratch trees with the
  Keychain/mount stage cut out (see "Running / testing changes"). Run it
  with `/bin/bash`, the same bash 3.2 the tool runs under.
- `gui/` — **Rsync pattern maker**, a self-contained Electron app (own
  `package.json`, shared Electron binary, no bundler) that generates and
  previews `.command` files for `-m` transfers. Start with
  `Ω run rsync-pattern-maker.command`. It never transfers anything itself: Run/Dry-run
  spawn `olatTransfer.sh`, and the live preview feeds the real
  `build_pattern_filters` arguments to a local `rsync -n`. Design:
  `docs-dev/rsync-pattern-maker-gui.md`. Tests: `cd gui && npm test`
  (`node --test`, real bash/rsync, no WebDAV). It used to be called "OLAT
  Command Maker": the package name `olat-command-maker` (it sets the
  settings folder in `~/Library/Application Support`) and the
  `# olat-command-maker: v1` marker in generated files keep the old name
  on purpose, so saved settings and existing `.command` files still work.
- `config.yml` — the only tunable settings (quick-push lookback window,
  idle-disconnect timing).

The Bash tool itself has no build system, package manifest, or linter. Its
automated test is `tests/pattern-offline.sh`; everything involving the real
WebDAV mount is manual (`TESTS.md`, `docs-dev/webdav-test-plan.md`). The GUI
in `gui/` is the only place with a `package.json` and has its own tests
(`cd gui && npm test`). If you change `build_pattern_filters`,
`validate_pattern` or the `-m/-n/-s/-d` options, run both suites: the GUI
tests call the real functions in `olat-common.sh` and rebuild the `.command`
format.

rsync here is **macOS's built-in `openrsync`** (BSD, protocol 29), not GNU
rsync — it has no `--update`/`-u` flag. Don't assume GNU-rsync flags are
available; check `rsync --help` on the target machine first.

## Running / testing changes

Run `/bin/bash tests/pattern-offline.sh` after touching option parsing,
the rsync calls, or `build_pattern_filters`/`validate_pattern`. It needs no
WebDAV. Otherwise `TESTS.md` is the step-by-step manual test
plan (quick push folder selection, and the full idle auto-disconnect
sequence including the Finder-window and TTL self-uninstall cases) — run
through it after touching `olatTransfer.sh`, `olat-common.sh`, or
`olat-idle-eject-check.sh`, and read it first if you hit an idle-eject bug,
since it documents two past ones (an AppleScript window-iteration bug and a
self-referential `launchctl bootout` ordering bug) and how to tell if
they've resurfaced. To verify a change ad hoc, run the script directly
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
   see below), `-s` (opt-in cleanup of `._` sidecars after an upload, see
   "Known quirks"), `-n` (dry run: `rsync -n`, summary says "Would ..."), `-m
   <pattern>` (repeatable, see "Pattern mode" below), plus exactly two
   positional args, source and destination. `-m`/`-q` conflicts and bad
   patterns (`validate_pattern`) are rejected right here, before the
   Keychain/mount, so they fail fast and can be tested offline.
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
   - Normal mode: one `rsync -avi --progress --inplace --size-only
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
   - `-i`/`--itemize-changes` (added alongside `-av`) makes each rsync call
     still stream its normal output live via `tee` into a per-call temp
     log, which is then parsed back out (grep for the `<f`/`>f`
     itemize-code lines, `*deleting ` lines) into `TRANSFERRED_FILES`/
     `DELETED_FILES` arrays and printed as a summary ("Uploaded N file(s):"
     / "Downloaded N file(s):", plus a "Deleted N file(s):" section when
     `--delete` removed anything) after the transfer finishes. In quick
     mode, `extract_rsync_summary` is called once per per-folder rsync
     invocation with that folder's name as a prefix (`"$name/"`) — this
     disambiguates identically-named files across different top-level
     folders, since each quick-mode rsync call only sees one subfolder's
     relative paths. `PIPESTATUS[0]` (not `$?`) is used to capture rsync's
     own exit code through the `tee` pipe — this requires the `bash`
     shebang (macOS's default `/bin/bash` 3.2 has `PIPESTATUS` but not
     `mapfile`/`readarray`, which is why the summary arrays are built with
     `while read` loops instead).
   - Pattern mode (`-m`): same single rsync call as normal mode, plus the
     arguments from `build_pattern_filters` (in `olat-common.sh`): `-m`
     (`--prune-empty-dirs`), then anchored `--include` rules per pattern
     level and a final `--exclude='*'`. The existing `--exclude='.*'` must
     stay BEFORE them (first match wins). `--delete` is forced off (as in
     `-q`). Anchored rules are used so rsync only enters folders that can
     lead to a match; an unanchored `--include='*/'` would walk and list the
     entire tree (still correct, much slower over WebDAV) and is only used
     for patterns containing `**`. Names are matched byte-for-byte, so an
     NFC-typed literal does not match an NFD-named folder (confirmed on the
     real WebDAV mount too, which stores both forms as separate entries),
     and `?` matches one byte, not one character (an NFC `ü` needs `??`).
     Use `*` for non-ASCII letters.
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
     (default 12h), it ejects the volume if still mounted, deletes its own
     plist and logs that, and *then* runs `launchctl bootout` on itself.
     This order is deliberate and load-bearing: this script is itself the
     running invocation of that LaunchAgent job, and bootout-ing the job
     that is currently executing appears to terminate the process
     immediately — confirmed by testing, where `rm -f "$AGENT_PLIST"` and
     the following `log_line` silently never ran when `bootout` came
     first, even though the eject before it had already succeeded and
     logged. `bootout` only needs the job's label, not the plist file on
     disk, so doing the file cleanup and logging first and bootout last is
     safe either way — keep it in that order if you touch this. This is a
     deliberate "give up and clean up" path so the poller doesn't run
     forever once you stop using the tool; `ensure_idle_agent` reinstalls
     it automatically on your next transfer.
  2. **Idle-disconnect check** — otherwise, if the volume is mounted and
     idle time ≥ `idle_disconnect_minutes` (default 10), it attempts to
     eject.
  Both checks call `finder_window_open_on_webdav` (in `olat-common.sh`)
  first and skip the eject/uninstall for that cycle (deferring to the next
  poll) if a Finder window is currently browsing the volume — see "Known
  limitation" below for why this check exists. If the eject itself still
  fails for some other reason, that's likewise logged and left for the next
  poll to retry — it never force-ejects.
- **Logging**: `log_line` (in `olat-common.sh`) appends timestamped entries
  to `~/Library/Logs/OLATTransfer/idle-eject.log`, truncating the file to
  roughly `LOG_MAX_BYTES / 2` (currently ~2.5 MB) whenever it exceeds
  `LOG_MAX_BYTES` (5 MB), keeping only the most recent content.
- **Known limitation, confirmed by manual testing**: "used" only means "ran
  `olatTransfer.sh`" (`touch_last_used`) — it does not mean "the volume is
  mounted" or "someone is browsing it." If the agent ejects the volume and
  you then reopen it directly in Finder (e.g. clicking the sidebar
  favorite) without running a transfer, Finder silently remounts it but the
  stamp file is untouched, so the idle countdown is still counting from the
  old stamp and can eject it again almost immediately. `finder_window_open_
  on_webdav` (added after this was observed) prevents that specific
  ejection from happening while a Finder window is actually open on it, but
  it doesn't reset the countdown — once you close that window, the stale
  countdown is still ticking.
- `eject_webdav` and `finder_window_open_on_webdav` call out to
  `OLATFinderHelper.app` (see "Finder helper app" below) rather than
  calling `osascript` directly — see that section for why. If you ever see
  repeated `-1743 Not authorized to send Apple events to Finder` in the
  log, check **System Settings → Privacy & Security → Automation** for the
  **OLATFinderHelper** entry specifically (not Terminal or bash).
- **AppleScript gotcha to avoid re-introducing**: `finder_window_open_on_
  webdav`'s first version iterated with `repeat with w in windows` and then
  read `target of w`. That pattern binds `w` as an unresolved reference
  chain (`item i of every window of application "Finder"`), and asking
  Finder for `target of` that reference throws `Can't make «class fvtg» ...
  into type alias` for every window — a silent false negative here, since
  it's wrapped in `try`. The fix is to iterate by index and reference the
  window directly (`target of window i`), which resolves properly. Found by
  manually re-running the check with `log p` / `on error errMsg` added
  while a real Finder window was open on the volume, since this can't be
  reproduced from a permission-less shell (it never gets far enough to hit
  this bug) or without a real Finder window to iterate. If you touch this
  AppleScript again, keep the by-index form.

## Finder helper app (`OLATFinderHelper.app`)

macOS's Automation permission (System Settings → Privacy & Security →
Automation) is granted per requesting *executable/bundle*, not per script.
Originally `eject_webdav` and `finder_window_open_on_webdav` called
`osascript` directly, so the resulting permission entry was the generic
`/bin/bash` binary — shared by every bash script on the machine, not
specific to this project. `olat-finder-helper.swift` + `ensure_finder_helper`
(both in `olat-common.sh`) exist to give this project its own specific
entry instead:

- `ensure_finder_helper` compiles `olat-finder-helper.swift` with `swiftc`
  into `$STATE_DIR/OLATFinderHelper.app` (a hand-built bundle:
  `Contents/Info.plist` + `Contents/MacOS/OLATFinderHelper`). The compile
  step is a no-op unless the binary is missing or older than the source.
  Called from `olatTransfer.sh` right alongside
  `touch_last_used`/`ensure_idle_agent`, so it self-installs the same way.
  If `swiftc` isn't available (Xcode Command Line Tools not installed), it
  logs a warning and leaves the transfer itself unaffected — only the
  idle-eject Finder checks degrade (fail open/no-op).
- **Getting a real, distinct, prompted, persisted Automation entry took
  three things together** — confirmed by extensive live testing (querying
  `~/Library/Application Support/com.apple.TCC/TCC.db` directly after each
  attempt), and dropping any one of them silently regresses to either
  "works, but invisibly rides on Terminal/bash's existing grant" or "fails
  outright with no prompt ever shown, so there's no way to grant it":
  1. **A real `NSApplication` with an actual run loop** — `olat-finder-
     helper.swift` imports `Cocoa`, not just `Foundation`. A plain
     command-line-style Foundation binary (tried first) has its Apple
     Events attributed to whatever process invoked it (bash, Terminal)
     instead of being tracked as its own identity, *no matter how it's
     signed or launched* — confirmed by testing ad-hoc vs. a real
     certificate, and direct-exec vs. `open -a`, in every combination.
  2. **Launched via `open` (LaunchServices), not a direct exec** of
     `Contents/MacOS/OLATFinderHelper`. This is why `call_finder_helper`
     (in `olat-common.sh`) uses `open -W -a "$HELPER_APP" --args ...`
     instead of invoking the binary path directly. `open` doesn't forward
     the launched app's stdout to the caller, so the result comes back via
     a throwaway output file (the third `--args` element) that
     `call_finder_helper` reads and deletes afterward; `-W` makes `open`
     block until the app quits, keeping the call synchronous.
  3. **`NSAppleEventsUsageDescription` in Info.plist.** Without it, a
     request from an otherwise-correct real `NSApplication` launched via
     `open` is *silently auto-denied* (`-1743`) with **no prompt shown at
     all** — confirmed live, from an interactive Terminal session, not
     just from a permission-less shell. It's not that nobody can see the
     dialog; it's that no dialog is ever generated without this key.
  Only once all three were true did a real System Settings dialog appear
  and a genuine `com.local.olattransfer.finderhelper|2|com.apple.finder`
  row show up in `TCC.db`.
- **A local self-signed code-signing certificate is also required** —
  ad-hoc signing (`codesign --sign -`, no Team ID, hash changes every
  rebuild) doesn't get a stable identity at all, distinct-entry-eligible or
  not. `ensure_signing_identity` (in `olat-common.sh`) generates one
  (`$CODESIGN_IDENTITY_CN`, "OLATFinderHelper Local Signing") via `openssl`
  and imports it into the login keychain — safe and non-interactive.
  `ensure_finder_helper` then tries `codesign --sign "$CODESIGN_IDENTITY_CN"`
  on *every* call (not just on rebuild, so completing the trust step below
  takes effect immediately), falling back to ad-hoc if that identity isn't
  trusted yet. **Setting the certificate's trust for code signing cannot be
  scripted**: `security add-trusted-cert` hangs waiting for an interactive
  approval dialog that can't be answered non-interactively (confirmed by
  testing — it hangs, doesn't error). It's a one-time manual step for the
  human running this: Keychain Access → login keychain → My Certificates →
  find the cert → Trust → Code Signing → Always Trust (see README). Until
  that's done, the helper stays ad-hoc signed and works correctly, just
  without its own trackable identity.
- **Two other approaches were tried and rejected** before landing here:
  - A compiled AppleScript "applet" (via `osacompile`) — run directly as
    `Contents/MacOS/applet <args>` instead of via `open -a ... --args`, it
    never exits (confirmed hanging indefinitely, unrelated to Finder
    permissions — even a command that never touches Finder hung) and argv
    arrives broken (`Can't make item 1 into type Unicode text`).
  - A plain `Foundation`-only Swift binary (no Cocoa), direct-exec or
    `open -a`, ad-hoc or properly signed — always "worked" by silently
    riding whatever ancestor process's existing grant, never its own
    tracked entry. This is why AppKit/`NSApplication` turned out to be
    necessary, not optional, despite adding back some of the app-lifecycle
    weight the `osacompile` rejection was trying to avoid.
- Interface: `OLATFinderHelper <eject|check-window> <arg> <output-file>` —
  `eject` ejects the named server (`eject_webdav` passes `$SERVER`),
  `check-window` prints the count of open Finder windows whose target path
  starts with the given prefix (`finder_window_open_on_webdav` passes
  `$WEBDAV_PREFIX`) to `<output-file>`, then calls `NSApp.terminate(nil)` —
  it never stays running. Both build the actual AppleScript source string
  in Swift and run it via `NSAppleScript.executeAndReturnError`.
- Deliberately scoped to only these two background/LaunchAgent-invoked
  calls. `olatTransfer.sh`'s own interactive `mount volume` AppleScript
  call still uses `osascript` directly under Terminal's existing
  Automation grant — that one wasn't the thing flagged as too broad, and
  narrowing it further wasn't asked for.

## Known quirks seen on the real mount (2026-10-10, pattern-mode testing)

- **AppleDouble sidecars (`._name`)**: the WebDAV client can't store an
  extended attribute on the server, so whenever a process that carries
  `com.apple.provenance` (this agent's shell, the Claude app's terminal panel,
  Terminal windows they open; NOT a plain user Terminal) creates OR updates an
  item on the mount, the client writes a `._<name>` file beside it with that
  attribute inside. Visible on OLAT to everyone who sees the folder. Findings
  (2026-10-10, real mount):
  - Creation triggers it, even a plain `printf > file` or `mkdir`.
  - **Setting times or permissions triggers it too.** rsync `-a` asks for both
    on every item on every run (OLAT never keeps them, so every run shows
    `.f..tp...`), so re-running an upload with nothing to send still created
    sidecars. Experiment with raw rsync on fresh items: `-a`, `-rt` and `-rp`
    each created sidecars for the file and its folder; `-rl` created none,
    and none appeared 25 s later.
  - `xattr -c` can't remove provenance; no rsync flag or documented
    `mount_webdav` option turns the behaviour off; `--exclude='.*'` only stops
    LOCAL `._` files being sent (they never were).
  Two-part fix in `olatTransfer.sh`: (1) **uploads use `-rlvi`, not `-avi`**,
  so no time/permission updates are requested (`--size-only` decides what to
  send, so nothing is lost); downloads keep `-avi`. (2) For genuinely new
  items (creation can't be avoided), **only if `-s` is given** (off by
  default, by decision: it deletes files on the server and isn't needed from a
  plain Terminal), `remove_upload_sidecars` (`olat-common.sh`) deletes, after
  a real upload only, the `._<basename>` of
  each item that run uploaded (`TRANSFERRED_FILES`) or created
  (`CREATED_DIRS`, from `cd+++` itemize lines; in `-q` mode also the new
  top-level folder), only if that item exists and the sidecar is a regular
  file. No globbing: pre-existing `._` files and sidecars of untouched items
  are left alone. It prints "Removed N ..." only when it deleted something.
  Do not switch uploads back to `-a`. Alternative if this proves
  insufficient: upload with `curl -T` straight to the WebDAV URL, bypassing
  the mount.
- **Failed items still appear in the summary**: if rsync aborts partway
  (e.g. a name OLAT refuses, such as one containing a backslash),
  "Uploaded N file(s)" is built from the itemize lines, which are printed
  before the transfer of that file fails, so it can list files that were not
  actually written. The `⚠️ rsync finished with errors` line is the reliable
  signal. Not fixed yet.
- **A folder missing on OLAT gets created**: with `-m` (and in normal mode)
  an upload of `Zzz, New/Coach Return Box/a1.1/...` creates the participant
  folder `Zzz, New` on OLAT. Use `-n` first.
- OLAT/WebDAV refuses a backslash in names; it accepts `, [ ] * ? ' &` and
  accented letters.
