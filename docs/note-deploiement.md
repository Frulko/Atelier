# Note de déploiement — Atelier

**Date :** 19 octobre 2026 · **Cible :** GitLab auto-hébergé → registre privé → Docker Standalone / Portainer.

Cette note sert de fiche d'exécution pour une première installation ou une mise à jour. Les versions et domaines ci-dessous sont des exemples. Aucun déploiement sur l'infrastructure cible n'est attesté par cette note. Pour l'installation détaillée, suivre le [tutoriel GitLab / Portainer](gitlab-portainer.md).

## Informations de livraison à renseigner

| Information | Valeur |
|---|---|
| Version à déployer | À renseigner, par exemple `1.0.0` |
| Tag Git / commit | À renseigner, par exemple `v1.0.0` / SHA |
| Version précédente | À renseigner, ou première installation |
| Projet / registre GitLab | À renseigner |
| URL Atelier / Portainer | À renseigner |
| Responsable / fenêtre d'intervention | À renseigner |
| Référence de sauvegarde | À renseigner avant une mise à jour |

## Prérequis

- [ ] Production dédiée, Docker Engine + Compose et Portainer ; un seul orchestrateur, sans Swarm.
- [ ] GitLab privé, Container Registry actif, branche par défaut et tags `v*` protégés.
- [ ] Runner Docker pour les contrôles Node ; runner Shell **protégé**, tag `atelier-docker`, distinct de la production, avec Node 24, Docker/Compose/Buildx et Playwright.
- [ ] Architecture des images adaptée au serveur ; le pipeline utilise `linux/amd64` par défaut.
- [ ] Portainer autorisé à tirer les images avec un deploy token GitLab limité à `read_registry`.
- [ ] DNS et HTTPS pour Atelier ; DNS wildcard et certificat pour les applications sur un domaine distinct.
- [ ] Clé maître conservée dans un gestionnaire de secrets ; sauvegardes accessibles et procédure de restauration identifiée.

## Configuration Portainer

Créer la stack **`atelier`**, méthode **Web editor**, avec [`docker-compose.prod.yml`](../docker-compose.prod.yml). Conserver le même nom lors des mises à jour. Préparer `/srv/atelier/work` sur l'hôte Docker ciblé : le chemin doit être identique dans le conteneur.

Saisir les variables dans Portainer, jamais dans le dépôt. Remplacer les valeurs d'exemple et les marqueurs `REMPLACER_…` :

```dotenv
ATELIER_IMAGE=registry.example.com/equipe/atelier/atelier:1.0.0
ATELIER_SANDBOX_IMAGE=registry.example.com/equipe/atelier/atelier-sandbox:1.0.0
ATELIER_BOOTSTRAP_EMAIL=admin@example.com
ATELIER_PASSWORD=REMPLACER_PAR_UN_MOT_DE_PASSE_LONG_UNIQUE
ATELIER_MASTER_KEY=REMPLACER_PAR_UNE_CLE_BASE64_DE_32_OCTETS
ATELIER_WORKDIR=/srv/atelier/work
ATELIER_PUBLIC_URL=https://atelier.example.com
ATELIER_PORT=127.0.0.1:8080
TRUST_PROXY=1
COOKIE_SECURE=1
ATELIER_APPS_DOMAIN=apps.example.net
ATELIER_APPS_SCHEME=https
ATELIER_APPS_BIND=127.0.0.1
ATELIER_APPS_PORT=8082
ATELIER_PUSH_SUBJECT=mailto:admin@example.com
ATELIER_GIT_HOSTS=gitlab.example.com
MAX_BUDGET_USD=2
```

Pour une première installation, générer la clé avec `openssl rand -base64 32`. **Réutiliser la clé existante pour une mise à jour.** Si GitLab résout vers une IP privée, ajouter `ATELIER_GIT_ALLOW_PRIVATE=1` en conservant son nom dans la liste autorisée. Vérifier les collisions avec le pool applicatif `10.240.0.0/16` et changer `ATELIER_APPS_SUBNET_POOL` si nécessaire.

