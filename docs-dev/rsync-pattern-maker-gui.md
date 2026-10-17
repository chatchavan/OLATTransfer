# Rsync pattern maker: design

Status: backend (`-m`, `-n`, `-s` in `olatTransfer.sh`) implemented and tested
(offline suite plus the real mount, see `docs-dev/webdav-test-plan.md`). The
GUI is built (`gui/`, see "Implementation"); UI drafts are on the Claude Design canvas
"OLAT Command Maker UI" (artboards "Two-pane layout", "Two-pane layout: upload",
"Dry-run window: download/upload", "WebDAV not mounted").

## Goal

A small GUI that produces one `.command` file per recurring transfer
"situation", e.g. "download `Participant Drop Box/a1.1` from every student in
course X's *Hand in* folder", for both download and upload. It also previews
what a pattern selects and can run the transfer. It never transfers data
itself: it always calls `olatTransfer.sh`.

Assumption: the WebDAV volume (`/Volumes/lms.uzh.ch`) is already mounted while
the GUI runs. The GUI does not mount or eject (the script does, on Run).

## Backend it builds on

`olatTransfer.sh -m <pattern> [-m …] [-n] [-s] [-d] <src> <dest>`
(`README.md`, "Pattern mode"):

- `-m` (repeatable): transfer only paths matching an rsync-wildcard pattern,
  relative to the source root; `/` separates levels, `*` never crosses `/`,
  `?` matches one **byte**, `\*` `\?` `\[` escape. `*/Participant Drop Box/a1.1`
  matches that folder for every student and everything inside it.
- The script turns each pattern into anchored rsync filters
  (`build_pattern_filters` in `olat-common.sh`), so only folders on the way to
  a match are entered and no unmatched file data is read.
- `-n` dry run, `-s` remove `._` sidecars after an upload, `-d` disconnect
  WebDAV at the end. `-m` and `-q` cannot be combined (no `-q` in the GUI).
- `--delete` is off whenever `-m` is used.

## Tech and location

- **Electron** in a self-contained `gui/` folder (own `package.json`), so the
  Bash tool keeps its "no dependencies" property. Shared Electron binary per
  the global convention. No bundler, no framework: plain JS renderer.
- Rejected: Swift/AppKit (no full Xcode here); the GUI composing `rsync`
  itself (would duplicate the filter logic and skip the mount/idle-agent
  stages).

## Principles

1. **One source of truth.** Filter building lives only in `olat-common.sh`.
   The preview runs the real filter arguments (read from
   `build_pattern_filters`) with the real `rsync -n`; Dry-run runs the real
   script with `-n`.
2. **Lazy, bounded listing.** Only list what the user opens. Never walk a
   WebDAV tree recursively without a limit (see "Tree listing rules").
3. **No secrets.** The GUI never reads the Keychain. A `.command` contains only
   paths and patterns.
4. **Keep the idle agent from ejecting mid-session.** "Used" means "ran
   `olatTransfer.sh`". The GUI calls `touch_last_used` (via
   `bash -c 'source olat-common.sh; touch_last_used'`) whenever it lists the
   volume.
5. **Do not normalise names.** Names carry the exact bytes the mount returned
   (NFC and NFD forms are separate entries and a literal only matches its own
   form; confirmed on the real mount). Typed literals with non-ASCII letters
   get a warning suggesting `*` (not `?`, which is byte-wise).

## Window layout

Two columns, status bar at the bottom.

```
┌ Rsync pattern maker ───────────────────────────────────────────────┐
│ Source [path ……………………………] [📁]   →   Destination [path ………] [📁] │
│ ┌ Source sample ─────────────┐     ┌ Preview after transfer ──────┐ │
│ │ tree (lazy, sampled)       │     │ merged tree, row colours     │ │
│ └────────────────────────────┘     └──────────────────────────────┘ │
│ Patterns        relative to the source folder          [+ Add]      │
│  1 [*/Participant Drop Box/a1.1        ] matches 5 of 5 listed [x]  │
│ ──────────────────────────────────────────────────────────────────── │
│ [📂 open .command]                              [⚙]  [▶]  [💾]      │
└─────────────────────────────────────────────────────────────────────┘
```

