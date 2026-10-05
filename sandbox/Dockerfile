# Bac à sable de l'agent : un conteneur jetable par tâche, sans secret,
# sans accès Internet (réseau interne) — il ne parle qu'au proxy de l'orchestrateur.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/runner
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY runner.mjs ./
# uid 1000 : l'utilisateur "node" ; claude refuse de tourner en root avec bypassPermissions.
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/runner/runner.mjs"]
