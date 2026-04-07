# OLATTransfer
Script for macOS to transfer files to UZH OLAT

## Usage
```
olatTransfer.sh <source> <destination>
  One of source or destinations must begin with /Volumes/lms.uzh.ch
  Upload example: olatTransfer.sh "/local/path" "/Volumes/lms.uzh.ch/remote/path"
  Download example: olatTransfer.sh "/Volumes/lms.uzh.ch/remote/path" "/local/path"
```

## Requirements
- Check if your macOS `rsync` supports the argument `--inplace`. This can be done by executing the following in the Terminal: `rsync --help | grep inplace`. It should show a line with `--inplace`.



## Preparation
- [Enable WebDAV access to OLAT.](https://docs.olat.uzh.ch/en/manual_how-to/webdav/webdav/)

- Add OLAT login information to the Apple Keychain app, in the item named `lms.uzh.ch`. The most transparent way to do this is to connect to OLAT WebDAV in Finder once.
   1. In Finder, use menu **Go** → **Connect to Server…**.
   2. Type the server name `https://lms.uzh.ch`
   3. Click **Connect**. 
   4. **Check** the "Remember this password in my keychain.", and type in your user name and password. (❗️WebDAV login info differs from the info you'd use when logging in on the OLAT website.)
   4. When successful, you will see a new Finder window open with a folder `webdav`. 
   5. You can now disconnect from the WebDAV by clicking ⏏ button on the Finder's side bar. (If you cannot find it, it's OK. Once you restart your computer, it will be disconnected  automatically.)

- When you run the script for the first time, there will be several dialog boxes asking for several permissions (folder access, Keychain access). In some dialog box, the "Always allow" will allow you to run this script without being asked for permission in the future.