// L'assistant avec un VRAI client de fournisseur (SDK Anthropic) face à un faux fournisseur local : on vérifie la requête réellement
// envoyée (clé de L'ORGANISATION, modèle choisi, système avec connaissances, historique, pièce jointe image) et la gestion des pannes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "x";
delete process.env.ATELIER_FAKE_AGENT;
type Seen = { key: string | undefined; body: any };
const seen: Seen[] = [];
let mode: "ok" | "401" | "429" = "ok";
const provider = http.createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    seen.push({ key: req.headers["x-api-key"] as string | undefined, body: JSON.parse(raw || "{}") });
    if (mode !== "ok") return void res.writeHead(mode === "401" ? 401 : 429, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: mode === "401" ? "authentication_error" : "rate_limit_error", message: "SECRET-DETAIL-DU-FOURNISSEUR sk-ant-xyz" } }));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const ev = (e: string, d: unknown) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 21, output_tokens: 1 } } });
    ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const w of ["Bonjour ", "depuis ", "le fournisseur."]) ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: w } });
    ev("content_block_stop", { type: "content_block_stop", index: 0 });
    ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } });
    ev("message_stop", { type: "message_stop" });
    res.end();
  });
}).listen(0);
process.env.ATELIER_UPSTREAM_ANTHROPIC = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

const db = await import("./db.ts");
const V = await import("./vault.ts");
const { hashPassword } = await import("./auth.ts");
const { createApp } = await import("./app.ts");

const hash = await hashPassword("motdepasse1");
const alice = db.createUser("alice@a.fr", hash), bob = db.createUser("bob@b.fr", hash);
const orgA = db.createOrg("A", alice.id), orgB = db.createOrg("B", bob.id);
V.storeSecret(orgA, "provider_key", "anthropic", "clé A", "sk-ant-CLE-DE-A-0000");
V.storeSecret(orgB, "provider_key", "anthropic", "clé B", "sk-ant-CLE-DE-B-0000");
db.insertKnowledge({ org_id: orgA, project_id: null, title: "Charte du site", content: "Toujours tutoyer.", enabled: true, pinned: false, created_by: alice.id });

const server = createApp().listen(0);
after(() => { server.closeAllConnections(); server.close(); provider.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function login(e: string) { const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: "motdepasse1" }) }); return r.headers.get("set-cookie")!.split(";")[0]; }
const call = (c: string, m: string, p: string, b?: unknown) => fetch(base + p, { method: m, headers: { "content-type": "application/json", cookie: c }, body: b ? JSON.stringify(b) : undefined });
const cA = await login("alice@a.fr"), cB = await login("bob@b.fr");
const chat = async (c: string, org: string, parts: unknown[]) => {
  const conv = ((await (await call(c, "POST", `/api/orgs/${org}/conversations`, { mode: "chat" })).json()) as { conversation: { id: string } }).conversation.id;
  return { conv, res: await call(c, "POST", `/api/orgs/${org}/conversations/${conv}/chat`, { id: conv, trigger: "submit-message", messages: [{ id: "u", role: "user", parts }] }) };
};
const text = async (r: Response) => (await r.text()).split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6))).filter((e) => e.type === "text-delta").map((e) => e.delta).join("");

test("chaque organisation parle au fournisseur AVEC SA CLÉ, le modèle réglé, le système et ses connaissances", async () => {
  await call(cA, "PATCH", `/api/orgs/${orgA}`, { chatModel: "claude-test-7" });
  const a = await chat(cA, orgA, [{ type: "text", text: "Quel ton ?" }]);
  assert.equal(a.res.status, 200);
  assert.equal(await text(a.res), "Bonjour depuis le fournisseur.");
  const sa = seen.at(-1)!;
  assert.equal(sa.key, "sk-ant-CLE-DE-A-0000");
  assert.equal(sa.body.model, "claude-test-7");
  assert.equal(sa.body.stream, true);
  assert.match(JSON.stringify(sa.body.system), /Charte du site/);                    // les connaissances sont dans le système
  assert.match(JSON.stringify(sa.body.system), /Toujours tutoyer/);
  assert.equal(sa.body.messages.at(-1).role, "user");
  const b = await chat(cB, orgB, [{ type: "text", text: "Bonjour" }]);
  await text(b.res);
  const sb = seen.at(-1)!;
  assert.equal(sb.key, "sk-ant-CLE-DE-B-0000");                                       // jamais la clé d'une autre organisation
  assert.doesNotMatch(JSON.stringify(sb.body), /Charte du site/);                    // ni ses connaissances
  const stored = db.getMessages(a.conv);
  assert.equal(stored.length, 2);
  const usage = JSON.parse(stored[1]!.meta!).usage;
  assert.ok(usage.inputTokens === 21 && usage.outputTokens === 7, JSON.stringify(usage)); // les tokens du fournisseur sont comptés
});

test("l'historique est renvoyé au fournisseur au tour suivant, et une image jointe part comme image", async () => {
  const a = await chat(cA, orgA, [{ type: "text", text: "Premier message" }]);
  await text(a.res);
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20)]);
  const r2 = await call(cA, "POST", `/api/orgs/${orgA}/conversations/${a.conv}/chat`, { id: a.conv, trigger: "submit-message", messages: [{ id: "u2", role: "user", parts: [{ type: "text", text: "Regarde" }, { type: "file", filename: "logo.png", mediaType: "image/png", url: `data:image/png;base64,${PNG.toString("base64")}` }] }] });
  assert.equal(r2.status, 200); await text(r2);
  const body = seen.at(-1)!.body;
  assert.deepEqual(body.messages.map((m: any) => m.role), ["user", "assistant", "user"]);
  assert.match(JSON.stringify(body.messages[1]), /Bonjour depuis le fournisseur/);
  const last = body.messages[2].content;
  assert.ok(last.some((c: any) => c.type === "image" && c.source.media_type === "image/png"), JSON.stringify(last).slice(0, 200));
});

test("pannes du fournisseur : message clair en français, jamais le détail brut ni une clé ; rien d'incomplet enregistré", async () => {
  for (const [m, expected] of [["401", /refusé la clé/], ["429", /saturé/]] as const) {
    mode = m;
    const a = await chat(cA, orgA, [{ type: "text", text: "Bonjour" }]);
    const out = await a.res.text();
    assert.match(out, expected, m);
    assert.doesNotMatch(out, /SECRET-DETAIL|sk-ant-xyz|CLE-DE-A/, m);
    assert.equal(db.getMessages(a.conv).filter((x) => x.role === "assistant").length, 0, m);
  }
  mode = "ok";
});

test("sans clé pour le fournisseur choisi : 409 clair avant tout flux, aucun appel au fournisseur", async () => {
  await call(cA, "PATCH", `/api/orgs/${orgA}`, { chatProvider: "openai" });                         // aucune clé OpenAI pour A
  const before = seen.length;
  const a = await chat(cA, orgA, [{ type: "text", text: "Bonjour" }]);
  assert.equal(a.res.status, 409);
  assert.match(((await a.res.json()) as { error: string }).error, /Aucune clé « openai »/);
  assert.equal(seen.length, before);
  await call(cA, "PATCH", `/api/orgs/${orgA}`, { chatProvider: null });
});
