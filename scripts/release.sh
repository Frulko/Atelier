#!/usr/bin/env bash
# Construit (et publie) les deux images : l'orchestrateur (avec l'application web) et le bac à sable.
#
#   ./scripts/release.sh ghcr.io/votre-compte/atelier 1.0.0             # construit pour cette machine, charge en local
#   ./scripts/release.sh ghcr.io/votre-compte/atelier 1.0.0 --push      # multi-architecture (amd64 + arm64), publie, ajoute « latest »
#
# Produit  <dépôt>:<version>  et  <dépôt>-sandbox:<version>. Avant --push : docker login <registre>.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${1:?depot d images, ex. ghcr.io/votre-compte/atelier}"; VERSION="${2:?version, ex. 1.0.0}"; MODE="${3:-}"
SOURCE="${ATELIER_SOURCE:-$(git config --get remote.origin.url 2>/dev/null || true)}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
ARGS=(--build-arg "ATELIER_VERSION=$VERSION" --build-arg "ATELIER_SOURCE=$SOURCE")

build() {  # build <image> <contexte> <dockerfile>
  local image="$1" ctx="$2" file="$3"
  if [ "$MODE" = "--push" ]; then
    docker buildx build --platform "$PLATFORMS" "${ARGS[@]}" -t "$image:$VERSION" -t "$image:latest" -f "$file" --push "$ctx"
  else
    docker build "${ARGS[@]}" -t "$image:$VERSION" -f "$file" "$ctx"
  fi
}
build "$REPO" . orchestrator/Dockerfile
build "$REPO-sandbox" sandbox sandbox/Dockerfile

NOTE=""; [ "$MODE" = "--push" ] && NOTE="  (publiées, avec le tag latest)"
echo
echo "Images : $REPO:$VERSION  et  $REPO-sandbox:$VERSION$NOTE"
echo "Variables à donner à docker-compose.prod.yml :"
echo "  ATELIER_IMAGE=$REPO:$VERSION"
echo "  ATELIER_SANDBOX_IMAGE=$REPO-sandbox:$VERSION"
