FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Client docker seul (le démon est celui de l'hôte, via le socket monté).
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8080
# Node 24 exécute le TypeScript directement : pas d'étape de build.
CMD ["node", "src/index.ts"]
