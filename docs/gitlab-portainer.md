# Mettre Atelier en ligne avec GitLab et Portainer

Pour exécuter une livraison avec une fiche courte, utiliser la [note de déploiement](note-deploiement.md).

Ce tutoriel déploie **Atelier lui-même** sur un serveur Linux avec Docker Standalone et Portainer. GitLab auto-hébergé conserve le code et les images dans son registre privé. Les applications créées ensuite par les utilisateurs sont publiées par Atelier, indépendamment de ce pipeline.

Le parcours : préparer GitLab et ses runners, publier les images, créer la stack Portainer, activer HTTPS et Keycloak, configurer l'IA, puis automatiser les mises à jour et sauvegarder les données.

## 1. Préparer les noms et les machines

Remplace ces exemples partout :

| Exemple | Rôle |
|---|---|
| `gitlab.example.com/equipe/atelier` | Projet GitLab **privé** |
| `registry.example.com/equipe/atelier` | Chemin du registre, à copier dans GitLab |
| `atelier.example.com` | Interface Atelier |
| `sso.example.com/realms/atelier` | Realm Keycloak existant |
| `apps.example.net` | Domaine distinct pour les applications publiées |
| `portainer.example.com` | Administration, accessible par VPN ou réseau d'administration |

Prévois une machine de production dédiée et une machine/VM distincte pour la CI Docker. Pour démarrer, 4 vCPU, 8 Go de RAM et 50 Go de disque par machine constituent un point de départ à ajuster selon la concurrence et la taille des builds, pas un minimum mesuré. Une sandbox Chromium et les images Docker consomment de la place.

