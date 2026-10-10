#!/bin/bash
# Offline tests for pattern mode (-m), dry run (-n) and the options they must
# not break (plain transfer, -q). No WebDAV, Keychain or Finder needed.
#
# How: builds a copy of olatTransfer.sh with the Keychain/mount/idle-agent
# stage cut out and WEBDAV_PREFIX pointed at a scratch folder, then runs it
# against scratch trees. HOME is redirected so nothing under ~/Library is
# touched. Everything lives in one mktemp dir that is removed at the end.
#
# Run with the system bash on purpose (macOS ships 3.2, which the real script
# must work on):   /bin/bash tests/pattern-offline.sh
#
# What this does NOT cover: anything involving the real WebDAV mount (see
# docs-dev/webdav-test-plan.md).

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)" || exit 1
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME"

FAKEVOL="$T/fakevol"
REAL="$REPO/olatTransfer.sh"
H="$T/olatTransfer-offline.sh"

# --- harness: real script minus keychain/mount/agent, fake volume prefix ----
sed -e '/# FETCH PASSWORD FROM THE KEYCHAIN/,/# VALIDATE SOURCE AND DESTINATION/{/# VALIDATE SOURCE AND DESTINATION/!d;}' \
    -e "s|source \"\$SCRIPT_DIR/olat-common.sh\"|source \"$REPO/olat-common.sh\"; WEBDAV_PREFIX=\"$FAKEVOL\"|" \
    -e 's|eject_webdav >/dev/null|true|' \
    "$REAL" > "$H"
if ! grep -q 'WEBDAV_PREFIX=' "$H" || grep -q 'security find-internet-password' "$H"; then
    echo "harness build failed (script layout changed?)"; exit 2
fi

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL $1"; [[ -n $2 ]] && printf '%s\n' "$2" | sed 's/^/       /'; }
files() { (cd "$1" && find . -type f | sed 's|^\./||' | sort); }

