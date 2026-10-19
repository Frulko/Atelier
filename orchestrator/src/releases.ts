import { randomBytes, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { mkdir, rm, cp, readFile, chown, readdir } from "node:fs/promises";
import { join } from "node:path";
import { cfg } from "./config.ts";
import {
  db,
  getProjectInOrg,
  getProjectById,
  getTaskInOrg,
  roleOf,
  type ProjectRow,
} from "./db.ts";
import { rowToProject } from "./projects.ts";
import { clone, cleanup, revision, promoteManaged, assertBaseMatches } from "./git.ts";
import { HARDENING, installDependencies, kill, runCheck } from "./sandbox.ts";
import { issueTaskToken, revokeTaskTokens } from "./tokens.ts";
import { encrypt, decrypt } from "./vault.ts";
import { body, HttpError } from "./http.ts";
import { notify } from "./notifications.ts";
import { assertSafeFiles, containsSecret, applicationCsp, taskLogRedactor } from "./security.ts";
import { audit } from "./audit.ts";
import { overBudget } from "./budget.ts";
import { can } from "./access.ts";

const run = promisify(execFile);
export const appsDomain = process.env.ATELIER_APPS_DOMAIN || "";
const appsScheme =
  process.env.ATELIER_APPS_SCHEME === "http" ? "http" : "https";
const appNetwork = (id: string, production = false) =>
  `atelier-app-${id}${production ? "-prod" : ""}`;
const publicPort = process.env.ATELIER_APPS_PUBLIC_PORT
  ? `:${process.env.ATELIER_APPS_PUBLIC_PORT}`
  : "";
const publicOrigin = process.env.ATELIER_PUBLIC_URL
  ? new URL(process.env.ATELIER_PUBLIC_URL).origin
  : "";

export type Runtime = {
  build: string;
  output: string;
  start: string;
  policy: "manual" | "approved" | "automatic";
  preview: boolean;
};
export const runtimeOf = (p: ProjectRow): Runtime | null =>
  p.runtime_json ? JSON.parse(p.runtime_json) : null;
export function validateRuntime(value: any): Runtime {
  if (!value || typeof value !== "object")
    throw new HttpError(400, "Configuration d'exécution requise.");
  const {
    build = "",
    output = "dist",
    start = "",
    policy = "manual",
    preview = true,
  } = value;
  if (containsSecret(`${build}\n${start}`))
    throw new HttpError(
      400,
      "Place les secrets dans les variables chiffrées, pas dans les commandes.",
    );
  if (
    ![build, start].every(
      (x) => typeof x === "string" && x.length <= 500 && !x.includes("\0"),
    )
  )
    throw new HttpError(400, "Commande invalide.");
  if (
    typeof output !== "string" ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(output) ||
    output.length > 150
  )
    throw new HttpError(400, "Dossier de sortie invalide.");
  if (
    !["manual", "approved", "automatic"].includes(policy) ||
    typeof preview !== "boolean"
  )
    throw new HttpError(400, "Politique de publication invalide.");
  return { build, output, start, policy, preview };
}

db.exec(`
  create table if not exists releases (
    id text primary key, org_id text not null references orgs(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade, user_id text not null,
    task_id text, sha text, ref text not null, state text not null, error text,
    check_ok integer not null default 0, qa_ok integer not null default 0,
    runtime_json text not null, created_at integer not null, expires_at integer,
    published_at integer, log text not null default ''
  );
  create index if not exists releases_project on releases(org_id,project_id,created_at);
  create table if not exists preview_sessions (
    hash text primary key, release_id text not null references releases(id) on delete cascade,
    user_id text not null references users(id) on delete cascade, org_id text not null references orgs(id) on delete cascade,
    platform_session text not null references sessions(token_hash) on delete cascade, expires_at integer not null
  );
  create table if not exists publications (
    project_id text primary key references projects(id) on delete cascade,
    release_id text not null references releases(id), previous_id text, updated_at integer not null
  );
  create table if not exists project_environment (
    org_id text not null references orgs(id) on delete cascade,
    project_id text not null references projects(id) on delete cascade,
    environment text not null, name text not null, ciphertext blob not null,
    primary key(project_id,environment,name)
  );
`);
export type Release = {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  task_id: string | null;
  sha: string | null;
  ref: string;
  state: "queued" | "building" | "ready" | "failed" | "stopped";
  error: string | null;
  check_ok: number;
  qa_ok: number;
  runtime_json: string;
  created_at: number;
  expires_at: number | null;
  published_at: number | null;
  log: string;
};
export const releaseDir = (id: string) => join(cfg.workDir, "_releases", id);
export const releaseUrl = (id: string) =>
  appsDomain ? `${appsScheme}://${id}.${appsDomain}${publicPort}` : null;
export const productionUrl = (projectId: string) =>
  appsDomain
    ? `${appsScheme}://p-${projectId}.${appsDomain}${publicPort}`
    : null;
export const getRelease = (id: string, org: string) =>
  db.prepare("select * from releases where id=? and org_id=?").get(id, org) as
    Release | undefined;
export const releaseJson = (r: Release, fullLog = false) => {
  const { runtime_json, ...visible } = r;
  return {
    ...visible,
    log: fullLog ? r.log : r.log.slice(-2000),
    number: (db.prepare("select count(*) as n from releases where project_id=? and rowid<=(select rowid from releases where id=?)").get(r.project_id, r.id) as { n: number }).n,
    taskPrompt: r.task_id ? getTaskInOrg(r.task_id, r.org_id)?.prompt ?? null : null,
    url: releaseUrl(r.id),
    productionUrl: productionUrl(r.project_id),
    published: !!db
      .prepare("select 1 from publications where release_id=?")
      .get(r.id),
  };
};
export const listReleases = (org: string, project: string) =>
  (
    db
      .prepare(
        "select * from releases where org_id=? and project_id=? order by created_at desc limit 50",
      )
      .all(org, project) as Release[]
  ).map(r => releaseJson(r));
const update = (id: string, patch: Partial<Release>) => {
  const keys = Object.keys(patch);
  db.prepare(
    `update releases set ${keys.map((k) => `${k}=?`).join(",")} where id=?`,
  ).run(...(Object.values(patch) as (string | number | null)[]), id);
};

export function setEnvironment(
  org: string,
  project: string,
  environment: unknown,
  name: unknown,
  value: unknown,
) {
  if (
    !["preview", "production"].includes(String(environment)) ||
    typeof name !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,79}$/.test(name) ||
    /^(PATH|HOME|NODE_OPTIONS|LD_.*|DYLD_.*|DOCKER_.*|GODEBUG|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|ATELIER_.*|PORT|APP_DATA_DIR)$/.test(
      name,
    )
  )
    throw new HttpError(400, "Variable ou environnement invalide.");
  if (
    value !== null &&
    (typeof value !== "string" || value.length > 10_000 || value.includes("\0"))
  )
    throw new HttpError(400, "Valeur invalide.");
  if (value === null)
    db.prepare(
      "delete from project_environment where org_id=? and project_id=? and environment=? and name=?",
    ).run(org, project, String(environment), name);
  else
    db.prepare(
      "insert into project_environment (org_id,project_id,environment,name,ciphertext) values (?,?,?,?,?) on conflict(project_id,environment,name) do update set ciphertext=excluded.ciphertext",
    ).run(
      org,
      project,
      String(environment),
      name,
      encrypt(value, org, `${project}:${environment}:${name}`),
    );
}
function environmentValues(r: Release, environment: string) {
  return (
    db
      .prepare(
        "select name,ciphertext from project_environment where org_id=? and project_id=? and environment=?",
      )
      .all(r.org_id, r.project_id, environment) as {
      name: string;
      ciphertext: Buffer;
    }[]
  ).map(
    (v) =>
      [
        v.name,
        decrypt(
          v.ciphertext,
          r.org_id,
          `${r.project_id}:${environment}:${v.name}`,
        ),
      ] as const,
  );
}

