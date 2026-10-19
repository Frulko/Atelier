import test from "node:test";
import assert from "node:assert/strict";
import { deploy } from "./deploy-portainer.mjs";

const env = {
  PORTAINER_STACK_WEBHOOK: "https://portainer.example.com/api/stacks/webhooks/test-secret",
  CI_REGISTRY_IMAGE: "registry.example.com/team/atelier",
  ATELIER_RELEASE: "1.0.0",
};

test("Portainer : même version des deux images, POST HTTPS sans redirection", async () => {
  const message = await deploy(env, async (url, options) => {
    assert.equal(url.searchParams.get("ATELIER_IMAGE"), "registry.example.com/team/atelier/atelier:1.0.0");
    assert.equal(url.searchParams.get("ATELIER_SANDBOX_IMAGE"), "registry.example.com/team/atelier/atelier-sandbox:1.0.0");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true };
  });
  assert.match(message, /demandé/);
});

test("Portainer : configuration dangereuse refusée avant tout appel", async () => {
  for (const patch of [
    { PORTAINER_STACK_WEBHOOK: env.PORTAINER_STACK_WEBHOOK.replace("https:", "http:") },
    { PORTAINER_STACK_WEBHOOK: env.PORTAINER_STACK_WEBHOOK + "?tag=latest" },
    { PORTAINER_STACK_WEBHOOK: "https://user:password@portainer.example.com/api/stacks/webhooks/secret" },
    { PORTAINER_STACK_WEBHOOK: "https://portainer.example.com/api/stacks/1" },
    { ATELIER_RELEASE: "latest" }, { CI_REGISTRY_IMAGE: "registry.example.com/path?query" },
  ]) {
    await assert.rejects(deploy({ ...env, ...patch }, () => assert.fail("appel réseau interdit")));
  }
});

test("Portainer : un refus ou une erreur réseau ne divulgue pas le webhook", async () => {
  await assert.rejects(deploy(env, async () => { throw Error(env.PORTAINER_STACK_WEBHOOK); }),
    (error) => !error.message.includes("test-secret") && /injoignable/.test(error.message));
  await assert.rejects(deploy(env, async () => ({ ok: false, status: 403 })), /HTTP 403/);
});

test("MyRole : webhook de staging, secret en header et images épinglées au commit", async () => {
  const sha = "a".repeat(40);
  await deploy({
    ...env,
    DEPLOY_WEBHOOK_URL: "https://proxy.example.com/api/stacks/webhooks/staging-id",
    DEPLOY_WEBHOOK_SECRET: "test-header-secret",
    ATELIER_RELEASE: `commit-${sha}`,
  }, async (url, options) => {
    assert.equal(url.hostname, "proxy.example.com");
    assert.equal(url.pathname, "/api/stacks/webhooks/staging-id");
    assert.equal(url.searchParams.get("ATELIER_IMAGE"), `${env.CI_REGISTRY_IMAGE}/atelier:commit-${sha}`);
    assert.equal(url.searchParams.get("ATELIER_SANDBOX_IMAGE"), `${env.CI_REGISTRY_IMAGE}/atelier-sandbox:commit-${sha}`);
    assert.equal(options.headers["x-webhook-secret"], "test-header-secret");
    assert.equal(url.searchParams.has("secret"), false);
    return { ok: true };
  });
});

test("MyRole : une erreur ne divulgue ni le header secret ni l'URL", async () => {
  await assert.rejects(deploy({ ...env, DEPLOY_WEBHOOK_SECRET: "test-header-secret" }, async () => {
    throw Error(`test-header-secret ${env.PORTAINER_STACK_WEBHOOK}`);
  }), (error) => !error.message.includes("test-header-secret") && !error.message.includes("test-secret"));
});
