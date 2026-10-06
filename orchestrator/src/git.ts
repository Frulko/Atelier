import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cfg, type Project } from "./config.ts";

const run = promisify(execFile);

/*
 * MODÈLE DE MENACE : l'agent écrit librement dans le dossier de travail (`tree`).
 * Un .git/config ou un hook piégé y serait exécuté par NOTRE git (qui a le token).
 * Donc le répertoire git vit HORS du dossier monté dans le bac à sable, on le
 * désigne explicitement (--git-dir/--work-tree), et on neutralise hooks/fsmonitor.
 */
export type Workspace = { root: string; tree: string; gitdir: string };

export const workspace = (taskId: string): Workspace => {
  const root = join(cfg.workDir, taskId);
  return { root, tree: join(root, "tree"), gitdir: join(root, "git") };
};

// Config git passée par variables d'environnement : le token n'apparaît ni dans
// la ligne de commande, ni dans .git/config, ni dans le dossier vu par l'agent.
function gitEnv(token: string, forge: Project["forge"] = "gitlab"): NodeJS.ProcessEnv {
  const pairs: [string, string][] = [
    ["safe.directory", "*"],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
  ];
  if (token) {
    pairs.push(["http.extraHeader", `Authorization: Basic ${Buffer.from(`${forge === "github" ? "x-access-token" : "oauth2"}:${token}`).toString("base64")}`]);
  }
  const e: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => { e[`GIT_CONFIG_KEY_${i}`] = k; e[`GIT_CONFIG_VALUE_${i}`] = v; });
  return e;
}

const git = async (ws: Workspace, args: string[], token = "", forge: Project["forge"] = "gitlab") =>
  (await run("git", ["--git-dir", ws.gitdir, "--work-tree", ws.tree, ...args], { env: gitEnv(token, forge), maxBuffer: 20e6 })).stdout.trim();

/** `existing` : un ajustement repart de la branche déjà envoyée de la tâche (la proposition ouverte se met alors à jour), pas de la branche de base. */
export async function clone(p: Project, taskId: string, branch: string, existing = false): Promise<Workspace> {
  const ws = workspace(taskId);
  await mkdir(ws.root, { recursive: true });
  await run("git", ["clone", "--quiet", "--separate-git-dir", ws.gitdir, "--branch", existing ? branch : p.branch, p.repo, ws.tree], { env: gitEnv(p.token, p.forge) });
  await rm(join(ws.tree, ".git"), { force: true }); // l'agent ne voit pas le git
  if (!existing) await git(ws, ["checkout", "--quiet", "-b", branch]);
  // uid 1000 = utilisateur "node" du bac à sable
  await run("chown", ["-R", "1000:1000", ws.tree]);
  return ws;
}

/** Fichiers modifiés par l'agent (ajoute tout à l'index au passage). */
export async function changedFiles(ws: Workspace): Promise<string[]> {
  await rm(join(ws.tree, ".git"), { recursive: true, force: true }); // au cas où l'agent en aurait créé un
  await git(ws, ["add", "-A"]);
  const out = await git(ws, ["diff", "--cached", "--name-only"]);
  return out ? out.split("\n") : [];
}

export async function commitAndPush(p: Project, ws: Workspace, branch: string, message: string) {
  await git(ws, ["-c", `user.name=${cfg.gitAuthorName}`, "-c", `user.email=${cfg.gitAuthorEmail}`, "commit", "--quiet", "-m", message]);
  await git(ws, ["push", "--quiet", "origin", branch], p.token, p.forge);
}

