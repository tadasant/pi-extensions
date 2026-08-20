#!/bin/sh
# An AIR hook: a non-zero exit blocks the event, with stderr as the reason.
echo "AIR plugin hook refused this: direct production deploys go through the release skill." >&2
exit 1
