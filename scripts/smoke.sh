#!/usr/bin/env bash
# Test de bout en bout SANS clé API, SANS IA, SANS GitLab : agent factice + faux dépôts locaux.
# Vérifie : comptes et sessions (login, CSRF, mot de passe, déconnexion, limitation), copie → agent (bac à sable) → vérification → boucle de correction → commit → push → nettoyage.
set -euo pipefail
cd "$(dirname "$0")/.."
S="$PWD/.smoke"; rm -rf "$S"; mkdir -p "$S/work"
scripts/fixtures.sh "$S/fixtures"

cat > "$S/.env" <<ENV
ATELIER_PASSWORD=smoke
ANTHROPIC_API_KEY=cle-bidon
ATELIER_FAKE_AGENT=1
ATELIER_WORKDIR=$S/work
ATELIER_PORT=18080
ATELIER_CONTAINER=atelier-smoke-orchestrator
ATELIER_SANDBOX_NET=atelier-smoke-net
ATELIER_ALLOW_LOCAL_REPOS=1
ATELIER_HEALTH_ALLOW_PRIVATE=1
FIXTURES_DIR=$S/fixtures
PROJECTS_JSON='$(tr -d '\n' < fixtures/projects.json)'
ENV

DC="docker compose -p atelier-smoke --env-file $S/.env -f docker-compose.yml -f docker-compose.fixtures.yml"
trap '$DC down -v >/dev/null 2>&1 || true' EXIT
$DC up -d --build >/dev/null
for i in $(seq 30); do curl -sf localhost:18080/healthz >/dev/null && break; sleep 1; done