- Each column header is one line: label, editable path field (paste allowed),
  folder button. A folder dropped on a column sets its path. No "OLAT"/"Local"
  chips: the side is inferred from the path (`/Volumes/lms.uzh.ch…` = OLAT).
  Direction = download when the source is OLAT and the destination local,
  upload for the reverse; anything else is reported inline and Run is off.
- **No "WebDAV mounted" indicator.** The mount state shows only on failure,
  inline: when a path under `/Volumes/lms.uzh.ch` cannot be listed, that
  column's tree is replaced by "WebDAV is not mounted" with a Retry button, the
  path field gets an error border and the preview says "Nothing to preview
  until the source folder can be listed". Checked when an OLAT path is dropped,
  pasted or listed; no background polling.

### Tree listing rules

The left tree exists to design wildcards, not to browse everything.

- **OLAT source: sample, do not scan.** List only the first 5 folders of the
  source root. A grey item says "Only the first 5 of N folders are listed…; the
  pattern applies to all N".
- **Depth: 4 levels at first, then steps of 3** (below the source root: student
  = 1, Participant Drop Box = 2, a1.1 = 3, its files and folders = 4). The first
  listing goes 4 levels deep (`INITIAL_DEPTH` in `app.js`).
  A folder at the cut-off that has not been listed shows, when opened, a
  clickable item "Showing N levels deep. Click to load 3 levels deeper"; a click
  loads 3 more levels for that folder only.
- **Same path in every sampled folder.** Whenever the pattern is built from a
  folder or file (a click in the tree) or "load deeper" is used, the same
  relative path is listed in all 5 sampled folders (ancestors one level at a
  time, the clicked folder one level, or 3 levels for "load deeper"), so the
  pattern is always judged against all of them. Nothing is listed that is not
  on that path. The header dot pulses while this runs.
- **Local source: no limits.** Expanding a folder lists all its entries.
- Hidden entries (`.*`) are never shown (the script excludes them).
- **Chooser** (Literal | Any (`*`) | Custom + text field) appears only under the
  clicked row. Rows on the current example path carry a small mode tag.
- **The tree follows the patterns live**: rows matched by a pattern are
  highlighted, rows that cannot match are dimmed, folders on the way to a match
  (student, Participant Drop Box) stay normal.

- **Right click on a folder** opens a native context menu: in the source tree
  "Set as Source", in the preview tree "Set as Destination". The folder becomes
  the root of that side. Patterns are rebased for a new source: leading levels
  that equal the folder's path (same name, or `*`) are dropped, so
  `*/Participant Drop Box/a1.1` becomes `Participant Drop Box/a1.1` after
  "Set as Source" on a student folder; other patterns stay as they are.

### Patterns panel

- Compact editable rows, one `-m` each, with "matches X of N listed" (how many
  of the sampled top-level folders the pattern selects), a remove button and
  "Add pattern".
- Clicking a tree row sets the **example path** of the focused pattern row: the
  levels below the root become chips with the three modes. Default: the first
  level (the student level, which has many siblings) is Any, the rest Literal.
  Editing the text directly detaches the row from the chips.