# expect_files <label> <dir> <expected newline-separated list, may be empty>
expect_files() {
    local got want
    got="$(files "$2")"; want="$(printf '%s' "$3" | sort)"
    if [[ "$got" == "$want" ]]; then ok "$1"; else bad "$1" "want:
$want
got:
$got"; fi
}
# expect_out <label> <fixed string that must appear in $OUT>
expect_out() { if grep -qF -- "$2" <<< "$OUT"; then ok "$1"; else bad "$1" "missing: $2
$OUT"; fi }
expect_no_out() { if grep -qF -- "$2" <<< "$OUT"; then bad "$1" "unexpected: $2"; else ok "$1"; fi }

reset_dirs() { rm -rf "$T/out" "$T/up" "$FAKEVOL"; mkdir -p "$T/out" "$FAKEVOL"; }
mk() { mkdir -p "$1/$2"; echo "$3" > "$1/$2/$4"; }   # mk <root> <dir> <content> <file>

build_course() {   # a fake "Hand in" folder
    local r="$FAKEVOL/Hand in"
    mk "$r" "Example, Student A/Participant Drop Box/a1.1" d sol.pdf
    mk "$r" "Example, Student A/Participant Drop Box/a1.1/sub" d more.txt
    mk "$r" "Example, Student A/Participant Drop Box/a1.2" d other.pdf
    mk "$r" "Example, Student A/Other Box/a1.1" d no.pdf
    mk "$r" "Sample, Student B/Participant Drop Box/a1.1" d sol.pdf
    mk "$r" "Sample, Student C/Participant Drop Box/a1.2" d other.pdf
    mk "$r" "Sample, Student D/Notes" d x.txt
    mk "$r" ".hidden/Participant Drop Box/a1.1" d h.pdf
    echo top > "$r/top.txt"
}

echo "== 1. command-line validation (real script; fails before Keychain/mount)"
OUT="$(/bin/bash "$REAL" -m a -q x y 2>&1)"; rc=$?
[[ $rc -eq 1 ]] && ok "-m with -q exits 1" || bad "-m with -q exits 1" "rc=$rc"
expect_out "-m with -q message" "cannot be combined"
for p in "" "/abs" "a/../b" "a//b" "./a"; do
    OUT="$(/bin/bash "$REAL" -m "$p" x y 2>&1)"; rc=$?
    [[ $rc -eq 1 ]] && grep -q 'Invalid -m pattern' <<< "$OUT" && ok "rejects pattern '$p'" || bad "rejects pattern '$p'" "rc=$rc $OUT"
done

echo "== 2. dry run (-n) downloads nothing"
reset_dirs; build_course
OUT="$(/bin/bash "$H" -n -m "*/Participant Drop Box/a1.1" "$FAKEVOL/Hand in" "$T/out" 2>&1)"
expect_files "dry run wrote no files" "$T/out" ""
expect_out "dry run announced" "Dry run: nothing will be transferred."
expect_out "dry run summary says Would download 3" "Would download 3 file(s):"

echo "== 3. download with two patterns"
reset_dirs; build_course
OUT="$(/bin/bash "$H" -m "*/Participant Drop Box/a1.1" -m "*/Participant Drop Box/a1.2" "$FAKEVOL/Hand in" "$T/out" 2>&1)"
expect_files "only matching paths copied" "$T/out" "Example, Student A/Participant Drop Box/a1.1/sol.pdf
Example, Student A/Participant Drop Box/a1.1/sub/more.txt
Example, Student A/Participant Drop Box/a1.2/other.pdf
Sample, Student B/Participant Drop Box/a1.1/sol.pdf
Sample, Student C/Participant Drop Box/a1.2/other.pdf"
[[ -z "$(find "$T/out" -mindepth 1 -type d -empty)" ]] && ok "no empty folders created (student D pruned)" || bad "no empty folders created" "$(find "$T/out" -type d -empty)"
OUT="$(/bin/bash "$H" -m "*/Participant Drop Box/a1.1" -m "*/Participant Drop Box/a1.2" "$FAKEVOL/Hand in" "$T/out" 2>&1)"
expect_out "second run transfers nothing" "Downloaded 0 file(s):"

echo "== 4. single level, ** and mid-level wildcards"
reset_dirs; build_course
OUT="$(/bin/bash "$H" -m "top.txt" "$FAKEVOL/Hand in" "$T/out" 2>&1)"
expect_files "single-segment pattern" "$T/out" "top.txt"
rm -rf "$T/out"; mkdir "$T/out"
OUT="$(/bin/bash "$H" -m "**/a1.2" "$FAKEVOL/Hand in" "$T/out" 2>&1)"
expect_files "** pattern across levels" "$T/out" "Example, Student A/Participant Drop Box/a1.2/other.pdf
Sample, Student C/Participant Drop Box/a1.2/other.pdf"
rm -rf "$T/out"; mkdir "$T/out"
OUT="$(/bin/bash "$H" -m "Sample,*/Participant Drop Box/a1.?" "$FAKEVOL/Hand in" "$T/out" 2>&1)"
expect_files "wildcards inside a level (comma, ?)" "$T/out" "Sample, Student B/Participant Drop Box/a1.1/sol.pdf
Sample, Student C/Participant Drop Box/a1.2/other.pdf"
rm -rf "$T/out"; mkdir "$T/out"
OUT="$(/bin/bash "$H" -m "*/Participant Drop Box/a1.1/" "$FAKEVOL/Hand in" "$T/out" 2>&1)"
expect_out "trailing / same as without" "Downloaded 3 file(s):"

echo "== 5. escaping wildcard characters in literal names"
reset_dirs
mk "$FAKEVOL/n" "Weird [x]*? name/Box/a1" d g.txt
OUT="$(/bin/bash "$H" -m 'Weird \[x\]\*\? name/Box/a1' "$FAKEVOL/n" "$T/out" 2>&1)"
expect_files "backslash-escaped literal matches" "$T/out" "Weird [x]*? name/Box/a1/g.txt"
rm -rf "$T/out"; mkdir "$T/out"
OUT="$(/bin/bash "$H" -m 'Weird [x]*? name/Box/a1' "$FAKEVOL/n" "$T/out" 2>&1)"
expect_files "unescaped is a wildcard, so no match" "$T/out" ""

echo "== 6. upload with a pattern never deletes"
reset_dirs
mk "$T/up" "Example, Student A/Participant Drop Box/a1.1" new feedback.txt
mk "$T/up" other new skip.txt
mk "$FAKEVOL/dest" "Example, Student A/Participant Drop Box/a1.1" keep old-remote.txt
OUT="$(/bin/bash "$H" -m "*/Participant Drop Box/a1.1" "$T/up" "$FAKEVOL/dest" 2>&1)"
expect_files "uploaded the match, kept remote-only file, skipped 'other'" "$FAKEVOL/dest" "Example, Student A/Participant Drop Box/a1.1/feedback.txt
Example, Student A/Participant Drop Box/a1.1/old-remote.txt"
expect_no_out "no deletions reported" "Deleted"

echo "== 7. regression: plain upload still mirrors (deletes) and -n says Would"
OUT="$(/bin/bash "$H" -n "$T/up" "$FAKEVOL/dest" 2>&1)"
expect_out "plain dry run would delete" "Would delete 1 file(s):"
expect_files "dry run left remote untouched" "$FAKEVOL/dest" "Example, Student A/Participant Drop Box/a1.1/feedback.txt
Example, Student A/Participant Drop Box/a1.1/old-remote.txt"
OUT="$(/bin/bash "$H" "$T/up" "$FAKEVOL/dest" 2>&1)"
expect_files "plain upload mirrors local" "$FAKEVOL/dest" "Example, Student A/Participant Drop Box/a1.1/feedback.txt
other/skip.txt"

echo "== 8. regression: quick push (-q) still works"
rm -rf "$FAKEVOL/q"; mkdir "$FAKEVOL/q"
OUT="$(/bin/bash "$H" -q "$T/up" "$FAKEVOL/q" 2>&1)"
expect_files "quick push uploads changed top-level folders" "$FAKEVOL/q" "Example, Student A/Participant Drop Box/a1.1/feedback.txt
other/skip.txt"

echo "== 9. macOS ._ sidecars created by the WebDAV client are cleaned up after an upload"
# A shim rsync stands in for the WebDAV client's behaviour: after a real (non
# dry-run) rsync it writes a ._<name> file next to every item under the
# destination that lacks one, like macOS does for com.apple.provenance.
mkdir -p "$T/shim"; export SHIM_LOG="$T/shim.log"; : > "$SHIM_LOG"
cat > "$T/shim/rsync" <<'SHIM'
#!/bin/bash
echo "$*" >> "$SHIM_LOG"
/usr/bin/rsync "$@"; rc=$?
for a in "$@"; do [[ $a == -n ]] && exit $rc; done
dest="${@: -1}"
find "$dest" -mindepth 1 -not -name '._*' | while IFS= read -r p; do
    [[ -e "${p%/*}/._${p##*/}" ]] || echo apple > "${p%/*}/._${p##*/}"
done
exit $rc
SHIM
chmod +x "$T/shim/rsync"
reset_dirs
R="$FAKEVOL/dest"
mk "$R" "Example/Box/a1.1" user-data manual          # pre-existing item ...
echo mine > "$R/Example/Box/a1.1/._manual"           # ... with its own pre-existing sidecar (not ours)
mk "$R" old data keep.txt                            # untouched item
mk "$T/up" "Example/Box/a1.1" new new.txt
mk "$T/up" "Example/Box/a1.1/sub" new n2.txt
echo local > "$T/up/Example/Box/a1.1/._localsidecar" # local ._ file must never be uploaded
# off by default: same upload into a separate, identical destination, without -s
R0="$FAKEVOL/dest-nos"; mkdir -p "$R0/Example/Box/a1.1"
OUT="$(PATH="$T/shim:$PATH" /bin/bash "$H" -m "*/Box/a1.1" "$T/up" "$R0" 2>&1)"
expect_no_out "without -s nothing is removed" "Removed"
[[ -f "$R0/Example/Box/a1.1/._new.txt" && -f "$R0/Example/Box/a1.1/sub/._n2.txt" && -f "$R0/Example/Box/a1.1/._sub" ]] && ok "without -s the sidecars are still there" || bad "without -s the sidecars are still there"
OUT="$(PATH="$T/shim:$PATH" /bin/bash "$H" -s -m "*/Box/a1.1" "$T/up" "$R" 2>&1)"
expect_out "with -s: reports removing 3 sidecars (new.txt, n2.txt, sub)" "Removed 3 macOS sidecar file(s)"
expect_files "only the uploaded items' sidecars were removed" "$R" "Example/Box/a1.1/manual
Example/Box/a1.1/._manual
Example/Box/a1.1/new.txt
Example/Box/a1.1/sub/n2.txt
Example/Box/._a1.1
Example/._Box
._Example
old/keep.txt
old/._keep.txt
._old"
expect_no_out "local ._ file not uploaded" "._localsidecar"
# Uploads must not ask rsync to set times/permissions on OLAT (that is what makes
# the WebDAV client write sidecars for unchanged items); downloads keep -a.
if grep -q -- ' -rlvi ' <<< " $(head -1 "$SHIM_LOG") " && ! grep -qE -- ' -[a-z]*a[a-z]* ' <<< " $(head -1 "$SHIM_LOG") "; then ok "upload uses -rlvi, not -a"; else bad "upload uses -rlvi, not -a" "$(head -1 "$SHIM_LOG")"; fi
# even with -s, dry run and downloads never remove anything
rm -f "$R/Example/Box/a1.1/._new.txt"; echo again > "$R/Example/Box/a1.1/._new.txt"
OUT="$(PATH="$T/shim:$PATH" /bin/bash "$H" -s -n -m "*/Box/a1.1" "$T/up" "$R" 2>&1)"
[[ -f "$R/Example/Box/a1.1/._new.txt" ]] && ok "dry run removes nothing" || bad "dry run removes nothing"
rm -rf "$T/dl"; mkdir "$T/dl"; : > "$SHIM_LOG"
OUT="$(PATH="$T/shim:$PATH" /bin/bash "$H" -s -m "*/Box/a1.1" "$R" "$T/dl" 2>&1)"
grep -q -- ' -avi ' <<< " $(head -1 "$SHIM_LOG") " && ok "download keeps -avi" || bad "download keeps -avi" "$(head -1 "$SHIM_LOG")"
[[ -f "$R/Example/Box/a1.1/._new.txt" ]] && expect_no_out "download does not clean or copy sidecars" "Removed" || bad "download left remote sidecar alone"
# a sidecar whose item was not part of the run is never touched, even in the same folder
[[ -f "$R/Example/Box/a1.1/._manual" ]] && ok "pre-existing ._manual kept" || bad "pre-existing ._manual kept"

echo "== 9b. quick push (-q): sidecars of new top-level folders and their contents are cleaned too"
reset_dirs
mk "$T/up" "topic-new/inner" new q.txt
mkdir -p "$FAKEVOL/q"
OUT="$(PATH="$T/shim:$PATH" /bin/bash "$H" -s -q "$T/up" "$FAKEVOL/q" 2>&1)"
expect_files "quick push left no sidecars for uploaded items" "$FAKEVOL/q" "topic-new/inner/q.txt"

echo "== info: Unicode normalisation (not asserted; see docs-dev/webdav-test-plan.md)"
reset_dirs
NFD="$(printf 'Mu\xcc\x88ller')"; NFC="$(printf 'M\xc3\xbcller')"
mk "$FAKEVOL/n" "$NFD/Box" d f.txt
for form in NFC NFD; do
    rm -rf "$T/out"; mkdir "$T/out"
    /bin/bash "$H" -m "${!form}/Box" "$FAKEVOL/n" "$T/out" >/dev/null 2>&1
    echo "       $form literal vs NFD folder on this filesystem: $(files "$T/out" | wc -l | tr -d ' ') file(s) matched"
done

echo
echo "passed: $PASS   failed: $FAIL"
[[ $FAIL -eq 0 ]]