export function queueRelease(
  org: string,
  projectId: string,
  userId: string,
  taskId?: string,
) {
  const project = getProjectInOrg(projectId, org);
  if (!project) throw new HttpError(404, "Projet introuvable.");
  const runtime = runtimeOf(project);
  if (!runtime)
    throw new HttpError(
      409,
      "Configure le build et le démarrage dans Publications.",
    );
  if (!appsDomain || !publicOrigin)
    throw new HttpError(
      409,
      "L'administrateur du serveur doit configurer ATELIER_APPS_DOMAIN et le proxy des applications.",
    );
  const task = taskId ? getTaskInOrg(taskId, org) : null;
  if (
    taskId &&
    (!task ||
      task.project !== projectId ||
      task.status !== "done" ||
      !task.pushed_sha ||
      task.last_error)
  )
    throw new HttpError(
      409,
      "Cette tâche n'a pas de version prête à construire.",
    );
  if (
    db
      .prepare(
        "select 1 from releases where project_id=? and state in ('queued','building')",
      )
      .get(projectId)
  )
    throw new HttpError(
      409,
      "Une construction est déjà en cours pour ce projet.",
    );
  const id = randomBytes(8).toString("hex");
  db.prepare(
    "insert into releases (id,org_id,project_id,user_id,task_id,sha,ref,state,runtime_json,created_at,expires_at) values (?,?,?,?,?,?,?,'queued',?,?,?)",
  ).run(
    id,
    org,
    projectId,
    userId,
    taskId ?? null,
    task?.pushed_sha ?? null,
    task?.branch ?? project.branch,
    JSON.stringify(runtime),
    Date.now(),
    Date.now() + 7 * 86_400_000,
  );
  return getRelease(id, org)!;
}

