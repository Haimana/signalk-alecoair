#!/bin/sh
# Print the body of one CHANGELOG.md section, for the GitHub release (which the
# Signal K App Store shows in the plugin's Changelog tab).
# Usage: scripts/release-notes.sh 0.0.5 > release-notes/v0.0.5.md
# The "## X.Y.Z (date)" heading itself is left out (it is the release title);
# leading and trailing blank lines are trimmed.
set -eu
v="${1:?usage: $0 X.Y.Z}"
v="${v#v}"
dir="$(cd "$(dirname "$0")/.." && pwd)"
out="$(awk -v v="$v" '
  index($0, "## " v " ") == 1 || $0 == "## " v { on = 1; found = 1; next }
  on && /^## / { exit }
  on { print }
  END { if (!found) exit 3 }
' "$dir/CHANGELOG.md")" || { echo "No '## $v' section in CHANGELOG.md" >&2; exit 1; }
printf '%s\n' "$out" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
