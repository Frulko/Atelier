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

export async function clone(p: Project, taskId: string, branch: string): Promise<Workspace> {
  const ws = workspace(taskId);
  await mkdir(ws.root, { recursive: true });
  await run("git", ["clone", "--quiet", "--separate-git-dir", ws.gitdir, "--branch", p.branch, p.repo, ws.tree], { env: gitEnv(p.token, p.forge) });
  await rm(join(ws.tree, ".git"), { force: true }); // l'agent ne voit pas le git
  await git(ws, ["checkout", "--quiet", "-b", branch]);
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