/** Small dedicated subnets avoid consuming Docker's default pool for each preview. */
export function applicationSubnet(pool: string, name: string, attempt = 0) {
  const match = /^(10|172|192)\.(\d{1,3})\.0\.0\/16$/.exec(pool);
  if (!match || Number(match[2]) > 255 ||
      (match[1] === "172" && (Number(match[2]) < 16 || Number(match[2]) > 31)) ||
      (match[1] === "192" && Number(match[2]) !== 168))
    throw new HttpError(503, "ATELIER_APPS_SUBNET_POOL doit être un réseau privé IPv4 /16.");
  const slot = (createHash("sha256").update(name).digest().readUInt16BE(0) + attempt) % 8192;
  return `${Number(match[1])}.${Number(match[2])}.${Math.floor(slot / 32)}.${(slot % 32) * 8}/29`;
}

async function ensureNetwork(id: string, production = false) {
  const name = appNetwork(id, production);
  const exists = await run("docker", [
    "network",
    "inspect",
    name,
    "--format",
    "{{.Internal}}",
  ]).catch(() => null);
  if (exists && exists.stdout.trim() !== "true")
    throw new Error("Le réseau de l'application n'est pas isolé.");
  if (!exists) {
    let created = false;
    for (let attempt = 0; attempt < 64; attempt++) {
      try {
        await run("docker", ["network", "create", "--internal", "--subnet",
          applicationSubnet(process.env.ATELIER_APPS_SUBNET_POOL || "10.240.0.0/16", name, attempt),
          "--label", `atelier-app-owner=${cfg.sandboxNetwork}`, name]);
        created = true;
        break;
      } catch (e) {
        if (!/overlap/i.test(String((e as { stderr?: string }).stderr))) throw e;
      }
    }
    if (!created) throw new HttpError(503, "Aucun sous-réseau applicatif disponible. Vérifie ATELIER_APPS_SUBNET_POOL.");
  }
  const orchestrator = new URL(cfg.proxyUrl).hostname;
  try {
    await run("docker", ["network", "connect", name, orchestrator]);
  } catch (e) {
    if (
      !/already exists|already connected/i.test(
        String((e as { stderr?: string }).stderr),
      )
    )
      throw e;
  }
  return name;
}
async function removeNetwork(id: string) {
  for (const production of [false, true]) {
    const name = appNetwork(id, production);
    await run("docker", [
      "network",
      "disconnect",
      "-f",
      name,
      new URL(cfg.proxyUrl).hostname,
    ]).catch(() => {});
    await run("docker", ["network", "rm", name]).catch(() => {});
  }
}

async function startContainer(r: Release, production = false) {
  const network = await ensureNetwork(r.id, production);
  const name = `atelier-app-${r.id}${production ? "-prod" : ""}`,
    runtime = JSON.parse(r.runtime_json) as Runtime;
  await run("docker", ["rm", "-f", name]).catch(() => {});
  const values = environmentValues(r, production ? "production" : "preview");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...Object.fromEntries(values),
  };
  for (const key of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"])
    if (process.env[key]) env[key] = process.env[key];
  const data = join(
    cfg.workDir,
    "_appdata",
    r.project_id,
    production ? "production" : "preview",
  );
  await mkdir(data, { recursive: true });
  if (process.getuid?.() === 0) await chown(data, 1000, 1000);
  await run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "atelier-app=1",
      "--label",
      `atelier-app-owner=${cfg.sandboxNetwork}`,
      "--restart",
      "unless-stopped",
      "--network",
      network,
      ...HARDENING,
      "--log-driver",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,size=64m",
      "-v",
      `${join(releaseDir(r.id), "tree")}:/work:ro`,
      "-v",
      `${data}:/data`,
      "-e",
      "APP_DATA_DIR=/data",
      "-e",
      "PORT=3000",
      "-e",
      `ATELIER_OUTPUT_DIR=${runtime.output}`,
      ...values.flatMap(([key]) => ["-e", key]),
      "--entrypoint",
      runtime.start ? "sh" : "node",
      cfg.sandboxImage,
      ...(runtime.start ? ["-c", runtime.start] : ["/opt/runner/serve.mjs"]),
    ],
    { env, timeout: 30_000 },
  );
  try {
    for (let i = 0; i < 30; i++) {
      const ok = await new Promise<boolean>((resolve) => {
        const request = http.get(`http://${name}:3000/`, (res) => {
          res.resume();
          resolve((res.statusCode ?? 500) < 400);
        });
        request.on("error", () => resolve(false));
        request.setTimeout(1000, () => request.destroy());
      });
      if (ok) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("L'application ne répond pas sur le port 3000.");
  } catch (e) {
    await run("docker", ["rm", "-f", name]).catch(() => {});
    throw e;
  }
}