Le reverse proxy dirige Atelier vers le port **8080** et `*.apps.example.net` vers **8082**, en conservant Host et le schéma HTTPS. Depuis un proxy conteneurisé, utiliser un réseau externe partagé et `atelier-orchestrator`, pas `127.0.0.1` ; voir le [montage réseau détaillé](gitlab-portainer.md#6-activer-https-pour-atelier-et-les-applications). Garder les ports 8080/8081/8082 hors de l'accès public.

Pour Keycloak, ajouter :

```dotenv
ATELIER_OIDC_ISSUER=https://sso.example.com/realms/atelier
ATELIER_OIDC_CLIENT_ID=atelier
ATELIER_OIDC_CLIENT_SECRET=REMPLACER_PAR_LE_SECRET_DU_CLIENT
```

Client confidentiel, Standard flow, PKCE S256, signature RS256 ; callback exact : `https://atelier.example.com/api/auth/sso/callback`. La connexion classique reste disponible. Chaque technicien associe explicitement Keycloak depuis son compte Atelier ; ses droits restent gérés dans Atelier.

## Exécution de la livraison

1. **Préparer.** Relire et commiter les changements, puis pousser la branche par défaut. Pour une mise à jour, suspendre les planifications concernées et attendre la fin des tâches actives.
2. **Publier.** Créer un nouveau tag protégé, par exemple `git tag v1.0.0`, puis `git push gitlab v1.0.0` si le remote s'appelle `gitlab`. Attendre la réussite de `checks`, `integration` et `images` dans le [pipeline](../.gitlab-ci.yml).
3. **Sauvegarder avant remplacement.** Pour une installation existante, arrêter les écrivains le temps d'une sauvegarde cohérente : orchestrateur **et applications créées** pour leurs bases. Sauvegarder le volume `/data`, tout `/srv/atelier/work`, le Compose et les variables Portainer ; conserver la clé maître séparément. Identifier les services arrêtés pour les remettre en marche après l'intervention.
4. **Déployer.** Dans Portainer, renseigner **la même version pour les deux images**, puis lancer **Deploy / Update the stack** avec récupération des images. Conserver volumes, chemins et personnalisations réseau.
5. **Contrôler.** Exécuter la recette ci-dessous. Ne réactiver les planifications qu'après validation et remise en marche des applications arrêtées.
6. **Tracer.** Renseigner version, commit, sauvegarde, intervenant, résultat et éventuelles anomalies dans la fiche de livraison.

Avec **CE**, ce parcours utilise la mise à jour manuelle de la stack. Le chemin prévu pour **BE** peut déclencher le déploiement depuis GitLab avec `PORTAINER_STACK_WEBHOOK` masquée/protégée ; `ATELIER_AUTO_DEPLOY=1` automatise les tags protégés. Préparer la sauvegarde et la fenêtre avant de pousser le tag si cette option est active. La CI ne réalise ni sauvegarde ni retour arrière automatique. Un webhook accepté ne prouve pas que la nouvelle version est opérationnelle. Voir les [conditions du déclenchement CI](gitlab-portainer.md#8-mettre-à-jour-depuis-gitlab-cicd).

## Recette après déploiement

- [ ] L'orchestrateur est **healthy** ; `sandbox-image` s'est arrêté avec **exit code 0**, comportement attendu.
- [ ] Les deux images correspondent à la version livrée ; `curl --fail https://atelier.example.com/healthz` retourne `ok`.
- [ ] Connexion classique réussie ; mot de passe initial changé lors de la première installation.
- [ ] Connexion Keycloak et rôles vérifiés avec un compte associé, si le SSO est activé.
- [ ] Clé API réelle configurée dans l'organisation ; plafond mensuel **200 USD**, limites quotidiennes par projet et modèles agents/sous-agents réglés dans l'interface. `MAX_BUDGET_USD` ne règle pas le plafond mensuel.
- [ ] Petite tâche de test terminée ; prévisualisation privée contrôlée puis publication accessible sur le domaine applicatif.
- [ ] Décision d'un technicien et reprise vérifiées si Discord/Telegram sont activés ; Web Push vérifié si utilisé.
- [ ] Applications arrêtées remises en marche, planifications réactivées, journaux vérifiés sans copier de secrets dans le compte rendu.

## Retour arrière et limites

En cas d'échec, suspendre les nouvelles exécutions, conserver les éléments de diagnostic utiles et remettre **les deux images à la version précédente** dans Portainer. Redéployer et refaire la recette. Pour une première installation, arrêter la stack en conservant ses données pour diagnostic.

Les migrations de base sont exécutées au démarrage : le retour aux anciennes images ne restaure pas les données et leur compatibilité n'est pas garantie. Si nécessaire, restaurer ensemble une sauvegarde cohérente et la version correspondante, en évaluant la perte des écritures postérieures. Ne jamais utiliser `down -v` en production.

Le remplacement de l'unique orchestrateur peut interrompre une tâche ; aucune continuité sans coupure n'est garantie. L'accès au socket Docker donne des pouvoirs équivalents à root : limiter les accès administrateur et utiliser un hôte dédié. Voir les [limites de sécurité](security.md).

**Validation cible : à effectuer sur les instances GitLab, Portainer, Keycloak et les services externes réels.**
