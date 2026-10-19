// Integration checks for the disposable smoke stack only (localhost:18080/18082).
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile),
  base = "http://localhost:18080";
const login = await fetch(base + "/api/auth/login", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "admin@localhost", password: "smoke" }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await res.json();
  assert.ok(res.ok, JSON.stringify(value));
  return value;
};
const me = await api("GET", "/api/me"),
  org = me.orgs[0].id,
  root = `/api/orgs/${org}`;
const created = await api("POST", root + "/projects/scaffold", {
    name: "Services validation",
    slug: "services-" + Date.now(),
    template: "node",
  }),
  project = created.project.id;
const release = async () => {
  const r = await api("POST", `${root}/projects/${project}/releases`, {});
  for (let i = 0; i < 120; i++) {
    const state = await api("GET", `${root}/releases/${r.id}`);
    if (state.state === "ready") return state;
    if (state.state === "failed") throw Error(state.error);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error("Build timeout");
};
const first = await release();
await api("POST", `${root}/releases/${first.id}/publish`, { reviewed: true });
const host = `p-${project}.apps.localhost`;
const app = (method, path, body, session) =>
  new Promise((resolve, reject) => {
    const q = http.request(
      {
        hostname: "127.0.0.1",
        port: 18082,
        path,
        method,
        headers: {
          host,
          "content-type": "application/json",
          ...(session ? { cookie: session } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers,
            }),
          ),
        );
      },
    );
    q.on("error", reject);
    if (body !== undefined) q.write(JSON.stringify(body));
    q.end();
  });
const registration = await app("POST", "/api/auth/register", {
  email: "a@example.test",
  password: "a-password-for-test",
});
assert.equal(registration.status, 200);
const session = registration.headers.get("set-cookie").split(";")[0];
assert.equal(
  (await app("POST", "/api/items", { text: "persistent item" }, session))
    .status,
  201,
);
assert.equal((await app("GET", "/api/items")).status, 401);
const second = await release();
await api("POST", `${root}/releases/${second.id}/publish`, { reviewed: true });
const data = await (await app("GET", "/api/items", undefined, session)).json();
assert.equal(data[0].text, "persistent item");
const csp = (await app("GET", "/")).headers.get("content-security-policy");
assert.ok(csp.includes("connect-src 'self'"));
const check = `const assert=require('node:assert/strict'); const fs=require('node:fs'); assert.equal(process.getuid(),1000);assert.ok(!fs.existsSync('/var/run/docker.sock')); for(const key of ['ATELIER_MASTER_KEY','ANTHROPIC_API_KEY','GIT_TOKEN'])assert.ok(!process.env[key]); (async()=>{ for(const target of ['http://169.254.169.254/latest/meta-data/','http://1.1.1.1/','http://atelier-app-${first.id}:3000/']){let blocked=false;try{await fetch(target,{signal:AbortSignal.timeout(1500)});}catch{blocked=true;}assert.ok(blocked,target);}console.log('EGRESS AND ISOLATION OK');})().catch(e=>{console.error(e);process.exit(1);});`;
const checked = await run(
  "docker",
  ["exec", `atelier-app-${second.id}-prod`, "node", "-e", check],
  { timeout: 15000 },
);
assert.match(checked.stdout, /ISOLATION OK/);
console.log("NODE SERVICES, PERSISTENCE AND NETWORK ISOLATION OK");
