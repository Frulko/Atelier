import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryAddresses, forgeFetch } from "./security.ts";
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
    ["http.followRedirects", "false"],
    ["http.sslVerify", "true"],
    ["credential.helper", ""],
  ];
  if (token) {
    pairs.push(["http.extraHeader", `Authorization: Basic ${Buffer.from(`${forge === "github" ? "x-access-token" : "oauth2"}:${token}`).toString("base64")}`]);
  }
  const e: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => { e[`GIT_CONFIG_KEY_${i}`] = k; e[`GIT_CONFIG_VALUE_${i}`] = v; });
  return e;
}

async function repositoryEnv(p: Project): Promise<NodeJS.ProcessEnv> {
  const env=gitEnv(p.token,p.forge);
  if(p.repo.startsWith("/"))return env;
  const {url,addresses}=await repositoryAddresses(p.repo);
  const index=Number(env.GIT_CONFIG_COUNT);
  env[`GIT_CONFIG_KEY_${index}`]="http.curloptResolve";
  env[`GIT_CONFIG_VALUE_${index}`]=`${url.hostname}:${url.port||443}:${addresses.map(a=>a.family===6?`[${a.address}]`:a.address).join(",")}`;
  env.GIT_CONFIG_COUNT=String(index+1);
  return env;
}

const git = async (ws: Workspace, args: string[], token = "", forge: Project["forge"] = "gitlab", repo?: string) =>
  (await run("git", ["--git-dir", ws.gitdir, "--work-tree", ws.tree, ...args], { env: repo ? await repositoryEnv({repo,token,forge} as Project) : gitEnv(token, forge), timeout:120_000, maxBuffer: 20e6 })).stdout;

/** `existing` : un ajustement repart de la branche déjà envoyée de la tâche (la proposition ouverte se met alors à jour), pas de la branche de base. */
export async function clone(p: Project, taskId: string, branch: string, existing = false): Promise<Workspace> {
  const ws = workspace(taskId);
  await mkdir(ws.root, { recursive: true });
  await run("git", ["clone", "--quiet", "--separate-git-dir", ws.gitdir, "--branch", existing ? branch : p.branch, p.repo, ws.tree], { env: await repositoryEnv(p), timeout: 120_000, maxBuffer: 5e6 });
  await rm(join(ws.tree, ".git"), { force: true }); // l'agent ne voit pas le git
  if (!existing) await git(ws, ["checkout", "--quiet", "-b", branch]);
  await mkdir(join(ws.gitdir, "info"), { recursive: true });
  await appendFile(join(ws.gitdir, "info", "exclude"), "\nnode_modules/\n.atelier-context/\n");
  // uid 1000 = utilisateur "node" du bac à sable
  if (process.getuid?.() === 0) await run("chown", ["-R", "1000:1000", ws.tree]); // sans les droits root (tests, poste de dev) il n'y a rien à changer
  return ws;
}

/** Fichiers modifiés par l'agent (ajoute tout à l'index au passage). */
export async function changedFiles(ws: Workspace): Promise<string[]> {
  await rm(join(ws.tree, ".git"), { recursive: true, force: true }); // au cas où l'agent en aurait créé un
  await git(ws, ["add", "-A"]);
  const out = await git(ws, ["diff", "--cached", "--no-renames", "--name-only", "-z"]);
  return out ? out.split("\0").filter(Boolean) : [];
}

export async function commitAndPush(p: Project, ws: Workspace, branch: string, message: string) {
  await git(ws, ["-c", `user.name=${cfg.gitAuthorName}`, "-c", `user.email=${cfg.gitAuthorEmail}`, "commit", "--quiet", "-m", message]);
  await git(ws, ["push", "--quiet", "origin", branch], p.token, p.forge, p.repo);
}

