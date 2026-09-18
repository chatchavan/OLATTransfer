#!/bin/bash
bash "/Users/chat/local_git/OLATTransfer/olatTransfer.sh" -q \
	"/Users/chat/Library/Mobile Documents/com~apple~CloudDocs/_Projects/Projects and roles/IfI Lecturer - role/HCAI - IfI course/2026 HS HCAI/OLAT" \
	"/Volumes/lms.uzh.ch//webdav/coursefolders/26HS 22MI0038 Human-Centered AI/_courseelementdata/Materials"

# Note -q only push files that were changed in the last X days. X is configurable in OLATTransfer/config.yml.
