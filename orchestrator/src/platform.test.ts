import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
process.env.DB_FILE = ":memory:";
process.env.ATELIER_PASSWORD = "test";
process.env.ATELIER_FAKE_AGENT = "1";
const dir = mkdtempSync(join(tmpdir(), "atelier-platform-"));
process.env.ATELIER_WORKDIR = dir;
const d = await import("./db.ts");
const { createApp } = await import("./app.ts");
const { hashPassword } = await import("./auth.ts");
const { startSession } = await import("./session.ts");
const { nextRun, automationFields, saveAutomation, runAutomation } =
  await import("./automations.ts");
const {
  notify,
  notifyTask,
  listNotifications,
  validSubscription,
  deliverNotifications,
  subscribe,
} = await import("./notifications.ts");
const { validateRuntime, setEnvironment, queueRelease } =
  await import("./releases.ts");
const { taskContext } = await import("./task-context.ts");
const hash = await hashPassword("motdepasse123"),
  alice = d.createUser("alice@a.test", hash),
  bob = d.createUser("bob@b.test", hash),
  member = d.createUser("member@a.test", hash),
  viewer = d.createUser("viewer@a.test", hash);
const org = d.createOrg("A", alice.id),
  other = d.createOrg("B", bob.id);
d.addMember(org, member.id, "member");
d.addMember(org, viewer.id, "viewer");
const project = d.insertProject({
  org_id: org,
  slug: "a",
  name: "A",
  repo: "/nonexistent/test.git",
  branch: "main",
  forge: "none",
  check_cmd: "true",
  engine: "claude",
  protected_paths: "[]",
  git_secret_id: null,
});
const foreign = d.insertProject({
  org_id: other,
  slug: "b",
  name: "B",
  repo: "/nonexistent/test.git",
  branch: "main",
  forge: "none",
  check_cmd: "true",
  engine: "claude",
  protected_paths: "[]",
  git_secret_id: null,
});
const cookies = new Map([
  [alice.id, startSession(alice.id)],
  [bob.id, startSession(bob.id)],
  [member.id, startSession(member.id)],
  [viewer.id, startSession(viewer.id)],
]);
const server = createApp().listen(0),
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// Read the cookie's established name rather than duplicating the session implementation.
const { cookieHeader } = await import("./session.ts");
const api = (u: string, method: string, path: string, value?: unknown) =>
  fetch(base + path, {
    method,
    headers: {
      cookie: cookieHeader(cookies.get(u)!, false).split(";")[0]!,
      "content-type": "application/json",
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});
const fields = {
  name: "Gardien",
  project_id: project,
  prompt: "Améliore le site",
  kind: "cron",
  cron: "0 9 * * 1-5",
  timezone: "Europe/Paris",
  max_runs_day: 2,
};

test("cron: timezone and DST, five fields, bounds and invalid schedules", () => {
  const a = automationFields(fields);
  assert.equal(
    nextRun(a, Date.parse("2026-10-23T08:00:00Z")),
    Date.parse("2026-10-26T08:00:00Z"),
  );
  for (const bad of [
    { cron: "* * * * * *" },
    { cron: "61 * * * *" },
    { timezone: "invalid" },
    { interval_minutes: 1 },
    { max_runs_day: 0 },
    { prompt: "" },
  ])
    assert.throws(() => automationFields({ ...fields, ...bad }));
});
test("automations API: scoped to organization, admin-only, validated and audited", async () => {
  const url = `/api/orgs/${org}/automations`;
  assert.equal((await api(bob.id, "GET", url)).status, 404);
  assert.equal((await api(member.id, "GET", url)).status, 403);
  assert.equal((await api(viewer.id, "POST", url, fields)).status, 403);
  assert.equal(
    (await api(alice.id, "POST", url, { ...fields, project_id: foreign }))
      .status,
    400,
  );
  const created = await api(alice.id, "POST", url, fields);
  assert.equal(created.status, 201);
  const a = (await created.json()) as { id: string };
  assert.equal(
    (await api(bob.id, "PATCH", `${url}/${a.id}`, { enabled: false })).status,
    404,
  );
  assert.equal(
    (await api(alice.id, "PATCH", `${url}/${a.id}`, { enabled: false })).status,
    200,
  );
  assert.equal((await api(alice.id, "DELETE", `${url}/${a.id}`)).status, 200);
  assert.ok(d.queryAudit(org, { action: "automation.create" }).items.length);
});
test("scheduler: no overlap, daily cap, revoked authority and failure pause", () => {
  const a = saveAutomation(org, alice.id, fields);
  d.createTask("aaa00001", org, alice.id, project, "manual");
  assert.equal(runAutomation(a), null);
  d.updateTask("aaa00001", { status: "cancelled" });
  d.db
    .prepare("insert into automation_runs values (?,?,?)")
    .run(a.id, "already1", Date.now());
  d.db
    .prepare("insert into automation_runs values (?,?,?)")
    .run(a.id, "already2", Date.now());
  assert.equal(runAutomation(a), null);
  const revoked = saveAutomation(org, member.id, {
    ...fields,
    name: "revoked",
  });
  assert.equal(runAutomation(revoked), null);
  assert.equal(
    (
      d.db
        .prepare("select enabled from automations where id=?")
        .get(revoked.id) as { enabled: number }
    ).enabled,
    0,
  );
  const failed = saveAutomation(org, alice.id, { ...fields, name: "failed" });
  d.createTask("aaa00002", org, alice.id, project, "failed");
  d.updateTask("aaa00002", { status: "failed", last_error: "failed" });
  assert.equal(runAutomation({ ...failed, last_task_id: "aaa00002" }), null);
});
test("notifications: private, deduplicated, no foreign organization and read marks owned", async () => {
  notify(alice.id, org, "Prêt", "A", `/o/${org}/tasks/aaaa0001`, "one");
  notify(alice.id, org, "Prêt", "A", "/", "one");
  notify(bob.id, org, "secret", "hidden", "/", "two");
  assert.equal(listNotifications(bob.id).length, 0);
  const rows = (await (
    await api(alice.id, "GET", "/api/me/notifications")
  ).json()) as { id: number; readAt: number | null }[];
  assert.equal(
    rows.filter((r) => r.id).length,
    listNotifications(alice.id).length,
  );
  await api(bob.id, "POST", "/api/me/notifications/read", { id: rows[0]!.id });
  assert.equal(
    (listNotifications(alice.id)[0] as { readAt: null }).readAt,
    null,
  );
  await api(alice.id, "POST", "/api/me/notifications/read", {
    id: rows[0]!.id,
  });
  assert.ok((listNotifications(alice.id)[0] as { readAt: number }).readAt);
});
test("push: arbitrary URLs refused, generic payload, expired subscription removed", async () => {
  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/example",
    keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) },
  };
  assert.ok(validSubscription(sub));
  assert.equal(
    validSubscription({ ...sub, endpoint: "https://127.0.0.1/private" }),
    false,
  );
  assert.equal(
    validSubscription({
      ...sub,
      endpoint: "https://fcm.googleapis.com.evil.test/send",
    }),
    false,
  );
  subscribe(alice.id, sub);
  assert.throws(() => subscribe(bob.id, sub));
  let sent = 0;
  await deliverNotifications(async (_subscription, payload) => {
    sent++;
    assert.ok(!String(payload).includes("secret"));
    throw Object.assign(new Error("gone"), { statusCode: 410 });
  });
  assert.ok(sent);
  assert.equal(
    (
      d.db.prepare("select count(*) as n from push_subscriptions").get() as {
        n: number;
      }
    ).n,
    0,
  );
});
test("queued tasks survive restart and interrupted followups preserve their proposal", () => {
  d.createTask("bbb00001", org, alice.id, project, "queued");
  d.createTask("bbb00002", org, alice.id, project, "running");
  d.updateTask("bbb00002", {
    status: "running",
    turn: 2,
    mr_url: "https://forge.test/1",
  });
  d.failOrphans();
  assert.equal(d.getTask("bbb00001")!.status, "queued");
  assert.equal(d.getTask("bbb00002")!.status, "done");
  assert.ok(d.getTask("bbb00002")!.last_error);
  assert.equal(d.getTask("bbb00002")!.mr_url, "https://forge.test/1");
});
test("cost ledger: new followup expense belongs to its actual month", () => {
  d.createTask("ccc00001", org, alice.id, project, "cost");
  d.updateTask("ccc00001", { cost: 1 });
  const before = Date.UTC(2026, 0, 15),
    now = Date.now();
  d.db.prepare("update tasks set created_at=? where id='ccc00001'").run(before);
  d.db.prepare("update expenses set ts=? where task_id='ccc00001'").run(before);
  const prior = d.monthSpend(org, now);
  d.updateTask("ccc00001", { cost: 3 });
  assert.equal(d.monthSpend(org, now) - prior, 2);
  assert.equal(d.monthSpend(org, before), 1);
});
test("task brief: preparation and followups come from persisted, scoped history", () => {
  const parent = d.insertConversation({
    org_id: org,
    user_id: alice.id,
    project_id: project,
    mode: "chat",
  });
  d.insertMessage(parent, "user", [
    { type: "text", text: "Les trois tarifs sont 10, 20 et 30." },
  ]);
  d.insertMessage(parent, "assistant", [
    { type: "text", text: "Un catalogue avec trois offres." },
  ]);
  d.createTask("ddd00001", org, alice.id, project, "Oui, réalise ceci");
  const c = d.insertConversation({
    org_id: org,
    user_id: alice.id,
    project_id: project,
    mode: "task",
    task_id: "ddd00001",
    parent_id: parent,
  });
  d.insertMessage(c, "user", [{ type: "text", text: "Ajoute un bouton bleu" }]);
  d.updateTask("ddd00001", { turn: 2, followup: "Plus grand" });
  const brief = taskContext(d.getTask("ddd00001")!);
  assert.match(brief, /10, 20 et 30/);
  assert.match(brief, /catalogue/);
  assert.match(brief, /bouton bleu/);
  assert.match(brief, /Plus grand/);
});
test("runtime and environment: validation, encryption, isolation and no values in API", async () => {
  assert.throws(() => validateRuntime({ output: "../private" }));
  assert.throws(() => validateRuntime({ policy: "anything" }));
  assert.equal(
    validateRuntime({ build: "", output: "public" }).policy,
    "manual",
  );
  for (const name of ["NODE_OPTIONS","DOCKER_HOST","DOCKER_CONFIG","HTTP_PROXY","DYLD_INSERT_LIBRARIES"]) assert.throws(() => setEnvironment(org, project, "production", name, "bad"));
  setEnvironment(
    org,
    project,
    "production",
    "API_TOKEN",
    "a-secret-that-stays-private",
  );
  const path = `/api/orgs/${org}/projects/${project}/environment`;
  assert.equal((await api(bob.id, "GET", path)).status, 404);
  assert.equal((await api(member.id, "GET", path)).status, 403);
  const response = await api(alice.id, "GET", path);
  assert.ok(!(await response.text()).includes("a-secret"));
  const raw = d.db
    .prepare("select ciphertext from project_environment")
    .get() as { ciphertext: Buffer };
  assert.ok(!Buffer.from(raw.ciphertext).includes(Buffer.from("a-secret")));
  assert.throws(() => queueRelease(other, project, bob.id));
  assert.equal(
    (await api(bob.id, "GET", `/api/orgs/${org}/projects/${project}/releases`))
      .status,
    404,
  );
  assert.equal(
    (
      await api(
        viewer.id,
        "POST",
        `/api/orgs/${org}/projects/${project}/releases`,
        {},
      )
    ).status,
    403,
  );
});
test("scaffolding: a usable local repository, runtime and scoped project", async () => {
  const res = await api(
    alice.id,
    "POST",
    `/api/orgs/${org}/projects/scaffold`,
    { name: "Mon site", slug: "mon-site", template: "static" },
  );
  assert.equal(res.status, 201);
  const value = (await res.json()) as {
    project: { id: string; managed: boolean; runtime: unknown };
  };
  assert.equal(value.project.managed, true);
  assert.ok(value.project.runtime);
  assert.equal(
    (
      await api(
        bob.id,
        "GET",
        `/api/orgs/${org}/projects/${value.project.id}/runtime`,
      )
    ).status,
    404,
  );
});

