#!/usr/bin/env bash
# Regenerate docs/img/*.png from docs/diagrams/*.mmd (Mermaid sources).
# Needs Node and a Chrome/Chromium: set CHROME_PATH if it is not at the macOS default.
set -euo pipefail
cd "$(dirname "$0")/.."
CHROME_PATH="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
CFG="$(mktemp)"; trap 'rm -f "$CFG"' EXIT
printf '{ "executablePath": "%s", "args": ["--no-sandbox"] }' "$CHROME_PATH" > "$CFG"
for f in docs/diagrams/*.mmd; do
  n="$(basename "$f" .mmd)"
  PUPPETEER_SKIP_DOWNLOAD=1 npx -y @mermaid-js/mermaid-cli -p "$CFG" -i "$f" -o "docs/img/$n.png" -b white -s 2 --quiet
  echo "docs/img/$n.png"
done