async function browserCheck(r: Release) {
  const shots = join(releaseDir(r.id), "qa");
  await mkdir(shots, { recursive: true });
  if (process.getuid?.() === 0) await chown(shots, 1000, 1000);
  const name = `atelier-qa-${r.id}`;
  try {
    await run(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--label",
        "atelier=1",
        "--label",
        `atelier-owner=${cfg.sandboxNetwork}`,
        "--network",
        appNetwork(r.id),
        ...HARDENING,
        "-v",
        `${shots}:/shots`,
        "-e",
        `ATELIER_QA_URL=http://atelier-app-${r.id}:3000/`,
        "--entrypoint",
        "node",
        cfg.sandboxImage,
        "/opt/runner/qa.mjs",
      ],
      { timeout: 40_000, maxBuffer: 2e6 },
    );
    const report = JSON.parse(
      await readFile(join(shots, "report.json"), "utf8"),
    );
    if (!report.ok) throw Error();
  } catch {
    await kill(name);
    throw new Error(
      "Le contrôle navigateur a échoué. Consulte le rapport et les captures.",
    );
  }
}

async function buildRelease(r: Release) {
  const job = `release-${r.id}`,
    name = `atelier-release-${r.id}`;
  let token = "";
  let redact = (text: string) => text;
  const log = (text: string) => {
    const previous = getRelease(r.id, r.org_id)?.log ?? "";
    update(r.id, { log: `${previous}\n[${new Date().toISOString()}] ${redact(text)}`.slice(-120000) });
  };
  try {
    redact = await taskLogRedactor(r.org_id);
    update(r.id, { state: "building", log: "" });
    log(`Copie de la branche ${r.ref}…`);
    const project = getProjectById(r.project_id);
    if (!project) throw new Error("Projet supprimé.");
    const ws = await clone(
      { ...rowToProject(project), branch: r.ref },
      job,
      `release/${r.id}`,
    );
    const sha = await revision(ws);
    if (r.sha && r.sha !== sha)
      throw new Error(
        "La branche a changé depuis la proposition. Construis sa nouvelle version.",
      );
    const sources = await run(
      "git",
      ["--git-dir", ws.gitdir, "--work-tree", ws.tree, "ls-files", "-z"],
      { timeout: 10000, maxBuffer: 5e6 },
    );
    await assertSafeFiles(
      ws.tree,
      sources.stdout.split("\0").filter(Boolean),
      r.org_id,
    );
    update(r.id, { sha });
    log(`Version source : ${sha}. Installation npm…`);
    token = issueTaskToken(job, r.org_id);
    await installDependencies(`${name}-install`, ws.tree, token, log);
    if (!project.check_cmd.trim() || project.check_cmd.trim() === "true")
      throw new Error(
        "Configure une véritable commande de vérification avant de publier.",
      );
    log(`Vérification : ${project.check_cmd}`);
    const check = await runCheck(`${name}-check`, ws.tree, project.check_cmd, text => redact(text));
    log(check.output || (check.ok ? "Vérification réussie." : "Vérification échouée sans sortie."));
    if (!check.ok) throw new Error(`Vérification échouée : ${check.output}`);
    const runtime = JSON.parse(r.runtime_json) as Runtime;
    if (runtime.build && runtime.build !== project.check_cmd) {
      log(`Build : ${runtime.build}`);
      const build = await runCheck(`${name}-build`, ws.tree, runtime.build, text => redact(text));
      log(build.output || (build.ok ? "Build réussi." : "Build échoué sans sortie."));
      if (!build.ok) throw new Error(`Build échoué : ${build.output}`);
    }
    const tracked = await run(
      "git",
      ["--git-dir", ws.gitdir, "--work-tree", ws.tree, "ls-files", "-z"],
      { timeout: 10000, maxBuffer: 5e6 },
    );
    await assertSafeFiles(
      ws.tree,
      tracked.stdout.split("\0").filter(Boolean),
      r.org_id,
    );
    await mkdir(releaseDir(r.id), { recursive: true });
    await cp(ws.tree, join(releaseDir(r.id), "tree"), {
      recursive: true,
      dereference: false,
    });
    const ready = { ...r, sha, check_ok: 1 };
    update(r.id, {
      sha,
      check_ok: 1,
    });
    log("Démarrage et contrôle navigateur…");
    await startContainer(ready);
    await browserCheck(ready);
    update(r.id, {
      state: "ready",
      qa_ok: 1,
      error: null,
    });
    log("Vérification, build et contrôle navigateur réussis.");
    notify(
      r.user_id,
      r.org_id,
      "L'aperçu est prêt",
      project.name,
      `/o/${r.org_id}/projects/${r.project_id}/releases`,
      `release:${r.id}:ready`,
    );
    if (
      runtime.policy === "automatic" &&
      runtimeOf(getProjectById(r.project_id)!)?.policy === "automatic" &&
      r.task_id
    ) {
      const task = getTaskInOrg(r.task_id, r.org_id);
      const role = roleOf(r.org_id, r.user_id);
      if (
        task &&
        !task.flagged &&
        !task.last_error &&
        !db
          .prepare(
            "select 1 from project_environment where project_id=? and environment='production'",
          )
          .get(r.project_id) &&
        role &&
        can(role, "project:manage") &&
        !overBudget(r.org_id)
      )
        try {
          await publishRelease(getRelease(r.id, r.org_id)!, r.user_id, false);
        } catch {
          update(r.id, {
            error:
              "Publication automatique interrompue : une validation manuelle est nécessaire.",
          });
        }
    }
  } catch (e) {
    const error = redact(String((e as Error).message || e)).slice(-6000);
    update(r.id, { state: "failed", error });
    log(`Échec : ${error}`);
    await run("docker", ["rm", "-f", `atelier-app-${r.id}`]).catch(() => {});
    await removeNetwork(r.id);
    notify(
      r.user_id,
      r.org_id,
      "La construction a échoué",
      getProjectById(r.project_id)?.name ?? "Projet",
      `/o/${r.org_id}/projects/${r.project_id}/releases`,
      `release:${r.id}:failed`,
    );
  } finally {
    revokeTaskTokens(job);
    await cleanup(job);
  }
}

