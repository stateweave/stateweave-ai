#!/usr/bin/env bash
set -euo pipefail
sdk_dir="${1:-/root/projects/sdk-typescript}"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$repo_dir/.stateweave-sdk"
mkdir -p "$repo_dir/.stateweave-sdk"
cp "$repo_dir/vendor/stateweave-package.json" "$repo_dir/.stateweave-sdk/package.json"
cp -a "$sdk_dir/dist" "$repo_dir/.stateweave-sdk/dist"
printf 'Synced StateWeave SDK from %s\n' "$sdk_dir"
