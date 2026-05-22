#!/bin/bash
# Move ~/.palace/sessions/ files older than 30 days to ~/.palace/archive/YYYY-MM/
# Archive is permanent. Delete only as last resort when disk space is critically constrained.
set -e

SESSIONS_DIR="$HOME/.palace/sessions"
ARCHIVE_DIR="$HOME/.palace/archive"

if [ ! -d "$SESSIONS_DIR" ]; then
  echo "No sessions directory found — nothing to archive."
  exit 0
fi

count=0
while IFS= read -r -d '' file; do
  # Get YYYY-MM from file modification date (macOS stat syntax)
  if [[ "$(uname)" == "Darwin" ]]; then
    month=$(stat -f "%Sm" -t "%Y-%m" "$file")
  else
    month=$(date -r "$file" "+%Y-%m")
  fi

  dest_dir="$ARCHIVE_DIR/$month"
  mkdir -p "$dest_dir"
  mv "$file" "$dest_dir/"
  count=$((count + 1))
done < <(find "$SESSIONS_DIR" -name "*.md" -mtime +30 -print0)

echo "Archived $count session file(s) to $ARCHIVE_DIR"