async function publishUnlocked(r: Release, userId: string, reviewed: boolean) {
  const role = roleOf(r.org_id, userId);
  if (!role || !can(role, "project:manage"))
    throw new HttpError(403, "Droits de publication requis.");
  if (r.state !== "ready" || !r.check_ok || !r.qa_ok)
    throw new HttpError(409, "Cette version n'a pas passé les contrôles.");
  const task = r.task_id ? getTaskInOrg(r.task_id, r.org_id) : null;
  const currentProject = getProjectById(r.project_id);
  if (!currentProject) throw new HttpError(404, "Projet introuvable.");
  const protectedPaths: string[] = JSON.parse(currentProject.protected_paths);
  const protectedChange =
    task &&
    (task.flagged > 0 ||
      (JSON.parse(task.files_json ?? "[]") as string[]).length >= 200 ||
      (JSON.parse(task.files_json ?? "[]") as string[]).some((file) =>
        protectedPaths.some((path) => file.startsWith(path)),
      ));
  if (protectedChange && !reviewed)
    throw new HttpError(
      409,
      "Des chemins protégés ont changé : confirme explicitement leur relecture.",
    );
  if (
    task &&
    (task.status !== "done" || task.last_error || task.pushed_sha !== r.sha)
  )
    throw new HttpError(
      409,
      "La proposition a changé ou a échoué. Construis un nouvel aperçu.",
    );
  const current = db
    .prepare("select release_id from publications where project_id=?")
    .get(r.project_id) as { release_id: string } | undefined;
  if (current?.release_id === r.id) return { url: productionUrl(r.project_id) };
  await startContainer(r, true);
  const project = getProjectById(r.project_id);
  try {
    if (project?.managed && r.sha) await promoteManaged(rowToProject(project), r.sha, r.id);
    else if (project && r.sha) await assertBaseMatches(rowToProject(project),r.sha,r.id);
  } catch {
    await run("docker", ["rm", "-f", `atelier-app-${r.id}-prod`]).catch(
      () => {},
    );
    throw new HttpError(
      409,
      "La branche de base a changé. Construis une proposition à partir de sa nouvelle version.",
    );
  }
  const old = db
    .prepare("select release_id from publications where project_id=?")
    .get(r.project_id) as { release_id: string } | undefined;
  db.prepare(
    "insert into publications (project_id,release_id,previous_id,updated_at) values (?,?,?,?) on conflict(project_id) do update set previous_id=publications.release_id,release_id=excluded.release_id,updated_at=excluded.updated_at",
  ).run(r.project_id, r.id, old?.release_id ?? null, Date.now());
  update(r.id, { published_at: Date.now(), expires_at: null });
  audit(
    { orgId: r.org_id, userId },
    old ? "release.publish" : "release.first_publish",
    { type: "release", id: r.id },
    { sha: r.sha, projectId: r.project_id, reviewed },
  );
  if (old && old.release_id !== r.id)
    await run("docker", [
      "rm",
      "-f",
      `atelier-app-${old.release_id}-prod`,
    ]).catch(() => {});
  notify(
    userId,
    r.org_id,
    "Application publiée",
    getProjectById(r.project_id)?.name ?? "Projet",
    `/o/${r.org_id}/projects/${r.project_id}/releases`,
    `publish:${r.id}:${Date.now()}`,
  );
  return { url: productionUrl(r.project_id) };
}