- Literal text is escaped for rsync (`* ? [ ] \`). Names with commas, spaces or
  quotes pass through unchanged.
- Inline validation with the script's rules (`validate_pattern`: not empty, not
  absolute, no `.`/`..` level, no empty `//` level); warning for non-ASCII
  literals.

### Preview (right column)

Live, local and instant; recomputed (debounced) on every pattern or path
change.

- Build a throwaway tree of empty (sparse) files and folders from the sampled
  listing (first 5 top-level folders; for OLAT only the levels fetched), then
  run the real `rsync -n -i --size-only` with the script's filter arguments
  against it: once per pattern against an empty folder (gives each pattern's
  matches), once with all patterns against the real destination (gives what
  would transfer). Merge the result with the existing destination listing.
- **Row colour, no chips**: green = new, default background = already there,
  yellow = differs in size (same `--size-only` rule as the real run), dimmed =
  exists at the destination but the pattern does not write it. A legend of
  swatches sits in the pane header; rows carry a `title` with the status.
- Markers exist only for data actually fetched from OLAT (first 5 folders, 4
  levels at first); deeper levels show "not loaded yet" and loading deeper in
  the source tree extends the preview. The preview adds no WebDAV listing of
  its own, except for an upload, which lists the matching folders on the OLAT
  destination (bounded in the same way).
- All sampled students are shown expanded. Footer: "Based on the 5 listed
  folders of N" and a link that runs the full dry run for exact numbers.
- **Upload**: source = local folder (listed completely), destination = OLAT
  preview. Student folders missing on OLAT are green, named in a warning at the
  top ("Uploading creates N folder(s) on OLAT… Nothing on OLAT is deleted when
  patterns are used"); OLAT-only files stay visible, dimmed.

### Status bar

Left: a folder-icon button "Open existing .command…" (reads the metadata block,
fills paths, patterns and options; refuses files without it). Right: three
icon buttons.

- **Cogwheel** → menu with checkboxes: "Disconnect WebDAV when done" (`-d`, on
  by default) and "Remove macOS ._ files after upload" (`-s`, off by default,
  enabled only for uploads; hint "Only for uploads to OLAT" otherwise).
  Remembered between runs.
- **Play** → menu "Dry-run" and "Run".
  - **Dry-run opens its own window, one per dry run** (title carries the time
    and the folders, so several can stay open). It shows the command; a "Dry
    run: nothing was copied" badge and a summary ("41 matching folders · 1,203
    files · 3 students without this path"; for uploads also "N student
    folder(s) would be created on OLAT"); tabs **Matches** (one row per
    matching folder with file count, a "students without this path"
    disclosure, a warning for folders created on OLAT) and **Output** (raw
    output, selectable); footer with run time and exit code, Copy output, Run
    (runs the same command for real), Close. Dry-run adds `-n` and never `-d`
    (the volume stays mounted for browsing). All views scroll when long.
  - **Run** opens a dialog modelled on panel "5. Run" of
    `student-work-files-organizer`: Run again, Abort, Copy output, summary
    line, dark selectable output pane that starts with the command line
    (`▶ bash …`) and streams the script's output.
- **Save** → dialog with the generated `.command` text and the buttons Save
  .command (native save panel, `chmod +x`), Save & run in Terminal, Copy
  command.

## Generated `.command`

Same style as the `example-*.command` files (absolute paths, `bash` invoking
`olatTransfer.sh`), plus a metadata block so the GUI can reopen a file it wrote:

```
#!/bin/bash
# olat-command-maker: v1
# direction=download
# root=/Volumes/lms.uzh.ch/webdav/coursefolders/26HS …/Hand in
# pattern=*/Participant Drop Box/a1.1
# pattern=*/Participant Drop Box/a1.?
# disconnect=yes
bash "/Users/chat/local_git/OLATTransfer/olatTransfer.sh" \
	-d \
	-m "*/Participant Drop Box/a1.1" \
	-m "*/Participant Drop Box/a1.?" \
	"/Volumes/lms.uzh.ch/webdav/…/Hand in" \
	"/Users/chat/Desktop/a1.1"
```

- `root` is the source folder. `-d` comes first when the checkbox is on, `-s`
  after it for uploads.
- Saved with `chmod +x`. Values are shell-quoted by one tested escaping
  function (names containing `"`, `'`, `$`, backticks, backslashes, non-ASCII).
- Remembered between runs (in the app's data folder, not the repo): last
  source/destination paths, last save folder, the two checkboxes, window
  bounds.

## Implementation (`gui/`)

```
gui/main.js             windows, IPC, spawns olatTransfer.sh, dry-run windows
gui/preload.js          contextBridge: window.api (every call returns {ok,…})
gui/lib/                pure/Node modules, tested with `npm test`
  shell.js              dq() quoting + splitWords() (UMD: main and renderer)
  pattern.js            escapeLiteral, validatePattern (= validate_pattern), levels <-> pattern
  command.js            buildCommand/parseCommand (.command format), buildArgs/buildOneLine
  summary.js            rsync -i output -> files, groups, folders without the path
  listing.js            listTree(): bounded nested listing (first N, depth, entry cap)
  preview.js            sparse mock tree + real rsync -n; mergeRows()
  settings.js           settings.json in the app's userData folder
gui/renderer/           index.html + app.js (main window), dryrun.html/js, ui.js (DOM helpers),
                        styles.css, dev-stub.js (browser-only fake data, inactive in the app)
```

- Plain JS, CommonJS in main, UMD for modules shared with the renderer. The
  renderer is sandboxed (`contextIsolation`, `sandbox`); only the preload
  touches Electron. A dropped folder's path comes from `webUtils.getPathForFile`.
- **Preview algorithm** (`preview.js`): sample = first 5 top-level folders
  (plus root files). Source entries become a sparse mock tree (OLAT: from the
  cached listing; local: read in full). Filter arguments come from
  `bash -c 'source olat-common.sh; build_pattern_filters …'`; rsync is
  `/usr/bin/rsync` (openrsync). One run per pattern against an empty folder
  gives that pattern's matches; one run with all patterns against the real
  destination (download) or a mock of the OLAT destination listing (upload)
  gives new / differs; unchanged matches are "already there". `mergeRows`
  adds the existing destination items ("not touched").
- **Unlisted folders** (OLAT folders below the listed depth) get a placeholder
  file in the mock, otherwise `-m` would prune the empty target folder and the
  pattern would look like it matches nothing. They show as a dimmed "not loaded
  yet" row, and existing destination items inside them as plain "pending" rows
  (not compared yet) instead of "not touched".
- Left-tree classes: a row is *hit* when it is in the matches and is a file or
  a folder at least as deep as the shortest pattern (`**` patterns: always),
  *dim* when it is not in the matches, otherwise normal (on the way). Rows
  outside the sample cannot occur for OLAT; for a local source the matches are
  computed on the whole local folder.
- `mirrorPath()` in `app.js` implements the same-path-in-all-samples listing;
  the context menu is a native `Menu` opened from main (`menu:context`).
- Identical patterns (after normalising a trailing `/`) count once.
  Dry-run never passes `-d`; `-s` is only passed for uploads.
- Dry-run window: main spawns the script (`detached`, killed as a group on
  abort/close), streams output; the window keeps the raw text and re-summarises
  it. "Run" appends the real command's output after a `▶` marker.
- Settings (`settings.json` in Electron's userData folder): last source and
  destination, pattern texts, the two checkboxes, last save folder, window bounds.
- Self-check hooks (env, test use only): `CM_USER_DATA` (data folder),
  `CM_OLAT_PREFIX` (treat another folder as the OLAT volume), `CM_SCRIPT_PATH`
  (stand-in for `olatTransfer.sh`), `CM_TEST_DIALOG` (answer for every native
  dialog), `CM_SCRIPT` (JS file run in the page), `CM_SCREENSHOT`,
  `CM_SHOT_TARGET=dryrun`, `CM_TEST_MENU` (id chosen in context menus), `CM_WAIT`. Example:
  `CM_USER_DATA=/tmp/ud CM_OLAT_PREFIX=/tmp/fakeolat CM_SCRIPT=check.js CM_SCREENSHOT=/tmp/a.png npx electron .`
  (with the two Electron variables exported, see the global CLAUDE.md).
- Verified without WebDAV: unit/integration tests (quoting against real bash,
  `validatePattern` against `validate_pattern`, command round trip and a
  generated file executed with a fake script, listing, preview against real
  rsync incl. special characters and unlisted targets); the app run with a
  fake OLAT folder: tree, chooser, preview colours, upload warning, Save and
  Open existing, Run and Dry-run windows with a stand-in script, not-mounted
  state. **Not yet run against the real mount** (see below).

## Risks and open checks

1. **Network Volumes permission**: reading `/Volumes/lms.uzh.ch` from the app
   may trigger a macOS prompt attributed to the shared `Electron.app` (affects
   every Electron project on this machine). Not yet checked.
2. **`._` sidecars from a Terminal opened by the GUI**: the Terminal launched by
   "Save & run in Terminal" may carry `com.apple.provenance`; this is what the
   `-s` option is for. Not yet checked.
3. **Listing cost** of ~100 student folders on the real mount (webdav-test-plan
   W4) and Ctrl-C resume (W9) are still open.
4. GUI-generated `.command` files run identically to hand-typed ones (W10).

## Out of scope for v1

- Mounting/ejecting from the GUI; managing the Keychain entry.
- Flattening the destination (v1 keeps `student/Participant Drop Box/a1.1/…`;
  a flatten option needs a collision rule, most likely `<student> - <file>`).
- Quick push (`-q`), scheduling, Windows/Linux.
