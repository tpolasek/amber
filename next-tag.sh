#!/usr/bin/env bash
# Print the next version tag: patch +1, rolling over at 10 into the next
# section (v1.0.5 -> v1.0.6, v1.0.9 -> v1.1.0, v1.9.9 -> v2.0.0).
set -euo pipefail

latest=$(git tag --list 'v*' --sort=-v:refname | head -n1)

if [ -z "$latest" ]; then
  echo "v0.0.1"
  exit 0
fi

IFS=. read -r major minor patch <<<"${latest#v}"

patch=$((patch + 1))
if [ "$patch" -gt 9 ]; then
  patch=0
  minor=$((minor + 1))
fi
if [ "$minor" -gt 9 ]; then
  minor=0
  major=$((major + 1))
fi

printf 'v%s.%s.%s\n' "$major" "$minor" "$patch"
