#!/usr/bin/env bash
# Démo locale SANS IA et SANS forge : 3 faux projets, un agent factice déterministe.
# Ouvre http://localhost:8080 (e-mail : admin@localhost, mot de passe : demo) et lance des demandes.
# Astuce : une demande contenant « casse » fait échouer la vérification, pour voir la correction automatique.
set -euo pipefail
cd "$(dirname "$0")/.."
D="$PWD/.demo"; mkdir -p "$D/work"
scripts/fixtures.sh "$D/fixtures"
cat > "$D/.env" <<ENV
ATELIER_PASSWORD=demo
ANTHROPIC_API_KEY=cle-bidon
ATELIER_FAKE_AGENT=1
ATELIER_ALLOW_LOCAL_REPOS=1
ATELIER_HEALTH_ALLOW_PRIVATE=1
ATELIER_WORKDIR=$D/work
FIXTURES_DIR=$D/fixtures
PROJECTS_JSON='$(tr -d '\n' < fixtures/projects.json)'
ENV
docker compose -p atelier-demo --env-file "$D/.env" -f docker-compose.yml -f docker-compose.fixtures.yml up -d --build
for _ in $(seq 40); do curl -sf localhost:8080/healthz >/dev/null && break; sleep 1; done
# Matière réaliste pour les graphiques, le journal et l'usage (idempotent : sans effet si déjà fait).
docker exec -i atelier-orchestrator node - < scripts/seed-demo.mjs || echo "(amorçage de la démo ignoré)"
echo "→ http://localhost:8080   (e-mail : admin@localhost · mot de passe : demo)"
echo "→ voir les branches créées : git --git-dir=$D/fixtures/mini-regie.git branch"
echo "→ arrêter : docker compose -p atelier-demo --env-file $D/.env -f docker-compose.yml -f docker-compose.fixtures.yml down -v"
