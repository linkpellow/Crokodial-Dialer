#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Pulling latest changes..."
git pull
echo "Building..."
npm run pack:mac
echo "Launching..."
open 'release/mac-arm64/Crokodial Dialer.app'
