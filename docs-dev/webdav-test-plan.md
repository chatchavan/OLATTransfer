# Test plan that needs the real WebDAV mount

Status: run on 2026-10-10 against the test course (see "Results" at the end).
Written the same day while WebDAV was unavailable; the steps below are kept as
the repeatable procedure.

What *is* covered without WebDAV: `tests/pattern-offline.sh` (25 checks of
`-m`/`-n` against scratch trees, run under macOS bash 3.2). It cannot tell us
how the real `mount_webdav` volume behaves, which is what this plan is for.

**Run this in your own Terminal** (see TESTS.md: Finder Automation permission
is per calling process, an agent shell fails with `-1743`).

Use a **test course** (e.g. "…'s test OLAT course", as in
`example-download.command`) with fabricated student folders, not a real
course, for everything that writes. Reads (dry runs) on a real course are
fine once step W3 passes. Scratch destinations go under
`~/Desktop/olat-pattern-test/` and are deleted afterwards.

Pre-conditions: volume mounted (any run of `olatTransfer.sh`), `-n` first for
every new pattern, never `--delete`-style plain uploads into a real course.

## W1. Dry run + pattern on the real mount (read-only)

```bash
cd /Users/chat/local_git/OLATTransfer
bash olatTransfer.sh -n -m "*/Participant Drop Box/a1.1" \
  "/Volumes/lms.uzh.ch/webdav/coursefolders/<test course>/_courseelementdata/Hand in" \
  ~/Desktop/olat-pattern-test
```

Expect: `Would download N file(s):` listing only `…/Participant Drop Box/a1.1/…`
paths; nothing written to `~/Desktop/olat-pattern-test`; no `Other` siblings,
no hidden items. Record N and the wall-clock time.

## W2. Real download, then idempotency

Same command without `-n`. Expect the same files on disk, no empty
student folders (students without the path pruned by `-m`). Re-run: expect
`Downloaded 0 file(s):` (confirms `--size-only` + filters behave on WebDAV).
Open one downloaded file to confirm it is complete (size matches in Finder).

## W3. "No irrelevant data is transferred" (the core claim)

The aim is to prove unmatched files are never *read*, not just never copied.

1. Pick a student with a large unmatched file (e.g. a 50+ MB file outside
   `a1.1`). Put it there on purpose in the test course.
2. Time W2's real run; it must take roughly as long as the matched files
   alone, with no relation to the large unmatched file.
3. While it runs, watch network use, e.g. `nettop -m tcp -p mount_webdav`
   (or Activity Monitor → Network, process `mount_webdav`/`webdavfs_agent`).
   Total received bytes should be about the size of the matched files plus
   small listing traffic.
4. Repeat with the large file moved inside `a1.1`: now the transfer must
   grow accordingly. (Negative control: proves the measurement is sensitive.)

## W4. Listing cost on a realistic folder

On a course with ~100 student folders, time `-n` for:
- `-m "*/Participant Drop Box/a1.1"` (walks root + each student folder)
- `-m "Example*/Participant Drop Box/a1.1"` (still lists root, enters few)
- plain `-n` with no `-m` (baseline: whole tree)

Write the three timings in this file. If the first is not clearly faster than
the baseline, consider replacing the rsync filters by a shell-glob/`--files-from`
approach for patterns that start with a literal segment.

## W5. Upload with a pattern (test course only)

1. Local tree: `up/Example, Student A/Participant Drop Box/a1.1/feedback.txt`
   and an unrelated `up/other/skip.txt`.
2. `-n` first, then real: `-m "*/Participant Drop Box/a1.1" up <test course>/…/Hand in`.
3. Expect `feedback.txt` appears under the **existing** student folder on OLAT
   and `other/` is NOT created. Expect nothing on OLAT is deleted, including
   files that exist only on OLAT in `a1.1`.
4. Check what happens when the local student folder name does not exist on
   OLAT: rsync creates it on the server. Decide whether that is acceptable
   (the GUI should warn: "Creates new folders on OLAT").

## W6. Unicode normalisation (known mismatch locally)

