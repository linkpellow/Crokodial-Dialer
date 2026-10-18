#!/bin/bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mode="${1:---open}"

if [[ $# -gt 1 || ( "$mode" != "--check" && "$mode" != "--open" ) ]]; then
  echo "Usage: ./launch.sh [--check|--open]" >&2
  exit 2
fi

# The shared launcher verifies the product name, bundle identifier, source
# digest, and compiled archive before it opens the only supported native app.
# It never fetches, checks out, pulls, builds, or selects a fallback project.
exec /usr/bin/env node "$script_dir/../CrokodialSMS-1/scripts/workspace-app.mjs" "$mode"