test("chat prices: validated and scoped, ledger includes configured token costs", async () => {
  const path = `/api/orgs/${org}`;
  assert.equal(
    (await api(member.id, "PATCH", path, { chatInputUsdPerMillion: 3 })).status,
    403,
  );
  assert.equal(
    (await api(bob.id, "PATCH", path, { chatOutputUsdPerMillion: 15 })).status,
    404,
  );
  assert.equal(
    (await api(alice.id, "PATCH", path, { chatInputUsdPerMillion: -1 })).status,
    400,
  );
  assert.equal(
    (
      await api(alice.id, "PATCH", path, {
        chatInputUsdPerMillion: 3,
        chatOutputUsdPerMillion: 15,
      })
    ).status,
    200,
  );
  assert.equal(d.getOrg(org)!.chat_input_price, 3);
});

test("Node template: generated authentication, private storage and SQLite pass their runtime test", async () => {
  const { scaffold } = await import("./scaffold.ts");
  const { clone, cleanup, revision, assertBaseMatches } = await import("./git.ts");
  const { rowToProject } = await import("./projects.ts");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const p = await scaffold(org, {
    name: "Node app",
    slug: "node-app",
    template: "node",
  });
  const ws = await clone(
    rowToProject(p),
    "node-template-check",
    "check/template",
  );
  try {
    const base = await revision(ws);
    await assertBaseMatches(rowToProject(p), base, "template-base");
    const run = promisify(execFile);
    await run("git", ["--git-dir", ws.gitdir, "--work-tree", ws.tree, "rm", "server.mjs"]);
    await run("git", ["--git-dir", ws.gitdir, "--work-tree", ws.tree, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Changed tree"]);
    await run("git", ["--git-dir", ws.gitdir, "push", "origin", "HEAD:check/changed"]);
    await assert.rejects(assertBaseMatches(rowToProject(p), await revision(ws), "template-changed"), /fusionnée/);
    await run("git", ["--git-dir", ws.gitdir, "--work-tree", ws.tree, "reset", "--hard", base]);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const output = await promisify(execFile)(
      process.execPath,
      ["--test", "--test-reporter=tap", "server.test.mjs"],
      { cwd: ws.tree, timeout: 20000, env },
    );
    assert.match(output.stdout, /# pass 1/);
  } finally {
    await cleanup("node-template-check");
  }
});


test("proposal resume only recovers a pushed failed first turn", async () => {
  const id="bbb00009", path=`/api/orgs/${org}/tasks/${id}/resume`;
  d.createTask(id, org, alice.id, project, "recover");
  d.updateTask(id,{status:"done",branch:"atelier/recover",pushed_sha:"a".repeat(40)});
  assert.equal((await api(alice.id,"POST",path,{})).status,409);
  d.updateTask(id,{status:"failed",turn:2});
  assert.equal((await api(alice.id,"POST",path,{})).status,409);
  d.updateTask(id,{turn:1,last_error:"forge unavailable"});
  assert.equal((await api(bob.id,"POST",path,{})).status,404);
  assert.equal((await api(alice.id,"POST",path,{})).status,200);
  assert.equal(d.getTask(id)!.last_error,null);
  assert.equal(d.getTask(id)!.status,"done");
});


test("application networks use distinct small private subnets and reject public pools", async () => {
  const {applicationSubnet}=await import("./releases.ts");
  const subnets=new Set(Array.from({length:64},(_,i)=>applicationSubnet("10.240.0.0/16","preview",i)));
  assert.equal(subnets.size,64);
  for (const subnet of subnets) {
    const [a,b,c,last]=subnet.split(".");
    assert.equal(`${a}.${b}`,"10.240");
    assert.ok(Number(c)<256);
    assert.equal(Number(last.split("/")[0])%8,0);
    assert.ok(subnet.endsWith("/29"));
  }
  for(const pool of ["8.8.0.0/16","172.32.0.0/16","192.169.0.0/16","10.999.0.0/16","10.240.1.0/16"])
    assert.throws(()=>applicationSubnet(pool,"x"));
});
