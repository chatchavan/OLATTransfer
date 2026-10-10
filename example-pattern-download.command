#!/bin/bash
# Template: download one sub-path from every student folder (pattern mode).
# Copy per course/assignment, adjust the paths and the -m pattern.
# Add -n right after olatTransfer.sh to preview without copying.
bash "/Users/chat/local_git/OLATTransfer/olatTransfer.sh" \
	-m "*/Participant Drop Box/a1.1" \
	"/Volumes/lms.uzh.ch/webdav/coursefolders/Chat Wacharamanotham_s test OLAT course/_courseelementdata/Hand in" \
	"/Users/chat/Desktop/TestDownload"
