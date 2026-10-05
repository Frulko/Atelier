#!/usr/bin/env bash
# Fabrique des dépôts git locaux (nus) à partir de fixtures/projects/*, pour tester
# la plateforme sans forge ni IA. Usage : scripts/fixtures.sh <dossier-de-sortie>
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../fixtures/projects" && pwd)"
OUT="$1"; mkdir -p "$OUT"
for d in "$SRC"/*/; do
  n=$(basename "$d"); T=$(mktemp -d)
  cp -R "$d". "$T"
  git -C "$T" init -q -b main
  git -C "$T" add -A && git -C "$T" -c user.name=demo -c user.email=demo@localhost commit -qm "état initial"
  rm -rf "$OUT/$n.git"; git clone -q --bare "$T" "$OUT/$n.git"; rm -rf "$T"
done