/** Ouvre la MR (GitLab, y compris auto-hébergé) ou la PR (GitHub, y compris Enterprise). Rend son URL. */
export async function openMergeRequest(p: Project, branch: string, title: string, description: string): Promise<string | null> {
  if (p.forge === "none") return null;
  const u = new URL(p.repo);
  const path = u.pathname.replace(/^\/|\.git$/g, "");
  const token = p.token;

  if (p.forge === "github") {
    const api = u.hostname === "github.com" ? "https://api.github.com" : `${u.origin}/api/v3`;
    const r = await forgeFetch(`${api}/repos/${path}/pulls`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "atelier", "content-type": "application/json" },
      body: JSON.stringify({ title, head: branch, base: p.branch, body: description }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`GitHub ${r.status} : ouverture de proposition refusée.`);
    return ((await r.json()) as { html_url: string }).html_url;
  }

  const r = await forgeFetch(`${u.origin}/api/v4/projects/${encodeURIComponent(path)}/merge_requests`, {
    method: "POST",
    headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" },
    body: JSON.stringify({ source_branch: branch, target_branch: p.branch, title, description, remove_source_branch: true }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`GitLab ${r.status} : ouverture de proposition refusée.`);
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
    const { stdout } = await run("git", ["ls-remote", "--heads", "--", p.repo, `refs/heads/${p.branch}`], { env: await repositoryEnv(p), timeout: 20_000, maxBuffer: 1e6 });
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
async function fetchBase(p: Project, id: string): Promise<(args: string[]) => Promise<string>> {
  const dir = join(cfg.workDir, "_status", `${id}.git`);
  await mkdir(dir, { recursive: true });
  const env = await repositoryEnv(p);
  const g = (args: string[]) => run("git", ["--git-dir", dir, ...args], { env, timeout: 30_000, maxBuffer: 2e6 }).then((r) => r.stdout);
  await g(["rev-parse", "--git-dir"]).catch(() => g(["init", "--bare", "--quiet"]));
  await g(["fetch", "--quiet", "--depth", "1", "--no-tags", "--", p.repo, `+refs/heads/${p.branch}:refs/heads/base`]);
  return g;
}
const lastLine = (e: any, p: Project) => scrub(String(e.stderr || e.message || "dépôt injoignable"), [p.token]).split("\n").filter(Boolean).slice(-1)[0]!.slice(0, 200);

export async function latestCommit(p: Project, id: string): Promise<LatestCommit> {
  try {
    const g = await fetchBase(p, id);
    const out = (await g(["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%ct", "refs/heads/base"])).trim();
    const [sha = "", subject = "", author = "", ct = "0"] = out.split("\x1f");
    return { sha, subject: subject.slice(0, 200), author: author.slice(0, 100), at: Number(ct) * 1000 };
  } catch (e: any) { throw new Error(lastLine(e, p)); }
}

/** Les fichiers de configuration de l'IA (CLAUDE.md, AGENTS.md, règles, skills, sous-agents) de la branche de base, ou leur contenu. Rien d'autre n'est lisible par ici. */
export const AI_FILE = /^(CLAUDE\.md|AGENTS\.md|\.claude\/rules\/[^/]+\.md|\.claude\/skills\/[^/]+\/SKILL\.md|\.claude\/agents\/[^/]+\.md)$/;
export async function repoAiFiles(p: Project, id: string): Promise<{ path: string; size: number }[]> {
  try {
    const g = await fetchBase(p, id);
    const out = await g(["ls-tree", "-r", "-l", "-z", "refs/heads/base"]);
    return out.split("\0").filter(Boolean).map((l) => /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m && AI_FILE.test(m[2]!)).map((m) => ({ path: m[2]!, size: Number(m[1]) })).sort((a, b) => a.path.localeCompare(b.path));
  } catch (e: any) { throw new Error(lastLine(e, p)); }
}
export async function repoAiFile(p: Project, id: string, path: string): Promise<string | null> {
  if (!AI_FILE.test(path)) throw new Error("fichier non autorisé");
  try {
    const g = await fetchBase(p, id);
    const size = Number((await g(["cat-file", "-s", `refs/heads/base:${path}`]).catch(() => "-1")).trim());
    if (size < 0) return null;
    if (size > 100_000) throw new Error("fichier trop gros pour l'aperçu");
    return await g(["show", `refs/heads/base:${path}`]);
  } catch (e: any) { throw new Error(lastLine(e, p)); }
}

export type LatestDeploy = { environment: string; status: string; ref: string | null; sha: string | null; at: number; url: string | null };

/** Dernier déploiement connu de la forge (GitLab : Deployments ; GitHub : Deployments + statut). Facultatif : rien si la forge n'en remonte pas. */
export async function latestDeployment(p: Project): Promise<LatestDeploy | null> {
  if (p.forge === "none" || !p.token) return null;
  const u = new URL(p.repo);
  const path = u.pathname.replace(/^\/|\.git$/g, "");
  const get = async (url: string, headers: Record<string, string>) => {
    const r = await forgeFetch(url, { headers: { "user-agent": "atelier", ...headers }, signal: AbortSignal.timeout(10_000) });
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

export type Change = { path: string; status: "A" | "M" | "D" | "R"; from?: string };

/** Ce qui a changé depuis le dernier commit de l'espace de travail (ajoute tout à l'index au passage). */
export async function stagedChanges(ws: Workspace): Promise<Change[]> {
  await rm(join(ws.tree, ".git"), { recursive: true, force: true });
  await git(ws, ["add", "-A"]);
  const out = await git(ws, ["diff", "--cached", "--name-status", "-M", "-z"]);
  const parts = out.split("\0").filter(Boolean), changes: Change[] = [];
  for (let i = 0; i < parts.length;) {
    const s = parts[i++]!;
    if (s.startsWith("R") || s.startsWith("C")) { const from = parts[i++]!, to = parts[i++]!; changes.push({ path: to, status: "R", from }); }
    else changes.push({ path: parts[i++]!, status: (s[0] === "A" || s[0] === "D" ? s[0] : "M") as Change["status"] });
  }
  return changes;
}

/** Le diff unifié (d'un fichier, ou de tout), plafonné. Le chemin est littéral : jamais un motif git. */
export async function patchOf(ws: Workspace, path?: string, max = 300_000): Promise<{ diff: string; truncated: boolean }> {
  const out = await git(ws, ["diff", "--cached", "-M", "--no-color", "--no-ext-diff", "--", ...(path ? [`:(literal)${path}`] : [])]);
  return out.length > max ? { diff: out.slice(0, max), truncated: true } : { diff: out, truncated: false };
}

const clean = (s: string) => s.replace(/[<>\n\r\0]/g, "").trim().slice(0, 100) || "inconnu";

/** Commit au nom de la personne (auteur) ; la plateforme reste le « committer ». */
export async function commitAs(ws: Workspace, message: string, author: { name: string; email: string }) {
  await git(ws, ["-c", `user.name=${cfg.gitAuthorName}`, "-c", `user.email=${cfg.gitAuthorEmail}`, "commit", "--quiet", `--author=${clean(author.name)} <${clean(author.email)}>`, "-m", message]);
}

/** Envoie la branche. Un refus parce que la branche a avancé ailleurs est dit clairement (jamais de force). */
export async function pushBranch(p: Project, ws: Workspace, branch: string): Promise<void> {
  try { await git(ws, ["push", "--quiet", "origin", branch], p.token, p.forge, p.repo); }
  catch (e: any) {
    const text = scrub(String(e.stderr || e.message || ""), [p.token]);
    if (/non-fast-forward|fetch first|rejected|stale info/i.test(text)) throw Object.assign(new Error("la branche a changé sur le dépôt depuis l'ouverture de l'éditeur : abandonne cette édition et rouvre-la"), { code: "NOT_FAST_FORWARD" });
    throw new Error(text.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "envoi refusé");
  }
}

/**
 * Dépôts LOCAUX (démo et tests seulement) : sur Linux, le dossier monté appartient à un autre utilisateur que celui du conteneur et git
 * refuse alors de le lire (« dubious ownership »). Git n'honore safe.directory que dans la configuration globale ou système, pas dans
 * les variables d'environnement : on l'écrit dans la configuration globale du conteneur, et seulement quand les dépôts locaux sont permis.
 */
export function trustLocalRepos() {
  if (!cfg.allowLocalRepos) return;
  const has = (() => { try { return execFileSync("git", ["config", "--global", "--get-all", "safe.directory"], { encoding: "utf8" }).split("\n").includes("*"); } catch { return false; } })();
  if (!has) execFileSync("git", ["config", "--global", "--add", "safe.directory", "*"]);
}

export const revision = async (ws: Workspace) => (await git(ws, ["rev-parse", "HEAD"])).trim();

export async function createManagedRepo(id: string, files: Record<string, string>) {
  const { writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const repo = join(cfg.workDir, "_repos", `${id}.git`);
  const ws = workspace(`seed-${id}`);
  await mkdir(dirname(repo), { recursive: true });
  await mkdir(ws.tree, { recursive: true });
  try {
    await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", repo], { env: gitEnv("") });
    await run("git", ["init", "--quiet", "--initial-branch=main", "--separate-git-dir", ws.gitdir, ws.tree], { env: gitEnv("") });
    await rm(join(ws.tree, ".git"), { force: true });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(ws.tree, path)), { recursive: true });
      await writeFile(join(ws.tree, path), content);
    }
    await git(ws, ["add", "-A"]);
    await git(ws, ["-c", `user.name=${cfg.gitAuthorName}`, "-c", `user.email=${cfg.gitAuthorEmail}`, "commit", "--quiet", "-m", "Initial project"]);
    await git(ws, ["remote", "add", "origin", repo]);
    await git(ws, ["push", "--quiet", "origin", "main"]);
  } catch (e) { await rm(repo, { recursive: true, force: true }); throw e; }
  finally { await cleanup(`seed-${id}`); }
}

/** Complete an already pushed proposal without rerunning an agent. */
export async function retryProposal(p: Project, task: { branch: string | null; prompt: string; flagged: number; files_json: string | null; cost: number }) {
  if (!task.branch) throw new Error("Aucune branche à reprendre.");
  const title = `${task.flagged ? "[REVUE REQUISE] " : ""}atelier : ${task.prompt.split("\n")[0]!.slice(0, 70)}`;
  // The previous response may have been lost after creation. Find the existing PR before creating another.
  if (p.forge !== "none") {
    const u = new URL(p.repo), path = u.pathname.replace(/^\/|\.git$/g, "");
    const gh = p.forge === "github", api = gh ? u.hostname === "github.com" ? "https://api.github.com" : `${u.origin}/api/v3` : `${u.origin}/api/v4`;
    const endpoint = gh ? `${api}/repos/${path}/pulls?state=open&head=${encodeURIComponent(path.split("/")[0] + ":" + task.branch)}` : `${api}/projects/${encodeURIComponent(path)}/merge_requests?state=opened&source_branch=${encodeURIComponent(task.branch)}`;
    const headers: Record<string, string> = gh ? { authorization: `Bearer ${p.token}`, "user-agent": "atelier" } : { "PRIVATE-TOKEN": p.token };
    const response = await forgeFetch(endpoint, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("Impossible de retrouver la proposition sur la forge.");
    const rows = await response.json() as { html_url?: string; web_url?: string }[];
    if (rows[0]) return rows[0].html_url ?? rows[0].web_url ?? null;
  }
  return openMergeRequest(p, task.branch, title, `Demande : ${task.prompt}\n\nFichiers : ${JSON.parse(task.files_json ?? "[]").join(", ")}\n\nCoût déclaré : ${task.cost.toFixed(2)} $`);
}

/** Advance a managed project's base to exactly the checked commit; divergence is never overwritten. */
export async function promoteManaged(p: Project, sha: string, releaseId: string) {
  const job=`promote-${releaseId}`;
  try {
    const ws=await clone(p,job,`promote/${releaseId}`);
    await git(ws,["merge","--ff-only",sha]);
    await git(ws,["push","--quiet","origin",`HEAD:refs/heads/${p.branch}`],p.token,p.forge,p.repo);
  } finally {await cleanup(job);}
}

export const trackedPaths = async (ws: Workspace) => (await git(ws,["ls-files","-z"])).split("\0").filter(Boolean);

export async function assertBaseMatches(p: Project, sha: string, releaseId: string) {
  const job=`verify-${releaseId}`;
  try {
    const ws=await clone(p,job,`verify/${releaseId}`);
    const [base,artifact]=await Promise.all([git(ws,["rev-parse","HEAD^{tree}"]),git(ws,["rev-parse",`${sha}^{tree}`])]);
    if(base.trim()!==artifact.trim())throw new Error("La proposition doit être fusionnée et correspondre à la branche de base avant publication.");
  } finally {await cleanup(job);}
}