Offline we saw: an NFC literal (`Müller` typed in a text field) does **not**
match an NFD-named folder; an NFD literal does. Check on the real mount:
1. Folder with an umlaut/accent in the student name on the test course.
2. `-n -m "<NFC name>/Participant Drop Box/a1.1"` and the NFD variant.
   Which one matches? (`ls | xxd | head` on the mount shows the real bytes.)
3. Expected consequence for the GUI: patterns built by clicking an example
   (names taken verbatim from the mount, never normalised) always work;
   typed literals with non-ASCII characters may not. If the real mount
   behaves differently from APFS, update `docs-dev/command-maker-gui.md`.

## W7. Special characters in names

On the test course create folders with: comma+space (`Example, Student A`),
`[x]`, `*`, `?`, `'`, `"`, `&`, a leading space. For each, `-n` with the
backslash-escaped literal pattern (`\[`, `\*`, `\?`). Expect a match.
Note any name WebDAV refuses to create (not our bug, but constrains the GUI).

## W8. Idle-eject interaction

1. Run W1; check the stamp file mtime updated (`touch_last_used`).
2. For the GUI: confirm that listing the volume from another process does
   *not* update the stamp (known limitation). The GUI must call
   `touch_last_used` itself (design doc, principle 4). When the GUI exists,
   verify: browse for longer than `idle_disconnect_minutes` without running
   a transfer; the volume must stay mounted.

## W9. Exit codes and messages

- Pattern that matches nothing: expect `Downloaded 0 file(s)` and exit 0
  (✅ line), no scary message. Confirm.
- Source subfolder that does not exist: expect the existing
  `Source directory not found` error.
- Interrupt (Ctrl-C) in the middle of a pattern download, then re-run:
  `--inplace` should resume cleanly (no corrupt half files kept).

## W10. `.command` generated by the GUI (after the GUI exists)

For each of W1, W2, W5: generate the `.command` with the GUI, double-click it
from Finder, confirm identical behaviour to the hand-typed command, including
paths with spaces and commas and the optional `-d` eject.


## Results (2026-10-10)

Test location: `Chat Wacharamanotham_s test OLAT course/_courseelementdata/Test p folder`
(5 participants, each with `Coach Return Box` and `Participant Drop Box`, both
empty at the start). Only `Coach Return Box` folders were written to, using
fabricated files. Run from the agent's shell, which could mount and use the
real script without `-1743`.

| Step | Result |
|---|---|
| W1 dry run | Pass. The walk touched 11 directory entries (root, 5 participants, 5 `Coach Return Box`); `Participant Drop Box` was never entered. Nothing written. |
| W2 download + rerun | Pass. Content identical; participants without the path got no empty folder; rerun 0 files. |
| W3 no irrelevant data | **Pass.** After a fresh mount, `-m */Coach Return Box/a1.1` made `webdavfs_agent` receive 90 KiB in total with a 40 MB sibling in `a1.2`. The control (`a1.2`) received 52,375 KiB. Caveat: macOS caches files you just uploaded, so a first attempt without remounting showed 0 bytes for the control. Always unmount first when measuring (`diskutil unmount /Volumes/lms.uzh.ch`). |
| W4 listing cost | Not meaningful with 5 participants (plain 2.0 s vs 0.9 s vs 0.7 s, noisy). Still to do on a ~100-participant course. |
| W5 upload | Pass. Only the matched files went up; `Participant Drop Box` and `other/` untouched; nothing deleted; rerun 0 files. Dry run showed a non-existent local participant folder would be **created** on OLAT (not run for real). |
| W6 Unicode | Mount stores NFC and NFD names as separate, byte-exact entries. A literal only matches its own form. `*` bridges both. `?` is byte-wise (NFC `ü` = `??`, NFD = `???`). |
| W7 special chars | `, [ ] * ? ' &` and accents work; escaped (`\[`, `\*`, `\?`) and unescaped forms behave as documented. A backslash in a name is refused by the mount. |
| W8 stamp | Pass: a run updates `last_used`. GUI-side behaviour not testable yet. |
| W9 edges | Pass: no-match pattern gives "Would download 0" and the ✅ line; a missing source gives the existing "Source directory not found". Ctrl-C resume not tested. |
| W10 GUI `.command` | Not testable yet (no GUI). |

