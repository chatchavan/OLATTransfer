# OLAT Command Maker — design

Status: backend (`-m`, `-n` in `olatTransfer.sh`) implemented and tested offline
on 2026-10-10; GUI not built yet, UI draft on a Claude Design canvas. Real-mount
checks are in `docs-dev/webdav-test-plan.md`.

## Goal

A small GUI that helps produce one `.command` file per recurring transfer
"situation", e.g. "download `Participant Drop Box/a1.1` from every student in
course X's *Hand in* folder". The GUI only *generates* `.command` files (and
can preview / run them). It never transfers data itself.

Assumption: the WebDAV volume (`/Volumes/lms.uzh.ch`) is already mounted while
the GUI runs. The GUI does not mount or eject.

## Prerequisite: pattern support in `olatTransfer.sh`

The GUI is a front end for a new script capability, so that comes first.

| New option | Meaning |
|---|---|
| `-m <pattern>` (repeatable) | Transfer only paths matching the rsync-wildcard pattern, **relative to the source root**. Works for download and upload. |
| `-n` | Dry run: pass `rsync -n`, print what would be transferred, change nothing. Used by the GUI preview. |

Pattern semantics (rsync wildcards: `*`, `?`, `[...]`; `/` separates levels;
`*` never crosses `/`):

- `*/Participant Drop Box/a1.1` matches `<any student>/Participant Drop Box/a1.1`
  and, since `a1.1` is a folder, everything inside it.
- Script turns each pattern into anchored rsync filters. For
  `s1/s2/s3`: `+ /s1/`, `+ /s1/s2/`, `+ /s1/s2/s3`, `+ /s1/s2/s3/**`, then a
  final `- *`. The existing `--exclude='.*'` stays **first** (rsync: first
  match wins).
- `-m` (`--prune-empty-dirs`, verified to work in macOS `openrsync`) so students
  without the path do not get an empty local folder.
- With `-m`, `--delete` is off even for uploads (same rule as `-q`). `-m` and
  `-q` are mutually exclusive.
- Exit code 23 handling, the summary, and the stage order are unchanged.