Sur la production, installe [Docker Engine et le plugin Compose](https://docs.docker.com/engine/install/ubuntu/), puis [Portainer pour Docker Standalone](https://docs.portainer.io/start/install-ce/server/docker/linux). Le tutoriel suppose qu'un reverse proxy HTTPS et Keycloak sont déjà disponibles ; leurs bases de données et leur exploitation restent à gérer séparément. Utilise une version maintenue de Portainer, épinglée selon sa documentation.

N'utilise pas Docker Swarm pour cette stack : Atelier démarre les sandboxes sur le démon local, avec des chemins de montage locaux. Garde un seul orchestrateur.

DNS à créer vers le reverse proxy : `atelier.example.com` et `*.apps.example.net`. N'ajoute un enregistrement IPv6 que si le serveur et le proxy répondent effectivement en IPv6.

## 2. Préparer le projet GitLab

1. Crée un projet **privé** vide, sans README initial si tu importes ce dépôt.
2. Vérifie que **Container Registry** est activé. Dans **Deploy → Container Registry** ou **Packages and registries**, copie son chemin exact. Sur une instance auto-hébergée, le domaine et le port peuvent différer de ceux de GitLab.
3. Dans les règles du dépôt, protège la branche par défaut (`main`), `staging` si utilisée et les tags `v*`. Réserve leur écriture aux responsables des livraisons.
4. Pousse le code après l'avoir relu :

```bash
git remote add gitlab git@gitlab.example.com:equipe/atelier.git
git push gitlab main
```

La commande suppose que les changements ont été commités et que la branche locale s'appelle `main`. Si le remote `gitlab` existe déjà, vérifie son URL avec `git remote -v` et adapte-la, sans écraser un remote utile. Ne commite aucun `.env` ni jeton.

Le fichier [`.gitlab-ci.yml`](../.gitlab-ci.yml) réutilise les templates BuildKit et déploiement de `myrole/ci-templates`, comme MyRole 3. Leur révision est épinglée au commit `9a47c54da0256171eaa59dca8afc9d94dd99a679`, correspondant au tag `v1` inspecté. Les personnes lançant les pipelines doivent pouvoir lire ce projet privé. Aucune clé Anthropic, Discord, Telegram ou Keycloak n'est nécessaire pour tester et publier les images.

### Les deux types de runners

| Runner | Configuration | Utilisation |
|---|---|---|
| Contrôles, builds et déploiement | Exécuteur **Docker**, accepte les jobs sans tag, images `node:24-bookworm` et BuildKit du template, sans socket Docker | Types/tests et compilation ; BuildKit publie les images ; Node appelle le webhook |
| Intégration | Exécuteur **Shell**, tag `atelier-docker`, **Protected**, verrouillé à ce projet, n'accepte pas les jobs sans tag | Tests Docker complets avant les builds, sur branche par défaut, staging et tags protégés |

Le runner Docker existant de MyRole peut servir aux contrôles et builds si ses permissions permettent BuildKit rootless ou l'accès au builder persistant TLS du template. Le runner Shell doit résider sur une VM dédiée, sans données de production : l'accès au groupe Docker permet de contrôler son hôte. Les contributions non fiables ne doivent jamais s'exécuter sur ce runner. Pour une isolation plus forte entre jobs, utilise des VM de CI éphémères. [Documentation GitLab sur Docker dans les jobs](https://docs.gitlab.com/ci/docker/using_docker_build/).

Le template choisit le builder persistant lorsque ses certificats `BUILDKIT_TLS_CA`, `BUILDKIT_TLS_CERT` et `BUILDKIT_TLS_KEY` permettent de le joindre ; sinon il utilise `buildctl-daemonless.sh`. Configure ces variables comme dans l'infrastructure MyRole si ce builder est utilisé. [BuildKit dans GitLab](https://docs.gitlab.com/ci/docker/using_buildkit/).

### Installer et enregistrer les runners

Installe GitLab Runner via le [dépôt officiel](https://docs.gitlab.com/runner/install/linux-repository/) sur les machines de CI. Dans **Settings → CI/CD → Runners → New project runner**, crée chaque runner avec les options du tableau. Utilise le nouveau **runner authentication token** (`glrt-…`), pas les anciens registration tokens. Lance ensuite l'enregistrement interactif sur la machine concernée :

```bash
sudo gitlab-runner register
```

Renseigne l'URL HTTPS de ton GitLab, le token affiché, puis `docker` pour le runner de contrôles ou `shell` pour celui d'intégration. Pour le runner Docker, prends `node:24-bookworm` comme image par défaut ; n'ajoute aucun montage de `/var/run/docker.sock`.

Sur la VM du runner Shell, installe Docker Engine, Compose et Buildx, **Node.js 24** disponible pour le compte système `gitlab-runner`, Git, curl, Python 3 et son module venv. Vérifie que le stockage Docker dispose de place. Puis, sur Ubuntu/Debian :

```bash
sudo apt-get update
sudo apt-get install -y git curl python3 python3-venv
sudo usermod -aG docker gitlab-runner
sudo python3 -m venv /opt/atelier-ci
sudo /opt/atelier-ci/bin/pip install playwright
sudo /opt/atelier-ci/bin/python -m playwright install-deps chromium
sudo -u gitlab-runner -H /opt/atelier-ci/bin/python -m playwright install chromium
sudo systemctl restart gitlab-runner

sudo -u gitlab-runner -H node --version
sudo -u gitlab-runner -H docker info
sudo -u gitlab-runner -H docker compose version
sudo -u gitlab-runner -H docker buildx version
```

La première vérification doit afficher `v24.…`. Une installation Node faite uniquement dans le profil personnel d'un administrateur ne suffit pas. Le pipeline ajoute le venv Python à son PATH et refuse de sauter les tests navigateur si Playwright est absent.

Le runner Docker et le runner Shell peuvent partager une **machine de CI dédiée**, mais pas le serveur de production. Règle sa concurrence à `1` si cette machine leur est réservée. Les jobs utilisant le démon Docker sont aussi sérialisés par `resource_group`, car les tests utilisent des noms fixes.

Le pipeline publie `linux/amd64` par défaut. Pour un serveur ARM64, configure `PLATFORMS=linux/arm64` et un builder compatible. Le multiarchitecture (`linux/amd64,linux/arm64`) exige des workers/une émulation appropriés ; ne l'active pas sans les préparer.

### Certificats internes

Si GitLab ou le registre utilise une autorité interne, installe sa CA sur les hôtes runners et production, dans GitLab Runner et dans les images de jobs qui accèdent à ces services. Configure également la confiance Docker pour le registre, par exemple `/etc/docker/certs.d/registry.example.com/ca.crt` (inclure `:port` dans le répertoire si nécessaire). Redémarre les services concernés. Ne désactive pas TLS avec `insecure-registries`, `GIT_SSL_NO_VERIFY` ou `curl -k`.

L'orchestrateur doit aussi faire confiance à cette CA pour GitLab et Keycloak. Au besoin, dérive l'image publiée avec la CA installée via `update-ca-certificates`, configure `NODE_EXTRA_CA_CERTS` vers ce fichier et conserve cette personnalisation dans le pipeline. Une CA installée seulement sur l'hôte ne devient pas automatiquement fiable dans un conteneur. Ce tutoriel fonctionne directement avec des certificats publiquement reconnus.

## 3. Publier la première version

Une fois le code commité et `main` poussé :

```bash
git tag v1.0.0
git push gitlab v1.0.0
```

Choisis un numéro encore inutilisé. Dans **Build → Pipelines**, attends la réussite des étapes :

1. `checks` : types, tests serveur/interface et build web ;
2. `integration` : tests Docker avec navigateur, puis démarrage de la stack de production ;
3. `build-orchestrator` et `build-sandbox` : publication des **deux images privées** via BuildKit ;
4. `deploy` : appel du webhook de production s'il est configuré, une fois les deux builds réussis.

Pour l'exemple, les images seront :

```text
registry.example.com/equipe/atelier/atelier:1.0.0
registry.example.com/equipe/atelier/atelier-sandbox:1.0.0
```

Le double `atelier/atelier` est normal : le premier appartient au chemin du projet, le second est le nom de l'image. Les deux builds publient toujours `commit-<SHA complet>`. Ils ajoutent `latest` sur la branche par défaut, `staging` sur la branche staging, ou `1.0.0` pour le tag `v1.0.0`. Le déploiement CI utilise toujours **le tag `commit-<SHA>` pour les deux images**, afin de livrer exactement les builds de sa pipeline. Ne republie pas un tag de version déjà utilisé.

L'authentification de publication utilise les identifiants temporaires `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD` fournis par GitLab ; aucun PAT permanent à ajouter. [Documentation du registre GitLab](https://docs.gitlab.com/user/packages/container_registry/build_and_push_images/).

## 4. Donner à Portainer l'accès aux images

Dans GitLab, **Settings → Repository → Deploy tokens**, crée `portainer-pull`, avec expiration et le seul droit **`read_registry`**. Conserve son nom d'utilisateur et son secret dans ton gestionnaire de mots de passe. Ce token ne sert ni à pousser du code, ni à créer des merge requests. [Droits des deploy tokens](https://docs.gitlab.com/user/project/deploy_tokens/).

Dans Portainer :

1. **Registries → Add registry**, choisis GitLab ou un registre personnalisé selon ta version.
2. Renseigne le serveur exact (`registry.example.com`, éventuellement `:port`), l'utilisateur du deploy token et son secret. Ne mets pas le chemin `equipe/atelier` dans l'adresse du serveur.
3. Autorise l'environnement Docker de production à utiliser ce registre. Sélectionne-le lors du déploiement de la stack si Portainer le propose.

Le token GitLab de la CI expire à la fin du job : ne l'utilise pas comme mot de passe permanent dans Portainer. Le service `sandbox-image` tirera l'image sur le démon de production pour que les agents puissent ensuite démarrer sans authentification au registre dans leurs sandboxes.

## 5. Créer la stack Portainer

Sur le **serveur Docker de production**, prépare le dossier persistant :

```bash
sudo mkdir -p /srv/atelier/work
sudo chmod 700 /srv/atelier/work
openssl rand -base64 32
```

La dernière commande génère la clé maître. Place-la dans un gestionnaire de secrets et dans `ATELIER_MASTER_KEY`, puis conserve-la durablement. Ne la régénère pas lors d'une mise à jour : les secrets existants deviendraient illisibles.

Dans Portainer, sélectionne l'environnement **Docker Standalone → Stacks → Add stack** :

- Nom : **`atelier`** ; garde ce nom pour les mises à jour.
- Méthode : **Web editor**.
- Colle le contenu de [`docker-compose.prod.yml`](../docker-compose.prod.yml).
- Dans **Environment variables**, saisis les valeurs ci-dessous. Les `REMPLACER_…` sont des valeurs à remplacer, jamais des mots de passe à conserver.

```dotenv
ATELIER_IMAGE=registry.example.com/equipe/atelier/atelier:1.0.0
ATELIER_SANDBOX_IMAGE=registry.example.com/equipe/atelier/atelier-sandbox:1.0.0
ATELIER_BOOTSTRAP_EMAIL=admin@example.com
ATELIER_PASSWORD=REMPLACER_PAR_UN_MOT_DE_PASSE_LONG_UNIQUE
ATELIER_MASTER_KEY=REMPLACER_PAR_LA_CLE_BASE64
ATELIER_WORKDIR=/srv/atelier/work
ATELIER_CONTAINER=atelier-orchestrator
ATELIER_SANDBOX_NET=atelier-sandbox
ATELIER_PORT=127.0.0.1:8080
ATELIER_APPS_BIND=127.0.0.1
ATELIER_APPS_PORT=8082
ATELIER_PUBLIC_URL=https://atelier.example.com
TRUST_PROXY=1
COOKIE_SECURE=1
ATELIER_APPS_DOMAIN=apps.example.net
ATELIER_APPS_SCHEME=https
ATELIER_PUSH_SUBJECT=mailto:admin@example.com
ATELIER_GIT_HOSTS=gitlab.example.com
MAX_BUDGET_USD=2
```

`ATELIER_PORT=127.0.0.1:8080` produit ici le mapping Compose `127.0.0.1:8080:8080` : le port de l'interface reste sur la boucle locale. `MAX_BUDGET_USD` limite un tour d'agent ; il ne configure pas les 200 $ mensuels. Si les réseaux Docker/LAN/VPN occupent déjà `10.240.0.0/16`, ajoute `ATELIER_APPS_SUBNET_POOL` avec un autre `/16` privé disponible.

Si le nom GitLab résout vers une IP privée, ajoute **aussi** `ATELIER_GIT_ALLOW_PRIVATE=1` ; son nom doit toujours figurer dans `ATELIER_GIT_HOSTS`. N'active pas cette option si elle n'est pas nécessaire.

Clique **Deploy the stack**. L'orchestrateur doit devenir **healthy**. Le service `sandbox-image` doit finir avec **exit code 0** : il ne fait que télécharger l'image et s'arrêter. Ce n'est pas une panne.

Le chemin `/srv/atelier/work` doit exister sur le serveur Docker ciblé, avec le **même chemin à l'intérieur et à l'extérieur** du conteneur. Un dossier sur le serveur Portainer ne suffit pas si l'environnement Docker est une autre machine.

Portainer conserve ces variables dans sa configuration ; les administrateurs Docker/Portainer peuvent les lire. Restreins ces accès. Le socket Docker monté dans l'orchestrateur lui donne des pouvoirs équivalents à root sur cet hôte.

Cette méthode Web editor évite de donner à Portainer un accès au dépôt source. Portainer permet aussi une stack Git, mais les instructions d'automatisation ci-dessous ciblent précisément une stack **Web editor**. [Création de stack Portainer](https://docs.portainer.io/user/docker/stacks/add).

## 6. Activer HTTPS pour Atelier et les applications

### Proxy installé directement sur l'hôte

Configure deux destinations dans ton reverse proxy :

| Hôte HTTPS | Destination HTTP | Certificat |
|---|---|---|
| `atelier.example.com` | `127.0.0.1:8080` | Certificat de ce nom |
| `*.apps.example.net` | `127.0.0.1:8082` | Wildcard obtenu par challenge DNS |

Conserve le `Host` original sur la passerelle des applications et transmets `X-Forwarded-Proto: https`. Pour les réponses en continu, désactive la mise en tampon du proxy et configure un délai de lecture de plusieurs minutes.

### Proxy dans un conteneur, par exemple Nginx Proxy Manager

`127.0.0.1` désigne le conteneur du proxy, pas l'hôte. Pour rendre la connexion durable, utilise un réseau Docker externe partagé :

```bash
docker network create atelier-proxy
```

Dans le Compose collé dans Portainer, ajoute `proxy` aux réseaux de **l'orchestrateur seulement** :

```yaml
services:
  orchestrator:
    # ... conserve toutes les autres propriétés existantes
    networks: [default, sandbox, proxy]

networks:
  # ... conserve le réseau sandbox existant et son internal: true
  proxy:
    external: true
    name: atelier-proxy
```

Ceci est un extrait à fusionner : ne colle pas un second bloc `services` ou `networks` à la fin du YAML. Dans le Compose de Nginx Proxy Manager, déclare le même réseau externe et ajoute-le aux réseaux existants de son service proxy, en conservant son réseau avec sa base de données. Redéploie les deux stacks.

Configure ensuite les Proxy Hosts : `atelier.example.com` vers **`atelier-orchestrator:8080`**, et `*.apps.example.net` vers **`atelier-orchestrator:8082`**, schéma amont `http`. Active SSL/Force SSL, préserve Host, active les flux sans buffering et règle le délai de lecture. Le certificat wildcard exige le challenge DNS de ton fournisseur. Les ports hôte peuvent rester liés à `127.0.0.1`. Ne connecte jamais le proxy au réseau `atelier-sandbox`. [Réseau partagé recommandé par Nginx Proxy Manager](https://nginxproxymanager.com/advanced-config/).

Vérifie depuis ton poste :

```bash
curl --fail https://atelier.example.com/healthz
```

Résultat attendu : `ok`, puis la page de connexion dans le navigateur. Les ports **8080, 8081 et 8082** ne doivent pas être publics. Expose le proxy sur 80/443 ; garde Portainer, SSH et les interfaces d'administration derrière les accès prévus. Vérifie effectivement les ports exposés par Docker : un pare-feu hôte mal configuré ne suffit pas à les filtrer.

## 7. Brancher Keycloak et configurer l'IA

Dans ton realm Keycloak existant, crée un client OIDC :

| Paramètre | Valeur |
|---|---|
| Client ID | `atelier` |
| Client authentication | Activée, client confidentiel |
| Standard flow | Activé |
| PKCE | `S256` |
| Signature ID token | `RS256` |
| Valid redirect URI | `https://atelier.example.com/api/auth/sso/callback` |

Évite les redirect URIs wildcard. Configure des e-mails vérifiés pour les comptes qui seront associés. Dans les variables de stack Portainer, ajoute :

```dotenv
ATELIER_OIDC_ISSUER=https://sso.example.com/realms/atelier
ATELIER_OIDC_CLIENT_ID=atelier
ATELIER_OIDC_CLIENT_SECRET=REMPLACER_PAR_LE_SECRET_DU_CLIENT
```

Redéploie la stack sans changer les images. L'issuer et les endpoints de découverte, autorisation, token et JWKS doivent être HTTPS sur la même origine. Consulte [les détails SSO d'Atelier](deployment.md#keycloak-sso-alongside-passwords) pour les contraintes exactes.

Ensuite :

1. Connecte-toi avec `ATELIER_BOOTSTRAP_EMAIL` et le mot de passe initial, puis change ce mot de passe dans **Mon compte**. La variable de bootstrap ne réinitialise pas un compte déjà créé.
2. Dans **Mon compte → Connexion SSO**, associe Keycloak après une première connexion classique. Une adresse e-mail identique ne crée ni n'associe automatiquement un compte.
3. Invite les techniciens dans **Équipe**, puis attribue `admin` à ceux qui doivent administrer l'organisation. Les rôles Keycloak ne donnent pas automatiquement des droits Atelier.
4. Dans les intégrations de l'organisation, ajoute la vraie **clé API Anthropic**. Un abonnement Max n'est pas une clé API ; utilise les crédits réellement disponibles dans Anthropic Console.
5. Dans **Agents et plafond global**, règle le plafond mensuel à **200 USD**, choisis les modèles par défaut pour les agents et sous-agents ; garde la discussion configurée séparément.
6. Pour chaque projet, règle le plafond quotidien, `Europe/Paris`, le budget par tour et les éventuelles dérogations de modèles. La rallonge quotidienne de 1 $ reste soumise au plafond mensuel.
7. Configure Discord et/ou Telegram dans **Décisions du technicien**, avec les IDs autorisés. Active le Web Push depuis le navigateur si souhaité.

Pour que les agents travaillent sur un dépôt GitLab externe, configure un **token de projet/bot distinct**, limité à ce dépôt, capable de lire/pousser les branches et de créer les MR via l'API (`write_repository` et `api`, selon le type de token et les règles du dépôt). Le deploy token `read_registry` de Portainer ne peut pas faire cela. Protège la branche principale ; les agents proposent leurs changements selon le workflow du projet.

Termine par une petite tâche sur un projet de test, une prévisualisation et une publication. Vérifie l'accès privé à la prévisualisation, l'adresse publiée, la décision d'un technicien puis sa reprise, et la connexion Keycloak depuis une session déconnectée. Les tâches et cron tournent sur le serveur ; la page peut être fermée.

## 8. Mettre à jour depuis GitLab CI/CD

### Publication automatique, déploiement manuel sans webhook

La CI publie les images automatiquement après ses tests. Pour livrer manuellement, laisse les variables de webhook absentes. Après la réussite des deux builds, renseigne dans Portainer les deux images `commit-<SHA complet>` du même commit, ou un tag de version publié. Sauvegarde d'abord les données, puis **Update the stack** et vérifie les deux images, `healthy`, une connexion et une petite tâche.

### Déploiement automatique comme MyRole 3

Le pipeline importe `.default-deploy` de `myrole/ci-templates` pour l'environnement, la sérialisation des livraisons et les retries d'infrastructure. Atelier conserve son script Node pour transmettre les deux références d'images exactes et masquer les erreurs contenant l'URL secrète. Aucun retry applicatif automatique du POST n'est ajouté.

Dans GitLab **Settings → CI/CD → Variables**, configure :

| Variable | Usage |
|---|---|
| `PORTAINER_WEBHOOK_URL` | URL HTTPS du webhook de la stack de production, directe ou via le proxy MyRole |
| `PORTAINER_WEBHOOK_SECRET` | Secret du proxy, envoyé via le header `x-webhook-secret` |
| `PORTAINER_STAGING_WEBHOOK_URL` | URL du webhook de la stack staging |
| `PORTAINER_STAGING_WEBHOOK_SECRET` | Secret du proxy pour staging |

Ces variables doivent être **Masked**, **Protected**, avec expansion des références désactivée. Utilise le scope `*` pour les URL, car les règles de création des jobs testent leur présence. Chaque URL doit finir par `/api/stacks/webhooks/<identifiant>`, sans query string ; le script ajoute lui-même `ATELIER_IMAGE` et `ATELIER_SANDBOX_IMAGE`.

Avec un webhook direct Portainer, le header secret peut rester absent. Les webhooks de stack **Web editor** sont réservés à Business Edition. Le proxy MyRole protège l'accès au webhook mais ne remplace pas les capacités/licences de Portainer. Avec CE sans intégration dédiée, utilise la mise à jour manuelle. [Documentation Portainer](https://docs.portainer.io/user/docker/stacks/webhooks).

| Référence protégée | Job automatique si URL renseignée | Images livrées |
|---|---|---|
| Branche par défaut, normalement `main` | `deploy` → production | Les deux tags `commit-<SHA>` |
| `staging` | `deploy-staging` → staging | Les deux tags `commit-<SHA>` |
| Tag `vX.Y.Z` | `deploy` → production | Les deux tags `commit-<SHA>` ; alias de version aussi publié |

Dès que les URL sont configurées, une livraison sur ces références déclenche le déploiement après les tests et les **deux builds**. Il n'y a plus de clic ni de variable `ATELIER_AUTO_DEPLOY`. L'ancienne variable `PORTAINER_STACK_WEBHOOK` est remplacée dans la CI par `PORTAINER_WEBHOOK_URL` ; l'ancien nom reste accepté par le script pour un appel direct hors pipeline.

Le runner Node doit joindre le proxy/webhook via le réseau d'administration/VPN, avec un certificat TLS fiable. N'expose pas l'administration Portainer à Internet pour résoudre la connectivité. Ne place jamais les secrets dans une URL ou dans le dépôt ; configure aussi les journaux du reverse proxy pour ne pas conserver les chemins de webhook secrets.

Crée une **stack staging distincte** avec le même Compose, mais ses propres valeurs : `ATELIER_CONTAINER=atelier-staging-orchestrator`, `ATELIER_SANDBOX_NET=atelier-staging-sandbox`, `ATELIER_WORKDIR=/srv/atelier-staging/work`, `ATELIER_PORT=127.0.0.1:8083`, `ATELIER_APPS_PORT=8084`, un domaine Atelier et un domaine applicatif staging distincts. Crée son dossier sur l'hôte, son callback Keycloak et ses certificats. Conserve un volume de données propre à cette stack et sa propre clé maître ; adapte le pool réseau si nécessaire. Ne partage ni les données ni les secrets de production avec staging.

Le job transmet les références d'images épinglées au commit dans les paramètres du webhook ; le proxy MyRole les transmet à Portainer. Le Compose et les personnalisations réseau restent dans Portainer. Vérifie lors de la première livraison que ta version de Portainer applique ces paramètres et les conserve pour les mises à jour suivantes.

La sauvegarde MQTT, la promotion `develop → main` et la revue IA spécifiques à MyRole 3 ne sont pas activées dans Atelier. La CI ne réalise ni sauvegarde automatique ni rollback automatique : prévoir une sauvegarde cohérente et terminer les agents actifs **avant de pousser** sur une référence déclenchant un déploiement. Un job vert signifie demande acceptée ; vérifier ensuite la version effective et la santé réelle.

## 9. Sauvegarder et revenir en arrière

Le volume nommé `data` monté dans `/data` contient la base Atelier. `/srv/atelier/work` contient aussi les dépôts gérés (`_repos`), les versions (`_releases`), les données applicatives (`_appdata`) et les espaces de travail en attente d'une réponse humaine. **Ce dossier n'est pas seulement temporaire.**

Avant une mise à jour :

1. Termine les tâches actives et suspends les agents planifiés concernés.
2. Arrête l'orchestrateur **et les applications créées** durant une courte fenêtre, pour une copie cohérente de toutes les bases SQLite ; arrêter seulement Atelier ne stoppe pas nécessairement les applications. Dans Portainer, identifie les conteneurs applicatifs via leurs labels Atelier.
3. Sauvegarde le volume `/data` avec son nom réel visible dans Portainer (souvent `atelier_data`) et tout `/srv/atelier/work`, avec propriétaires et permissions préservés. Chiffre ces sauvegardes et conserve une copie hors de ce serveur.
4. Sauvegarde séparément la clé maître, les variables de stack, les personnalisations du Compose et la configuration Portainer. Les secrets d'exécution peuvent aussi se retrouver dans ces sauvegardes : limite leur accès.
5. Redémarre les services, vérifie-les et réactive les planifications. Exerce une restauration sur une machine isolée.

Pour un retour arrière applicatif, remets **les deux** tags précédents dans Portainer et redéploie. Les migrations de base se font au démarrage : un ancien binaire n'est pas garanti compatible avec une base déjà migrée. Si nécessaire, restaure ensemble le snapshot des données et la version correspondante, en tenant compte des modifications produites depuis. Ne supprime pas les volumes et n'utilise pas `down -v` en production.

## Dépannage rapide

| Symptôme | À vérifier |
|---|---|
| Job Node en attente | Runner Docker accepte les jobs sans tag et l'image Node 24 |
| `integration` en attente | Runner Shell en ligne avec tag `atelier-docker`, branche/tag protégé |
| `integration` absent d'une MR | Normal sur une branche non protégée : seuls les contrôles Node tournent ; intégration complète après merge sur branche protégée |
| `unauthorized` au pull | Deploy token `read_registry`, expiration, registre sélectionné et accessible à l'environnement |
| `x509: certificate signed by unknown authority` | CA installée dans le composant qui fait la requête, nom du certificat et chaîne complète |
| Sandbox sans image / `exec format error` | Les deux images sont disponibles sur l'hôte, même version et bonne architecture |
| `502` derrière le proxy | Réseau externe partagé, DNS du conteneur, ports 8080/8082 ; pas `localhost` depuis un proxy conteneurisé |
| Connexion classique en boucle | URL HTTPS, `TRUST_PROXY=1`, `COOKIE_SECURE=1`, schéma transmis par le proxy |
| Keycloak absent ou callback refusé | Trois variables OIDC, issuer exact, client secret, redirect URI exacte, e-mail vérifié et association locale préalable |
| Publication d'une app inaccessible | DNS wildcard, certificat DNS, Host conservé, passerelle 8082 et domaine configuré |
| Webhook accepté mais ancienne version | Contrôler la mise à jour effective des deux variables dans Portainer et la fin du pull/déploiement |

Les contrôles locaux valident le code et le déclencheur avec des réponses simulées ; ils ne remplacent pas une première livraison sur tes instances GitLab/Portainer. Les règles de sécurité et les limites d'isolation sont décrites dans [security.md](security.md).