Surprises found (also in CLAUDE.md): `._` AppleDouble sidecar files appear on
OLAT next to every file/folder written (root cause and fix: see W11); an rsync abort leaves the "Uploaded N"
summary listing files that were not written.

### Test data left on OLAT (not deleted)

Under `Test p folder`, in `Coach Return Box`:
- `Ahmed, Nimra`: `a1.1/feedback.txt`, `a1.2/big.bin` (40 MB), `special/` (7 folders with `f.txt`), plus `._` sidecar files.
- `Barth, Clara-Maria`: `a1.1/feedback.txt` plus `._` sidecar files.

## W11. `._` sidecars on the real mount

Root cause and fix: see CLAUDE.md "Known quirks". Short version: a process that
carries `com.apple.provenance` (check with `echo x > /tmp/p; xattr /tmp/p`)
makes the WebDAV client write `._<name>` beside items it creates **or whose
times/permissions it sets**. Plain user Terminal: no sidecars. Claude app
terminal / agent shell: sidecars.

Results 2026-10-10:
- User's own Terminal, 1st upload of new items: no sidecars (cleanup not needed).
- Claude terminal, 2nd upload of the same items (nothing to send, `-a` re-set
  times/perms): sidecars created for all 4 items (09:27:08-10). This exposed
  that creation was not the only trigger.
- Experiment on 4 fresh items (created from a plain Terminal, updated from
  the agent shell): `rsync -a`, `-rt`, `-rp` -> sidecars; `-rl` -> none (also
  after 25 s).
- Fix: uploads use `-rlvi`. End-to-end with the real script from the
  provenance-bearing shell, two runs over an existing item: no sidecar.
- **Verified 2026-10-10 (user, Claude app Terminal panel, provenance
  confirmed there):** uploading 2 new files + 2 new folders printed
  `Removed 4 macOS sidecar file(s)`; after 20 s no `._` entries in the folder,
  in `sub/`, or beside `verify3`. A re-read about 30 s later (agent, read-only)
  was still clean. Not run: the repeat upload from that shell (the equivalent
  was covered by two agent-shell runs over an existing item, no sidecars).
  (The cleanup became opt-in with `-s` afterwards; the verified run is the
  block below, which now includes `-s`. Without `-s` nothing is removed, covered
  by the offline suite only.) The block that was run:

```bash
B="/Volumes/lms.uzh.ch/webdav/coursefolders/Chat Wacharamanotham_s test OLAT course/_courseelementdata/Test p folder"
U=$(mktemp -d); mkdir -p "$U/Ahmed, Nimra/Coach Return Box/verify3/sub"
echo one > "$U/Ahmed, Nimra/Coach Return Box/verify3/a.txt"
echo two > "$U/Ahmed, Nimra/Coach Return Box/verify3/sub/b.txt"
echo x > /tmp/prov-check; echo "provenance here: [$(xattr /tmp/prov-check)]"
bash /Users/chat/local_git/OLATTransfer/olatTransfer.sh -s -m "*/Coach Return Box/verify3" "$U" "$B"
sleep 20
ls -A "$B/Ahmed, Nimra/Coach Return Box/verify3" "$B/Ahmed, Nimra/Coach Return Box/verify3/sub"
ls -A "$B/Ahmed, Nimra/Coach Return Box" | grep '^\._verify3' || echo "no ._verify3 next to the folder"
```

Expect: `provenance here: [com.apple.provenance]`, then `Removed 4 macOS
sidecar file(s)`, and no `._` entries in either listing. Then run the same
upload block again (second run): expect `Uploaded 0`, no "Removed" line and no
new `._` files.

Leftovers from the experiments are under `Ahmed, Nimra/Coach Return Box`
(`sidecar-test/`, `term-g/`, `verify-sidecar/`, `verify2/`, `verify3/`, and their `._`
files); the script does not remove them.