async function rollbackUnlocked(
  org: string,
  project: string,
  userId: string,
  id: string,
) {
  const target = getRelease(id, org);
  if (!target || target.project_id !== project || !target.published_at)
    throw new HttpError(404, "Version publiée introuvable.");
  // Rollback intentionally restores a previously checked artifact even if its original task later changed.
  const role = roleOf(org, userId);
  if (!role || !can(role, "project:manage"))
    throw new HttpError(403, "Droits de publication requis.");
  const current = db
    .prepare("select release_id from publications where project_id=?")
    .get(project) as { release_id: string } | undefined;
  if (current?.release_id === id) return { url: productionUrl(project) };
  await startContainer(target, true);
  const old = db
    .prepare("select release_id from publications where project_id=?")
    .get(project) as { release_id: string } | undefined;
  db.prepare(
    "insert into publications (project_id,release_id,previous_id,updated_at) values (?,?,?,?) on conflict(project_id) do update set previous_id=publications.release_id,release_id=excluded.release_id,updated_at=excluded.updated_at",
  ).run(project, id, old?.release_id ?? null, Date.now());
  audit(
    { orgId: org, userId },
    "release.rollback",
    { type: "release", id },
    { projectId: project, sha: target.sha },
  );
  if (old && old.release_id !== id)
    await run("docker", [
      "rm",
      "-f",
      `atelier-app-${old.release_id}-prod`,
    ]).catch(() => {});
  return { url: productionUrl(project) };
}

let building = false;
export async function tickReleases() {
  if (building) return;
  building = true;
  try {
    const row = db
      .prepare(
        "select * from releases where state='queued' order by created_at limit 1",
      )
      .get() as Release | undefined;
    if (row) await buildRelease(row);
  } finally {
    building = false;
  }
}
export function startReleases() {
  db.prepare(
    "update releases set state='failed',error='Construction interrompue par un redémarrage. Relance un aperçu.' where state='building'",
  ).run();
  const timer = setInterval(
    () =>
      void tickReleases().catch(() =>
        console.warn("release: construction indisponible"),
      ),
    2000,
  );
  timer.unref();
  return () => clearInterval(timer);
}

const hashAccess = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const previewTickets = new Map<
  string,
  {
    releaseId: string;
    userId: string;
    orgId: string;
    sessionHash: string;
    expiresAt: number;
  }
>();
export function issuePreviewAccess(
  r: Release,
  userId: string,
  sessionToken: string,
) {
  for (const [key, value] of previewTickets)
    if (value.expiresAt < Date.now()) previewTickets.delete(key);
  if (previewTickets.size >= 1000)
    throw new HttpError(429, "Trop de demandes d'aperçu.");
  const ticket = randomBytes(32).toString("base64url");
  previewTickets.set(hashAccess(ticket), {
    releaseId: r.id,
    userId,
    orgId: r.org_id,
    sessionHash: hashAccess(sessionToken),
    expiresAt: Date.now() + 30_000,
  });
  return { ticket };
}

