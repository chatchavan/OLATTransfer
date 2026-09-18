# OLATTransfer
Script for macOS to transfer files to UZH OLAT

## Usage
```
olatTransfer.sh [-d] [-q] <source> <destination>
  One of source or destination must begin with /Volumes/lms.uzh.ch
  -d   Execute the final eject and disconnect steps after transfer.
  -q   Quick push (upload only): only sync top-level source folders that
       contain a file changed within the lookback window (see config.yml).
       Never deletes remote files/folders; run a normal upload for that.
  Upload example: olatTransfer.sh "/local/path" "/Volumes/lms.uzh.ch/remote/path"
  Download example: olatTransfer.sh "/Volumes/lms.uzh.ch/remote/path" "/local/path"
  Quick upload example: olatTransfer.sh -q "/local/path" "/Volumes/lms.uzh.ch/remote/path"
```
*If you omit `-d`, the WebDAV volume remains mounted after the transfer.*

## Quick push (`-q`)

Uploading a whole course folder with plain rsync is slow because it has to
list every remote file over WebDAV, even when almost nothing changed since
last time (e.g. pushing this week's lecture material). `-q` speeds this up
by skipping the whole-tree comparison: it only looks at the local source,
picks the top-level folders (e.g. `w05-topic`) that contain a file modified
within the last N days, and uploads just those folders.

- The lookback window `N` is configured in [`config.yml`](config.yml)
  (`lookback_days`, default 14) — one setting shared by all courses.
- Quick push never passes `--delete`. If you rename or remove a folder
  locally, run a normal (non-`-q`) upload afterwards to reconcile the
  remote side — see [`example-upload.command`](example-upload.command).
- Loose files sitting directly in the source folder (not inside a
  subfolder) are not picked up by quick push, only files inside top-level
  subfolders are considered.
- See [`example-quick-upload.command`](example-quick-upload.command) for a
  template to copy per course, alongside your existing full-upload
  `.command` file.

## Idle auto-disconnect

Leaving the WebDAV connection mounted (the default when you omit `-d`) is
deliberate — it avoids reconnecting for every transfer, which is what keeps
you under UZH's connection-rate limit (see "Pragmatic choices" below). But a
connection left mounted forever is also not great, so `olatTransfer.sh`
automatically installs a small background helper the first time it runs
that disconnects the WebDAV volume on its own after it's been idle for a
while:

- After `idle_disconnect_minutes` (default 10, [`config.yml`](config.yml))
  with no `olatTransfer.sh` activity, it ejects the volume if still mounted.
  Any transfer — upload, download, or quick push — restarts this countdown.
- It checks every `idle_poll_minutes` (default 5). Change either value in
  `config.yml`; it takes effect the next time you run a transfer.
- Before ejecting, it checks whether any Finder window is currently open on
  the volume, and skips the eject (retrying on the next check) if so — it
  never disconnects out from under you while you're browsing it in Finder.
  This only recognizes Finder; another app with a file open from the volume
  isn't detected. If the eject itself still fails for some other reason
  (e.g. a file genuinely locked/in use), it likewise just logs that and
  quietly retries later — it never force-ejects.
- If `olatTransfer.sh` hasn't run at all for `idle_agent_ttl_hours` (default
  12), the helper disconnects the volume one last time and removes itself,
  rather than polling forever. It reinstalls automatically next time you
  run a transfer.
- This runs as a per-user background job (`com.local.olattransfer.idle-eject`
  in `~/Library/LaunchAgents/`), independent of whether any Terminal window
  is open. Activity is logged to `~/Library/Logs/OLATTransfer/idle-eject.log`
  (capped at 5 MB).
- The very first automatic eject attempt may need you to grant Automation
  permission for controlling Finder (macOS may prompt once, the same as the
  mount step already does — see "Preparation" below). If disconnects don't
  seem to be happening, check that log file and
  **System Settings → Privacy & Security → Automation**.

## Requirements
- Check if your macOS `rsync` supports the argument `--inplace`. This can be done by executing the following in the Terminal: `rsync --help | grep inplace`. It should show a line with `--inplace`.

## Preparation
- [Enable WebDAV access to OLAT.](https://docs.olat.uzh.ch/en/manual_how-to/webdav/webdav/)

- Add OLAT login information to the Apple Keychain app, in the item named `lms.uzh.ch`. The most transparent way to do this is to connect to OLAT WebDAV in Finder once.
   1. In Finder, use menu **Go** → **Connect to Server…**.
   2. Type the server name `https://lms.uzh.ch`
   3. Click **Connect**.
   4. **Check** the "Remember this password in my keychain.", and type in your user name and password. (❗️WebDAV login info differs from the info you'd use when logging in on the OLAT website.)
   5. When successful, you will see a new Finder window open with a folder `webdav`.
   6. You can now disconnect from the WebDAV by clicking ⏏ button on the Finder's side bar. (If you cannot find it, it's OK. Once you restart your computer, it will be disconnected automatically.)

- When you run the script for the first time, there will be several dialog boxes asking for permissions (folder access, Keychain access). In some dialog box, the "Always allow" will let you run this script without being asked for permission in the future.


## Pragmatic choices made in this script
- The script calls `rsync` with the `--size-only` argument. This means that if a file at the destination has the same size as the source, that file is not transferred. We chose this because the OLAT WebDAV server at UZH doesn't preserve modification time.

- By default, calling `olatTransfer.sh` without the option `-d` keeps the connection open. This prevents the client's IP from getting banned by UZH OLAT connection limits.