/** Ouvre la MR (GitLab, y compris auto-hébergé) ou la PR (GitHub, y compris Enterprise). Rend son URL. */
export async function openMergeRequest(p: Project, branch: string, title: string, description: string): Promise<string | null> {
  if (p.forge === "none") return null;
  const u = new URL(p.repo);
  const path = u.pathname.replace(/^\/|\.git$/g, "");
  const token = p.token;

  if (p.forge === "github") {
    const api = u.hostname === "github.com" ? "https://api.github.com" : `${u.origin}/api/v3`;
    const r = await fetch(`${api}/repos/${path}/pulls`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atelier", "content-type": "application/json" },
      body: JSON.stringify({ title, head: branch, base: p.branch, body: description }),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return ((await r.json()) as { html_url: string }).html_url;
  }

  const r = await fetch(`${u.origin}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
    body: JSON.stringify({ source_branch: branch, target_branch: p.branch, title, description, remove_source_branch: true }),
  });
  if (!r.ok) throw new Error(`GitLab ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return ((await r.json()) as { web_url: string }).web_url;
}

export const cleanup = (taskId: string) => rm(workspace(taskId).root, { recursive: true, force: true });

/** Retire toute trace d'un secret d'un message d'erreur avant de le montrer. */
export const scrub = (text: string, secrets: string[]) =>
  secrets.filter((x) => x.length >= 4).reduce((t, x) => t.split(x).join("***"), text);

export type AccessCheck = { ok: boolean; branchFound: boolean; error?: "auth" | "not_found" | "timeout" | "unreachable"; detail?: string; ms: number };

/**
 * « Vérifier l'accès » : git ls-remote, sans rien cloner. Dit si le dépôt répond avec le jeton du projet et si la
 * branche existe. Le message d'erreur est nettoyé du jeton et plafonné.
 */
export async function verifyAccess(p: Project): Promise<AccessCheck> {
  const t0 = Date.now();
  try {
    const { stdout } = await run("git", ["ls-remote", "--heads", "--", p.repo, `refs/heads/${p.branch}`], { env: gitEnv(p.token, p.forge), timeout: 20_000, maxBuffer: 1e6 });
    return { ok: true, branchFound: stdout.includes(`refs/heads/${p.branch}`), ms: Date.now() - t0 };
  } catch (e: any) {
    const text = scrub(String(e.stderr || e.message || ""), [p.token]).slice(0, 300);
    const error = e.killed || e.signal === "SIGTERM" ? "timeout"
      : /authentication failed|could not read (username|password)|403|401|invalid credentials|access denied/i.test(text) ? "auth"
      : /not found|does not exist|404|repository .* not|does not appear to be a git repository/i.test(text) ? "not_found"
      : "unreachable";
    return { ok: false, branchFound: false, error, detail: text.trim(), ms: Date.now() - t0 };
  }
}

export type LatestCommit = { sha: string; subject: string; author: string; at: number };

/**
 * Dernier commit de la branche de base, SANS cloner tout le dépôt : un dépôt nu de travail (hors du dossier des tâches) où l'on
 * ne récupère que le sommet de la branche (profondeur 1). Les hooks sont neutralisés comme partout, le jeton passe par l'environnement.
 */
export async function latestCommit(p: Project, id: string): Promise<LatestCommit> {
  const dir = join(cfg.workDir, "_status", `${id}.git`);
  await mkdir(dir, { recursive: true });
  const env = gitEnv(p.token, p.forge);
  const g = (args: string[]) => run("git", ["--git-dir", dir, ...args], { env, timeout: 30_000, maxBuffer: 1e6 }).then((r) => r.stdout.trim());
  try {
    await g(["rev-parse", "--git-dir"]).catch(() => g(["init", "--bare", "--quiet"]));
    await g(["fetch", "--quiet", "--depth", "1", "--no-tags", "--", p.repo, `+refs/heads/${p.branch}:refs/heads/base`]);
    const out = await g(["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%ct", "refs/heads/base"]);
    const [sha = "", subject = "", author = "", ct = "0"] = out.split("\x1f");
    return { sha, subject: subject.slice(0, 200), author: author.slice(0, 100), at: Number(ct) * 1000 };
  } catch (e: any) {
    throw new Error(scrub(String(e.stderr || e.message || "dépôt injoignable"), [p.token]).split("\n").filter(Boolean).slice(-1)[0]!.slice(0, 200));
  }
}

export type LatestDeploy = { environment: string; status: string; ref: string | null; sha: string | null; at: number; url: string | null };

/** Dernier déploiement connu de la forge (GitLab : Deployments ; GitHub : Deployments + statut). Facultatif : rien si la forge n'en remonte pas. */
export async function latestDeployment(p: Project): Promise<LatestDeploy | null> {
  if (p.forge === "none" || !p.token) return null;
  const u = new URL(p.repo);
  const path = u.pathname.replace(/^\/|\.git$/g, "");
  const get = async (url: string, headers: Record<string, string>) => {
    const r = await fetch(url, { headers: { "user-agent": "atelier", ...headers }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${p.forge === "github" ? "GitHub" : "GitLab"} ${r.status}`);
    return r.json() as Promise<any>;
  };
  if (p.forge === "github") {
    const api = u.hostname === "github.com" ? "https://api.github.com" : `${u.origin}/api/v3`;
    const h = { authorization: `Bearer ${p.token}`, accept: "application/vnd.github+json" };
    const [d] = await get(`${api}/repos/${path}/deployments?per_page=1`, h);
    if (!d) return null;
    const [st] = await get(`${api}/repos/${path}/deployments/${d.id}/statuses?per_page=1`, h);
    return { environment: String(d.environment ?? ""), status: String(st?.state ?? "pending"), ref: d.ref ?? null, sha: d.sha ?? null, at: Date.parse(st?.created_at ?? d.created_at), url: st?.environment_url ?? st?.target_url ?? null };
  }
  const [d] = await get(`${u.origin}/api/v4/projects/${encodeURIComponent(path)}/deployments?per_page=1&order_by=created_at&sort=desc`, { "PRIVATE-TOKEN": p.token });
  if (!d) return null;
  return { environment: String(d.environment?.name ?? ""), status: String(d.status ?? ""), ref: d.ref ?? null, sha: d.sha ?? null, at: Date.parse(d.finished_at ?? d.created_at), url: d.environment?.external_url ?? null };
}
