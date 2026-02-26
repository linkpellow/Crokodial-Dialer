#!/bin/bash
set -e
cd '/Users/linkpellow/crokodialer standalone'
echo "Switching to feature branch..."
git fetch origin
git checkout claude/remove-textbox-label-UQWm2
echo "Pulling latest changes..."
git pull origin claude/remove-textbox-label-UQWm2
echo "Building..."
npm run pack:mac
echo "Launching..."
open 'release/mac-arm64/Crokodial Dialer.app'