Cost on WebDAV: no irrelevant file data is read or transferred. Metadata
listing is limited to the levels the pattern walks: the root, then each
directory matched by `*` (here: each student folder). Sibling branches that
cannot match (e.g. other folders inside a student's folder) are listed once but
not entered.

Verified on a scratch tree with `openrsync` (`-n`): anchored include/exclude
filters, `-m`, and `--files-from` all behave as described. **Not yet verified on
the real mount.**

## GUI

### Tech and location

- **Electron**, in a self-contained `gui/` subfolder (own `package.json`), so the
  Bash tool keeps its "no dependencies" property. Uses the shared Electron
  binary per the global convention.
- Reasons: the UI is interactive (lazy tree, toggle chips, live text preview),
  Electron is the stack already set up on this machine, and spawning
  `olatTransfer.sh` from Node is trivial.
- Alternative considered: Swift/AppKit built with `swiftc` (matches
  `olat-finder-helper.swift`). Rejected for v1: building this UI in AppKit
  without full Xcode (no SwiftUI macros) costs more than it saves.
- Rejected: GUI composing `rsync` itself. It would duplicate the filter logic
  and bypass the mount / idle-agent stages.

### Principles

1. **One source of truth.** Filter building lives only in `olatTransfer.sh`.
   Preview = running the real script with `-n`. What you preview is what the
   `.command` will do.
2. **Lazy listing.** Only list a folder when the user expands it. Never walk
   the tree recursively. Cache listings for the session. Every WebDAV listing
   shows a spinner.
3. **No secrets.** The GUI never reads the Keychain. Credentials stay in
   `olatTransfer.sh`. A `.command` contains only paths and patterns.
4. **Keep the idle agent from ejecting mid-session.** "Used" currently means
   "ran `olatTransfer.sh`" (see CLAUDE.md, known limitation). The GUI must call
   `touch_last_used` (via `bash -c 'source olat-common.sh; touch_last_used'`,
   not by re-implementing the path) whenever it lists the volume. If the volume
   disappears anyway, show "WebDAV not mounted — mount it and retry"; do not
   try to mount.

### Window layout

```
┌ OLAT Command Maker ──────────────────────────────────────────────┐
│ 1  What                                                          │
│    (●) Download from OLAT   ( ) Upload to OLAT                   │
│    OLAT root   [/Volumes/…/Hand in            ] [Browse…]        │
│    Local folder[/Users/chat/Desktop/a1.1      ] [Choose…]        │
│                                                                  │
│ 2  Which paths (relative to the OLAT root)                       │
│    ┌ browser ─────────────┐  Example path (click to build):      │
│    │ ▸ Geyer, Marlena …   │  [Geyer, Marlena Emily] ▸             │
│    │ ▾ Müller, Jan        │  [Participant Drop Box] ▸ [a1.1]      │
│    │    ▸ Participant …   │   each chip:  Literal | Any (*) | Edit│
│    └──────────────────────┘  Pattern:  */Participant Drop Box/a1.1│
│                              [+ add another pattern]              │
│                                                                  │
│ 3  Preview            [Preview matches]  (lists every student)    │
│    41 matching paths · 1 203 files · 3 not found                  │
│    Geyer, Marlena Emily/Participant Drop Box/a1.1/solution.pdf …  │
│                                                                  │
│ 4  Output                                                         │
│    [ ] eject WebDAV when done (-d)                                │
│    File name [HCC-26HS-a1.1-download.command]  Save in [Choose…]  │
│    ┌ generated .command ───────────────────────────────────────┐  │
│    │ #!/bin/bash                                                │  │
│    │ bash ".../olatTransfer.sh" -m "*/Participant Drop Box/a1.1"│  │
│    └────────────────────────────────────────────────────────────┘  │
│    [Save .command]   [Save & run in Terminal]   [Copy command]    │
└──────────────────────────────────────────────────────────────────┘
```

### Pattern builder behaviour

- The user picks **one example** by drilling down in the browser (e.g. Geyer,
  Marlena Emily → Participant Drop Box → a1.1). The path below the OLAT root
  becomes a row of **chips**, one per level.
- Each chip has three states: **Literal** (exact name), **Any** (`*`),
  **Custom** (editable wildcard, e.g. `Geyer*`, `a1.?`).
- Default suggestion: a level whose parent folder has many siblings (the
  student level) starts as **Any**; the rest start as **Literal**. This is a
  default only; the user decides.
- Literal text is escaped for rsync (`* ? [ ] \`). Names with commas, spaces or
  quotes are common and must pass through unchanged.
- The pattern line is also directly editable; chips and text stay in sync
  where the text can be parsed back into chips, otherwise chips show "custom".
- Multiple patterns (e.g. `a1.1` and `a1.2`) are a list; each becomes one `-m`.
- For uploads the browser lists the **local** folder (cheap) instead of
  WebDAV; the OLAT side is only the destination root.

### Preview

- A button, not live-as-you-type: a preview costs one listing per student
  folder over WebDAV. Show that cost in the button's hint.
- Runs `olatTransfer.sh -n -m … src dest`, parses the itemize lines, shows the
  matched file list and counts.
- Also useful to show how many top-level folders had no match (students without
  that submission). Needs either a second cheap listing of the matched level or
  parsing rsync's stderr; decide during implementation.

### Generated `.command` format

Same style as the existing `example-*.command` (absolute paths, `bash`
invoking `olatTransfer.sh`), plus a metadata block so the GUI can reopen and
edit a file it wrote:

```
#!/bin/bash
# olat-command-maker: v1
# direction=download
# root=/Volumes/lms.uzh.ch/webdav/coursefolders/26HS …/Hand in
# pattern=*/Participant Drop Box/a1.1
bash "/Users/chat/local_git/OLATTransfer/olatTransfer.sh" \
	-m "*/Participant Drop Box/a1.1" \
	"/Volumes/lms.uzh.ch/webdav/…/Hand in" \
	"/Users/chat/Desktop/a1.1"
```

- Saved with `chmod +x`. All values shell-quoted by one tested escaping
  function (names containing `"`, `'`, `$`, backticks, and non-ASCII).
- "Open existing .command…" reads the metadata block. Files without it are
  refused rather than guessed at.
- Remembered between runs (`~/Library/Application Support/OLATTransfer/`,
  not the repo): last OLAT root, last save folder, window state.

## Risks to check first (spikes, before building the UI)

1. **Network Volumes permission.** Reading `/Volumes/lms.uzh.ch` from the app
   may trigger a macOS prompt attributed to the shared `Electron.app`
   (affects every Electron project on this machine). Verify it prompts once and
   persists.
2. **Real-mount behaviour of the filters.** Run the `-n` dry run with the
   anchored filters against the test course on the real mount: correct matches,
   listing time for ~100 student folders, and that nothing unmatched is read.
3. **Unicode normalisation.** A **Literal** chip with an umlaut (macOS file
   names are NFD, patterns typed or saved are NFC) may fail to match. If so,
   the script or GUI must normalise or fall back to `?`/`*` for those
   characters.
4. **`--stats` / summary output** of `openrsync -n` is enough for the preview
   counts (sizes may not be available).

## Out of scope for v1

- Mounting/ejecting from the GUI; managing the Keychain entry.
- Flattening the destination (default keeps `student/Participant Drop Box/a1.1/…`).
- Scheduling or running transfers on a timer.
- Windows/Linux.

## Decisions (2026-10-10)

1. **Electron** in `gui/`.
2. **Flatten destination**: wanted, but after v1. v1 keeps
   `student/Participant Drop Box/a1.1/…`. A flatten option needs a naming
   rule for collisions (every student has an `a1.1/sol.pdf`), most likely
   `<student> - <file>`; design it with the first real use.
3. **Save location**: the Output step has an explicit "Choose where to save…"
   button (native folder dialog) plus the file name field; the last folder is
   remembered but never silently used without the button being visible.

## Constraints learned while building the backend

- Pattern semantics are exactly `olatTransfer.sh -m` (see its README section);
  the GUI must not re-implement matching, only call `-n` for the preview.
- **Do not normalise names.** Chips built from a clicked example must carry
  the exact bytes the mount returned. A typed literal with non-ASCII letters
  can fail to match (NFC vs NFD, confirmed on APFS). The GUI should warn on
  non-ASCII typed literals and suggest `*` (not `?`, which is byte-wise).
  Confirmed on the real mount (webdav-test-plan W6).
- **Escape literals** with a backslash for `* ? [ ] \` (verified to work in
  the bundled `openrsync`); `validate_pattern` rejects empty, absolute,
  `.`/`..` and empty (`//`) levels, so the GUI should apply the same rules
  inline.
- Uploads create missing student folders on OLAT (rsync creates the
  destination path). The GUI should say so in the upload preview.
- `-m` and `-q` cannot be combined; the GUI has no `-q` in v1.
- Uploads: offer a checkbox "Remove macOS `._` sidecar files after upload"
  that adds `-s` (off by default; same default as the script). Hint text:
  only needed if the command is launched from an app that carries
  `com.apple.provenance`.

## Two-pane layout (UI draft v2, 2026-10-10)

Supersedes the four-step window above in the canvas artboard "Two-pane layout".
Left column = Source, right = Destination, each with an editable path field
(paste allowed), a folder button, drag-and-drop of a folder onto the column,
and a tree. Under the columns: an editable list of pattern rows (text field,
"matches N of M listed", remove, "Add pattern"); at the bottom a status bar
plus an action bar (buttons not designed yet). The script still decides the
direction from which side is on the mount.

Tree listing rules (the tree exists only to help design wildcards):

- **OLAT source: sample, do not scan.** List only the first 5 folders of the
  source root. A grey item says "Only the first 5 of N folders are listed…;
  the pattern applies to all N". Pattern rows show "matches X of 5 listed".
- **Depth in steps of 3 levels.** Levels are counted below the source root
  (student = 1, Participant Drop Box = 2, a1.1 = 3). A first listing goes 3
  levels deep; every folder at the cut-off depth that may have more inside
  gets a clickable item as its last child ("Showing N levels deep. Click to
  load 3 levels deeper"), and a click loads 3 more levels for that folder
  only. Never recurse unbounded over WebDAV.
- **Chooser (Literal | Any (*) | Custom)** appears only under the clicked row.
  Rows already used by the pattern show their mode as a small tag.
- **Right column = live preview of the destination after the transfer.**
  Computed locally and instantly: build a throwaway tree of empty files and
  folders from the cached listing of the 5 sampled folders (to the loaded
  depth), then run the real `rsync -n -i` with the script's own filter
  arguments (from `build_pattern_filters`, not re-implemented) against it,
  and merge the result with the existing destination folder. Re-run on every
  pattern edit (debounced). Rules decided 2026-10-10:
  - Merge incoming and existing items, shown by row colour (no chips): green
    = new, default background = already there, yellow = differs in size (same
    `--size-only` rule as the real run), dimmed = existing item the pattern
    does not write. A legend of colour swatches sits in the pane header; rows
    also carry a `title` with the status, so it is not colour-only.
  - Markers (`already there`, `differs in size`, counts) are shown only for
    data actually fetched from OLAT: the first 5 folders, 6 levels deep at
    first. Items below the fetched depth show "not loaded yet"; loading
    deeper in the source tree extends the preview. No extra WebDAV listing is
    made just for the preview.
  - Left tree follows the pattern live: rows matched by any pattern are
    highlighted, rows that cannot match are dimmed; folders on the way to a
    match (student, Participant Drop Box) stay normal.
  - Show all sampled students expanded (not collapsed to "+ N like this").
  - Labelled "Based on the 5 listed folders of N". A separate button runs the
    full dry run (`olatTransfer.sh -n …`) for exact numbers.
  - Upload: the right column is the OLAT side; folders that do not exist there
    yet are marked "new folder" (they get created on OLAT).
- **No "WebDAV mounted" indicator.** The mount state is shown only on
  failure, inline where it matters: when a path under `/Volumes/lms.uzh.ch`
  cannot be listed, that column's tree is replaced by "WebDAV is not mounted"
  with a Retry button (the GUI still never mounts), the path field gets an
  error border, and the preview says "Nothing to preview until the source
  folder can be listed". The mount is checked when an OLAT path is dropped,
  pasted or listed; no background polling. Artboard "WebDAV not mounted".
- **Pane header is one line**: label ("Source" / "Destination"), editable path
  field, folder button. No "OLAT"/"Local" chips; the side is inferred from the
  path. Drag-and-drop of a folder onto a column sets its path.
- **Status bar** (left: empty for now; right: three icon buttons):
  - Cogwheel → pop-up menu with the checkbox "Disconnect WebDAV when done"
    (`-d`), checked by default. Stored in the app settings, applied to the
    generated command and to Run.
  - Play → pop-up with "Dry-run" and "Run".
    - **Run** opens a dialog modelled on panel "5. Run" of
      `student-work-files-organizer`: Run again, Abort, Copy output; a summary
      line; a dark selectable output pane that starts with the command line
      (`▶ bash …`) and streams the script's output.
    - **Dry-run opens its own window, one per dry run** (title carries the
      time and the folders, so several can stay open and be compared). The
      window shows: the command; a "Dry run: nothing was copied" badge and a
      summary ("41 matching folders · 1,203 files · 3 students without this
      path"; for uploads also "1 student folder would be created on OLAT");
      tabs Matches (one row per matching folder with file count, a "students
      without this path" disclosure, a warning for folders that would be
      created on OLAT) and Output (raw output, copyable); footer with run time
      and exit code, Copy output, Close. Dry-run adds `-n` and never `-d`, so
      the volume stays mounted for browsing.
  - Save → dialog with the "Generated .command" block and the buttons Save
    .command (native save panel, `chmod +x`), Save & run in Terminal, Copy
    command. The file name and folder come from the native save panel.
  Generated command: one `-m` per pattern row, `-d` first when the checkbox is
  on; the metadata block gains `# disconnect=yes|no`.
- **Dry-run window** also has a "Run" button (red) in its footer that runs the
  same command for real; all its views (command, Matches list, Output) scroll
  when long.
- **Open existing .command…** is a folder-icon button at the left end of the
  status bar (tooltip "Open existing .command…"). It reads the
  `# olat-command-maker` metadata block, fills paths, patterns and options, and
  refuses files without that block.
- **Cogwheel menu** also has "Remove macOS ._ files after upload" (`-s`): off
  by default, enabled only when the destination is OLAT (disabled with the hint
  "Only for uploads to OLAT" otherwise).
- **Upload layout** (artboard "Two-pane layout: upload"): source = local folder,
  listed completely; destination = OLAT preview. The OLAT side is compared only
  for the first 5 local student folders ("Compared with OLAT for the first 5 of
  7…"). Student folders missing on OLAT are green and named in a warning at the
  top ("Uploading creates 1 folder on OLAT… Nothing on OLAT is deleted when
  patterns are used"); OLAT-only files stay visible, dimmed.
- **Local source: the limits do not apply.** No "first 5" cap and no 3-level
  step: expand any folder and list all its entries (a local listing is cheap).
  Pattern rows then need no "of N listed" count (or can show an exact count
  from the local listing). Same chooser, same pattern syntax. For an upload the
  OLAT side is only the destination root.