export function startAppsGateway() {
  if (!appsDomain) return;
  if (
    appsScheme === "http" &&
    !(
      appsDomain.endsWith(".localhost") &&
      new URL(publicOrigin).hostname === "localhost"
    )
  )
    throw new Error(
      "Les applications doivent être servies en HTTPS hors du développement localhost.",
    );
  if (
    publicOrigin &&
    (new URL(publicOrigin).hostname === appsDomain ||
      new URL(publicOrigin).hostname.endsWith(`.${appsDomain}`))
  )
    throw new Error(
      "Le domaine des applications doit être distinct du domaine Atelier.",
    );
  if (!/^[a-z0-9.-]+$/.test(appsDomain))
    throw new Error("ATELIER_APPS_DOMAIN invalide.");
  return http
    .createServer(async (req, res) => {
      const host = (req.headers.host ?? "").split(":")[0]!;
      if (!host.endsWith(`.${appsDomain}`)) {
        res.writeHead(404).end();
        return;
      }
      const label = host.slice(0, -appsDomain.length - 1);
      let release: Release | undefined;
      let production = false;
      if (/^p-[0-9a-f]{16}$/.test(label)) {
        release = db
          .prepare(
            "select r.* from releases r join publications p on p.release_id=r.id where p.project_id=?",
          )
          .get(label.slice(2)) as Release | undefined;
        production = true;
      } else if (/^[0-9a-f]{16}$/.test(label))
        release = db
          .prepare("select * from releases where id=? and state='ready'")
          .get(label) as Release | undefined;
      if (!release || (release.expires_at && release.expires_at < Date.now())) {
        res.writeHead(404).end("Aperçu expiré ou indisponible");
        return;
      }
      if (!production) {
        if (req.url === "/.atelier/access") {
          if (req.headers.origin !== publicOrigin) {
            res.writeHead(403).end();
            return;
          }
          res.setHeader("access-control-allow-origin", publicOrigin);
          res.setHeader("access-control-allow-credentials", "true");
          res.setHeader("vary", "Origin");
          if (req.method === "OPTIONS") {
            res
              .writeHead(204, {
                "access-control-allow-methods": "POST",
                "access-control-allow-headers": "content-type",
              })
              .end();
            return;
          }
          if (req.method !== "POST") {
            res.writeHead(405).end();
            return;
          }
          try {
            const b = await body(req, 1024),
              key = typeof b.ticket === "string" ? hashAccess(b.ticket) : "",
              ticket = previewTickets.get(key);
            previewTickets.delete(key);
            if (
              !ticket ||
              ticket.expiresAt < Date.now() ||
              ticket.releaseId !== release.id ||
              !roleOf(release.org_id, ticket.userId) ||
              !db
                .prepare(
                  "select 1 from sessions where token_hash=? and expires_at>?",
                )
                .get(ticket.sessionHash, Date.now())
            ) {
              res.writeHead(403).end();
              return;
            }
            const value = randomBytes(32).toString("base64url");
            db.prepare("delete from preview_sessions where expires_at<?").run(
              Date.now(),
            );
            db.prepare("insert into preview_sessions values (?,?,?,?,?,?)").run(
              hashAccess(value),
              release.id,
              ticket.userId,
              ticket.orgId,
              ticket.sessionHash,
              Date.now() + 3600_000,
            );
            res
              .writeHead(204, {
                "set-cookie": `atelier_preview=${value}; HttpOnly; Path=/; Max-Age=3600; SameSite=None; Secure; Partitioned`,
                "cache-control": "no-store",
              })
              .end();
            return;
          } catch {
            res.writeHead(400).end();
            return;
          }
        }
        const cookie = (req.headers.cookie ?? "")
          .split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("atelier_preview="))
          ?.slice(16);
        const session = cookie
          ? (db
              .prepare(
                "select p.user_id from preview_sessions p join sessions s on s.token_hash=p.platform_session where p.hash=? and p.release_id=? and p.expires_at>? and s.expires_at>?",
              )
              .get(hashAccess(cookie), release.id, Date.now(), Date.now()) as
              { user_id: string } | undefined)
          : undefined;
        if (!session || !roleOf(release.org_id, session.user_id)) {
          res
            .writeHead(401, {
              "content-type": "text/plain; charset=utf-8",
              "cache-control": "no-store",
            })
            .end("Ouvre cet aperçu depuis Atelier avec un compte autorisé.");
          return;
        }
      }
      const requestHeaders = { ...req.headers };
      if (requestHeaders.cookie)
        requestHeaders.cookie = requestHeaders.cookie
          .split(";")
          .filter(
            (v) => !/^(?:__Host-)?atelier_(session|preview)=/.test(v.trim()),
          )
          .join(";");
      requestHeaders["x-forwarded-proto"] = appsScheme;
      const upstream = http.request(
        {
          hostname: `atelier-app-${release.id}${production ? "-prod" : ""}`,
          port: 3000,
          path: req.url,
          method: req.method,
          headers: requestHeaders,
        },
        (response) => {
          const headers = { ...response.headers };
          if (headers["set-cookie"])
            headers["set-cookie"] = headers["set-cookie"]
              .filter(
                (cookie) =>
                  !/^(?:__Host-)?atelier_(preview|session)=/i.test(cookie),
              )
              .map((cookie) => cookie.replace(/;\s*Domain=[^;]+/gi, ""));
          delete headers["content-security-policy"];
          delete headers["content-security-policy-report-only"];
          delete headers["report-to"];
          delete headers.nel;
          delete headers["x-frame-options"];
          delete headers["access-control-allow-origin"];
          delete headers["access-control-allow-credentials"];
          delete headers.refresh;
          delete headers.link;
          delete headers["alt-svc"];
          delete headers["reporting-endpoints"];
          if (headers.location) {
            const origin = `${appsScheme}://${req.headers.host}`;
            try {
              if (new URL(headers.location, origin).origin !== origin) {
                res.writeHead(502).end("Redirection externe refusée.");
                response.destroy();
                return;
              }
            } catch {
              res.writeHead(502).end();
              response.destroy();
              return;
            }
          }
          headers["content-security-policy"] = applicationCsp(publicOrigin);
          headers["cache-control"] = "no-store";
          headers["x-dns-prefetch-control"] = "off";
          headers["permissions-policy"] =
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), web-share=()";
          headers["x-content-type-options"] = "nosniff";
          headers["referrer-policy"] = "no-referrer";
          res.writeHead(response.statusCode ?? 502, headers);
          response.pipe(res);
        },
      );
      upstream.setTimeout(30_000, () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end("Application indisponible");
      });
      req.on("aborted", () => upstream.destroy());
      req.pipe(upstream);
    })
    .listen(Number(process.env.ATELIER_APPS_PORT || 8082));
}

