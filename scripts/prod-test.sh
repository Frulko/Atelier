#!/usr/bin/env bash
# Teste la pile de PRODUCTION (docker-compose.prod.yml) avec des images construites ici : elle démarre, devient « healthy »,
# sert l'application et accepte la première connexion. Sans IA, sans clé, sans forge. Utilisé par la CI et utilisable à la main.
set -euo pipefail
cd "$(dirname "$0")/.."
D="$HOME/.atelier-prodtest"; P=atelier-prodtest; ENVF="$(mktemp)"
cleanup() { docker compose -p $P --env-file "$ENVF" -f docker-compose.prod.yml down -v >/dev/null 2>&1 || true; rm -rf "$D" "$ENVF"; }
trap cleanup EXIT
fail() { echo "ÉCHEC : $1"; docker logs atelier-prodtest 2>&1 | tail -15 || true; exit 1; }

./scripts/release.sh local/atelier ci >/dev/null
mkdir -p "$D/work"
cat > "$ENVF" <<ENV
ATELIER_IMAGE=local/atelier:ci
ATELIER_SANDBOX_IMAGE=local/atelier-sandbox:ci
ATELIER_PASSWORD=prod-test-pw
ATELIER_PORT=18090
ATELIER_CONTAINER=atelier-prodtest
ATELIER_SANDBOX_NET=atelier-prodtest-net
ATELIER_WORKDIR=$D/work
ENV
docker compose -p $P --env-file "$ENVF" -f docker-compose.prod.yml up -d >/dev/null 2>&1 || fail "la pile ne démarre pas"
STATE=""
for _ in $(seq 45); do STATE=$(docker inspect -f '{{.State.Health.Status}}' atelier-prodtest 2>/dev/null || true); [ "$STATE" = healthy ] && break; sleep 2; done
[ "$STATE" = healthy ] || fail "l'orchestrateur n'est pas healthy (état : ${STATE:-inconnu})"
[ "$(curl -s -o /dev/null -w '%{http_code}' localhost:18090/)" = 200 ] || fail "l'application web ne répond pas"
LOGIN='{"email":"admin@localhost","password":"prod-test-pw"}'
[ "$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' -d "$LOGIN" localhost:18090/api/auth/login)" = 200 ] || fail "la première connexion échoue"
echo "PROD OK"
