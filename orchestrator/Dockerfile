# Image de l'orchestrateur. Le contexte de construction est la RACINE du dépôt (voir docker-compose.yml) :
# l'étape « web » compile l'application React, l'étape finale n'en garde que les fichiers statiques.
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM node:24-slim
ARG ATELIER_VERSION=dev
ARG ATELIER_SOURCE=""
LABEL org.opencontainers.image.title="Atelier orchestrator" \
      org.opencontainers.image.description="Let non-developers evolve their software by talking to an AI agent in a disposable sandbox" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${ATELIER_VERSION}" \
      org.opencontainers.image.source="${ATELIER_SOURCE}"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Client docker seul (le démon est celui de l'hôte, via le socket monté).
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
# Seule dépendance d'exécution : le SDK d'IA de Vercel (et ses fournisseurs), pour la fenêtre de conversation.
COPY orchestrator/package.json orchestrator/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY orchestrator/src ./src
COPY --from=web /web/dist ./public
ENV NODE_ENV=production PUBLIC_DIR=/app/public
EXPOSE 8080
# Portainer et Docker savent ainsi si le service répond (et le redémarrent sinon).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node 24 exécute le TypeScript directement : pas d'étape de build pour le serveur.
CMD ["node", "src/index.ts"]