export async function sweepReleases(now = Date.now()) {
  const rows = db
    .prepare(
      "select id from releases where expires_at < ? and state not in ('queued','building','stopped') and id not in (select release_id from publications)",
    )
    .all(now) as { id: string }[];
  for (const r of rows) {
    await run("docker", ["rm", "-f", `atelier-app-${r.id}`]).catch(() => {});
    update(r.id, { state: "stopped" });
    await rm(releaseDir(r.id), { recursive: true, force: true });
    await removeNetwork(r.id);
  }
  // Deleted projects must not leave serving containers or files behind.
  const dirs = await readdir(join(cfg.workDir, "_releases")).catch(() => []);
  for (const id of dirs)
    if (
      /^[0-9a-f]{16}$/.test(id) &&
      !db.prepare("select 1 from releases where id=?").get(id)
    ) {
      for (const suffix of ["", "-prod"])
        await run("docker", ["rm", "-f", `atelier-app-${id}${suffix}`]).catch(
          () => {},
        );
      await rm(releaseDir(id), { recursive: true, force: true });
      await removeNetwork(id);
    }
  for (const folder of ["_repos", "_appdata"]) {
    const entries = await readdir(join(cfg.workDir, folder)).catch(() => []);
    for (const entry of entries) {
      const id = folder === "_repos" ? entry.replace(/\.git$/, "") : entry;
      if (/^[0-9a-f]{16}$/.test(id) && !getProjectById(id))
        await rm(join(cfg.workDir, folder, entry), {
          recursive: true,
          force: true,
        });
    }
  }
}

const publishing = new Set<string>();
async function publicationLock<T>(projectId: string, work: () => Promise<T>) {
  if (publishing.has(projectId))
    throw new HttpError(
      409,
      "Une publication est déjà en cours pour ce projet.",
    );
  publishing.add(projectId);
  try {
    return await work();
  } finally {
    publishing.delete(projectId);
  }
}
export const publishRelease = (
  release: Release,
  userId: string,
  reviewed: boolean,
) =>
  publicationLock(release.project_id, () =>
    publishUnlocked(release, userId, reviewed),
  );
export const rollbackRelease = (
  org: string,
  project: string,
  userId: string,
  id: string,
) => publicationLock(project, () => rollbackUnlocked(org, project, userId, id));