U=localhost:18080
fail() { echo "ÉCHEC : $*"; $DC logs orchestrator | tail -30; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
J=(-H 'content-type: application/json')
A=(-b "$S/jar" "${J[@]}")   # requêtes authentifiées (cookie de session)
login() { code -c "$1" "${J[@]}" $U/api/auth/login -d "{\"email\":\"admin@localhost\",\"password\":\"$2\"}"; }

# 1. Authentification : pas de session → 401 ; mauvais mot de passe → 401 ; bon → cookie
[ "$(code $U/api/orgs/0000000000000000/tasks)" = 401 ] || fail "l'API est ouverte sans session"
[ "$(login "$S/jar" faux)" = 401 ] || fail "un mauvais mot de passe est accepté"
[ "$(login "$S/jar" smoke)" = 200 ] || fail "connexion refusée avec le bon mot de passe"
curl -sf "${A[@]}" $U/api/me | grep -q '"email":"admin@localhost"' || fail "/api/me incorrect"
curl -sf "${A[@]}" $U/api/me | grep -q '"role":"owner"' || fail "le propriétaire n'a pas son rôle"
ORG=$(curl -sf "${A[@]}" $U/api/me | sed 's/.*"orgs":\[{"id":"\([0-9a-f]*\)".*/\1/')
[ ${#ORG} = 16 ] || fail "identifiant d'organisation introuvable dans /api/me"
O=$U/api/orgs/$ORG
[ "$(code "${A[@]}" $U/api/orgs/0000000000000000/tasks)" = 404 ] || fail "une organisation inconnue/étrangère n'est pas introuvable"
grep -q HttpOnly "$S/jar" || fail "cookie sans HttpOnly"

# Les projets sont en base (importés de la config au 1er démarrage) : on retrouve l'identifiant par le slug.
pid() { curl -sf "${A[@]}" $O/projects | grep -o '"id":"[0-9a-f]*","slug":"'"$1"'"' | sed 's/"id":"\([0-9a-f]*\)".*/\1/'; }
[ "$(curl -sf "${A[@]}" $O/projects | grep -o '"slug"' | wc -l | tr -d ' ')" = 3 ] || fail "les 3 projets de la config n'ont pas été importés"

# 2. CSRF : même avec un cookie valide, un POST venu d'une autre origine est refusé
BODY="{\"project\":\"$(pid mini-regie)\",\"prompt\":\"x\"}"
[ "$(code "${A[@]}" -H 'Origin: http://evil.example' $O/tasks -d "$BODY")" = 403 ] || fail "POST inter-origines accepté"

submit() { local body="{\"project\":\"$(pid "$1")\",\"prompt\":\"$2\"}"; curl -sf "${A[@]}" $O/tasks -d "$body" | sed 's/.*"id":"\([0-9a-f]*\)".*/\1/'; }
wait_done() {
  for i in $(seq 90); do
    ST=$(curl -sf "${A[@]}" $O/tasks/$1 | sed 's/.*"status":"\([a-z_]*\)".*/\1/')
    [ "$ST" = running ] || [ "$ST" = queued ] || break; sleep 1
  done
  [ "$ST" = done ] || { curl -s -m 2 "${A[@]}" $O/tasks/$1/events | grep -o '"type":"[a-z_]*","text":"[^"]*"'; fail "tâche $1 : statut $ST"; }
}
show() { git --git-dir="$S/fixtures/$1.git" show "atelier/$2:$3"; }

# 2. Demande normale : le calcul reste juste, une note est ajoutée, la branche est poussée
ID=$(submit mini-regie "ajoute le tarif dégressif"); wait_done "$ID"
show mini-regie "$ID" NOTES.md | grep -q "tarif dégressif" || fail "NOTES.md absent de la branche"

# 2b. Message de suite : un nouveau tour de l'agent sur la MÊME branche (la proposition s'enrichit, pas de nouvelle branche)
CID=$(curl -sf "${A[@]}" "$O/conversations?mode=task" | python3 -c 'import sys,json;print(next(c["id"] for c in json.load(sys.stdin)["items"] if c["taskId"]==sys.argv[1]))' "$ID")
[ "$(code "${A[@]}" $O/conversations/$CID/messages -d '{"text":"ajoute aussi les horaires"}')" = 201 ] || fail "le message de suite est refusé"
sleep 1; wait_done "$ID"
show mini-regie "$ID" NOTES.md | grep -q "tarif dégressif" || fail "l'ajustement a perdu le premier tour"
show mini-regie "$ID" NOTES.md | grep -q "horaires" || fail "l'ajustement n'est pas dans la branche"
SUBJECTS=$(git --git-dir="$S/fixtures/mini-regie.git" log "atelier/$ID" --format=%s)
grep -q "ajustement 2" <<<"$SUBJECTS" || fail "pas de commit d'ajustement sur la branche"

# 2c. Instructions du projet : l'agent les reçoit (le faux agent le dit dans le journal) et la plateforme l'écrit dans le journal
PB=$(pid boulangerie)
[ "$(code "${A[@]}" -X PATCH $O/projects/$PB -d '{"instructions":"Signe chaque page Le Fournil.","agentMaxTurns":5}')" = 200 ] || fail "réglages IA du projet refusés"
ID2=$(submit boulangerie "ajoute un pied de page"); wait_done "$ID2"
EV2=$(curl -s -m 3 "${A[@]}" "$O/tasks/$ID2/events" || true)
grep -q "Instructions du projet reçues" <<<"$EV2" || fail "l'agent n'a pas reçu les instructions du projet"
grep -q "Instructions du projet données" <<<"$EV2" || fail "le journal ne dit pas que les instructions ont été données"
curl -sf "${A[@]}" -X PATCH $O/projects/$PB -d '{"instructions":null,"agentMaxTurns":null}' >/dev/null || fail "effacement des réglages refusé"

# 3. Boucle de correction : le 1er essai casse la vérification, le 2e la répare
ID=$(submit todo-api "casse le projet"); wait_done "$ID"
# le flux SSE reste ouvert : curl sort sur délai (code 28), d'où le `|| true`
EV=$(curl -s -m 3 "${A[@]}" "$O/tasks/$ID/events" || true)
grep -q check_failed <<<"$EV" || fail "aucun échec de vérification enregistré"
! show todo-api "$ID" casse.js >/dev/null 2>&1 || fail "le fichier invalide est resté dans la branche"
show todo-api "$ID" NOTES.md | grep -q "casse le projet" || fail "le changement valide a disparu après la correction"

# 3b. Éditeur : une session privée, un brouillon, la vérification dans le bac à sable, puis un commit sur une branche
ED=$(curl -sf "${A[@]}" $O/editor/sessions -d "{\"projectId\":\"$(pid todo-api)\"}")
EID=$(sed 's/.*"id":"\([0-9a-f]*\)".*/\1/' <<<"$ED"); EBR=$(sed 's/.*"branch":"\([^"]*\)".*/\1/' <<<"$ED")
[ "$(code "${A[@]}" -X PUT $O/editor/sessions/$EID/file -d '{"path":"EDITE.md","content":"fait à la main\n"}')" = 200 ] || fail "enregistrement d'un brouillon refusé"
[ "$(code "${A[@]}" -X PUT $O/editor/sessions/$EID/file -d '{"path":"../evasion","content":"x"}')" = 400 ] || fail "chemin hors de l'arbre accepté"
CHK=$(curl -sf "${A[@]}" $O/editor/sessions/$EID/check -d '{}')
grep -q '"ok":true' <<<"$CHK" || fail "la vérification de l'éditeur a échoué : $CHK"
COM=$(curl -sf "${A[@]}" $O/editor/sessions/$EID/commit -d '{"message":"Ajoute EDITE.md à la main"}') || fail "commit de l'éditeur refusé"
grep -q '"files":1' <<<"$COM" || fail "commit inattendu : $COM"
git --git-dir="$S/fixtures/todo-api.git" show "$EBR:EDITE.md" | grep -q "fait à la main" || fail "le commit de l'éditeur n'est pas sur la branche"
[ "$(code "${A[@]}" -X DELETE $O/editor/sessions/$EID)" = 200 ] || fail "abandon de la session refusé"

# 4. Nettoyage : plus aucun dossier de travail, plus aucun conteneur d'agent
[ -z "$(ls -A "$S/work" | grep -v '^_status$')" ] || fail "dossier de travail non nettoyé"
[ -z "$(docker ps -aq --filter label=atelier)" ] || fail "conteneur d'agent resté"
# 4b. Invitation : un nouveau compte rejoint l'organisation avec le rôle prévu, le lien ne sert qu'une fois
IB='{"email":"neuf@smoke.test","role":"member"}'
INV=$(curl -sf "${A[@]}" $O/invitations -d "$IB" | sed 's/.*"token":"\([^"]*\)".*/\1/')
case "$INV" in inv_*) ;; *) fail "jeton d'invitation absent de la réponse" ;; esac
AB="{\"token\":\"$INV\",\"password\":\"mdp-neuf-12345\"}"
[ "$(code -c "$S/jar5" "${J[@]}" $U/api/auth/accept-invite -d "$AB")" = 201 ] || fail "invitation refusée"
curl -sf -b "$S/jar5" $U/api/me | grep -q '"role":"member"' || fail "le nouveau compte n'a pas le rôle invité"
[ "$(code "${J[@]}" $U/api/auth/accept-invite -d "$AB")" = 404 ] || fail "le lien d'invitation a servi deux fois"
[ "$(code -b "$S/jar5" $O/members)" = 403 ] || fail "un membre peut lister les membres"
[ "$(code -b "$S/jar5" $O/tasks)" = 200 ] || fail "le nouveau membre ne voit pas les tâches"

# 4c. Interface web pilotée dans un vrai navigateur (si Playwright est installé : pip install playwright)
if python3 -c "import playwright" 2>/dev/null; then
  python3 scripts/ui_check.py "http://localhost:18080" admin@localhost smoke || fail "le test de l'interface a échoué"
else
  echo "test de l'interface ignoré (pip install playwright pour l'activer)"
fi

# 5. Mot de passe : changer le mot de passe déconnecte les AUTRES appareils, pas celui-ci
[ "$(login "$S/jar2" smoke)" = 200 ] || fail "2e appareil : connexion refusée"
[ "$(code "${A[@]}" $U/api/auth/password -d '{"current":"faux","next":"nouveau-mdp-123"}')" = 403 ] || fail "changement accepté avec un mauvais mot de passe actuel"
[ "$(code "${A[@]}" $U/api/auth/password -d '{"current":"smoke","next":"court"}')" = 400 ] || fail "mot de passe trop court accepté"
[ "$(code "${A[@]}" $U/api/auth/password -d '{"current":"smoke","next":"nouveau-mdp-123"}')" = 200 ] || fail "changement de mot de passe refusé"
[ "$(code -b "$S/jar2" $U/api/me)" = 401 ] || fail "l'autre appareil est resté connecté"
[ "$(code "${A[@]}" $U/api/me)" = 200 ] || fail "l'appareil courant a été déconnecté"
[ "$(login "$S/jar3" smoke)" = 401 ] || fail "l'ancien mot de passe fonctionne encore"
[ "$(login "$S/jar3" nouveau-mdp-123)" = 200 ] || fail "le nouveau mot de passe ne fonctionne pas"

# 6. Déconnexion : le cookie ne vaut plus rien
[ "$(code "${A[@]}" -X POST $U/api/auth/logout)" = 200 ] || fail "déconnexion refusée"
[ "$(code "${A[@]}" $U/api/me)" = 401 ] || fail "session encore valide après déconnexion"

# 7. Limitation : 5 échecs → 429, même avec le bon mot de passe ensuite
for i in 1 2 3 4 5; do login "$S/jar4" faux >/dev/null; done
[ "$(login "$S/jar4" nouveau-mdp-123)" = 429 ] || fail "pas de limitation après 5 échecs"
echo "SMOKE OK"
