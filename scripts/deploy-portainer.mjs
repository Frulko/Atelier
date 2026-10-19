import { pathToFileURL } from "node:url";

export async function deploy(env = process.env, send = fetch) {
  const url = new URL(env.DEPLOY_WEBHOOK_URL || env.PORTAINER_STACK_WEBHOOK);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !/^\/api\/stacks\/webhooks\/[a-zA-Z0-9-]+$/.test(url.pathname)) {
    throw Error("Webhook HTTPS de stack Portainer attendu, sans paramètres.");
  }
  if (!/^(?:(?:commit-)?[0-9a-f]{40}|[0-9]+\.[0-9]+\.[0-9]+)$/.test(env.ATELIER_RELEASE ?? "") ||
      !/^[a-z0-9][a-z0-9.:/-]*$/.test(env.CI_REGISTRY_IMAGE ?? "")) {
    throw Error("Registre ou version de publication invalide.");
  }
  url.searchParams.set("ATELIER_IMAGE", `${env.CI_REGISTRY_IMAGE}/atelier:${env.ATELIER_RELEASE}`);
  url.searchParams.set("ATELIER_SANDBOX_IMAGE", `${env.CI_REGISTRY_IMAGE}/atelier-sandbox:${env.ATELIER_RELEASE}`);
  const headers = {};
  if (env.DEPLOY_WEBHOOK_SECRET) headers["x-webhook-secret"] = env.DEPLOY_WEBHOOK_SECRET;
  let response;
  try {
    response = await send(url, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    // Le chemin du webhook est un secret : ne jamais afficher l'URL ou l'erreur réseau.
    throw Error("Portainer injoignable : vérifier DNS, accès réseau et certificat TLS.");
  }
  if (!response.ok) throw Error(`Portainer a refusé la demande (HTTP ${response.status}).`);
  return "Déploiement demandé à Portainer. Vérifier ensuite l'état healthy et la version des deux images dans Portainer.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await deploy()); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
