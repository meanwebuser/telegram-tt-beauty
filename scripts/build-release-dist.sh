#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=$(node -p "require('${ROOT_DIR}/package.json').version")
OUTPUT_DIR="${RELEASE_OUTPUT_DIR:-${ROOT_DIR}/release/artifacts/${VERSION}}"

if [[ -z "${TELEGRAM_API_ID:-}" || -z "${TELEGRAM_API_HASH:-}" ]]; then
  echo "TELEGRAM_API_ID and TELEGRAM_API_HASH are required for a production release build" >&2
  exit 2
fi

cd "$ROOT_DIR"
npm run build:production
mkdir -p "$OUTPUT_DIR"
tar -C dist -czf "${OUTPUT_DIR}/tchat-dist-${VERSION}.tar.gz" .
sha256sum "${OUTPUT_DIR}/tchat-dist-${VERSION}.tar.gz" > "${OUTPUT_DIR}/SHA256SUMS"
printf 'release=%s\narchive=%s\nchecksums=%s\n' "$VERSION" \
  "${OUTPUT_DIR}/tchat-dist-${VERSION}.tar.gz" "${OUTPUT_DIR}/SHA256SUMS"
