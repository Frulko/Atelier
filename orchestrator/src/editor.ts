import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { cfg } from "./config.ts";
import {
  allEditorSessionIds, countEditorSessions, deleteEditorSession, findEditorSession, getProjectById, getTaskInOrg, idleEditorSessions,
  insertEditorSession, touchEditorSession, type EditorSession, type ProjectRow,
} from "./db.ts";
import { clone, cleanup, workspace } from "./git.ts";
import { rowToProject } from "./projects.ts";

// Limites : l'éditeur écrit sur le disque du serveur à la demande d'un navigateur, donc tout est borné.
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_WORKSPACE_BYTES = 50_000_000;
export const MAX_ENTRIES = 5_000;
export const MAX_SESSIONS_PER_ORG = 3;
export const IDLE_MS = 2 * 3600_000;
const MAX_FILES_IN_WORKSPACE = 20_000;

export class EditorError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Un chemin envoyé par le navigateur, relatif à la racine du projet. Refusé : absolu, `..`, `.`, segments vides, antislash,
 * octet nul, et tout segment `.git` (le dépôt n'est jamais atteignable, même s'il n'est pas dans l'arbre). Rend le chemin normalisé.
 */
export function safeRel(p: unknown, { allowRoot = false } = {}): string {
  if (typeof p !== "string" || p.length > 500 || /[\0\\]/.test(p)) throw new EditorError(400, "chemin invalide");
  if (p === "" || p === "/") { if (allowRoot) return ""; throw new EditorError(400, "chemin invalide"); }
  if (p.startsWith("/")) throw new EditorError(400, "chemin invalide");
  const parts = p.replace(/\/$/, "").split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git" || [...s].some((c) => c < " "))) throw new EditorError(400, "chemin invalide");
  return parts.join("/");
}

const sessionDir = (id: string) => `edit-${id}`;
const treeOf = (id: string) => workspace(sessionDir(id)).tree;

/** Chemin absolu dans l'arbre, SANS suivre aucun lien symbolique : le dossier parent doit se résoudre à l'intérieur de l'arbre, et la cible n'est jamais un lien. */
async function resolveIn(id: string, rel: string, { mustExist = true, allowLink = false } = {}): Promise<string> {
  const tree = await realpath(treeOf(id)).catch(() => { throw new EditorError(410, "cette session n'existe plus"); });
  const abs = join(tree, rel);
  if (rel === "") return abs;
  const parent = await realpath(dirname(abs)).catch(() => { throw new EditorError(404, "dossier introuvable"); });
  if (parent !== tree && !parent.startsWith(tree + sep)) throw new EditorError(400, "chemin invalide");
  const st = await lstat(abs).catch(() => null);
  if (!st && mustExist) throw new EditorError(404, "introuvable");
  if (st?.isSymbolicLink() && !allowLink) throw new EditorError(415, "lien symbolique : non modifiable ici");
  return abs;
}

/** Ouvre la session de cette personne sur ce projet (ou la reprend) : clone la branche dans un espace privé. */
export async function openSession(o: { orgId: string; userId: string; project: ProjectRow; taskId?: string | null }): Promise<EditorSession> {
  const taskId = o.taskId ?? null;
  const existing = findEditorSession(o.orgId, o.userId, o.project.id, taskId);
  if (existing) { touchEditorSession(existing.id); return existing; }
  if (countEditorSessions(o.orgId) >= MAX_SESSIONS_PER_ORG) throw new EditorError(409, `${MAX_SESSIONS_PER_ORG} éditions ouvertes en même temps dans l'organisation : ferme-en une`);
  let branch: string, existingBranch = false;
  const id = (await import("node:crypto")).randomBytes(8).toString("hex");
  if (taskId) {
    const t = getTaskInOrg(taskId, o.orgId);
    if (!t || t.project !== o.project.id) throw new EditorError(404, "tâche introuvable");
    if (t.status === "queued" || t.status === "running") throw new EditorError(409, "l'agent travaille encore sur cette tâche");
    if (!t.branch || (t.status !== "done")) throw new EditorError(409, "cette tâche n'a pas de branche à modifier");
    branch = t.branch; existingBranch = true;
  } else branch = `atelier/edit-${id}`;
  const p = rowToProject(o.project);
  try { await clone(p, sessionDir(id), branch, existingBranch); } catch (e) {
    await cleanup(sessionDir(id));
    throw new EditorError(502, existingBranch ? "la branche de cette tâche n'existe plus sur le dépôt" : "le dépôt n'a pas pu être copié (jeton, adresse ou branche ?)");
  }
  insertEditorSession({ id, org_id: o.orgId, user_id: o.userId, project_id: o.project.id, task_id: taskId, branch, base_branch: o.project.branch });
  return findEditorSession(o.orgId, o.userId, o.project.id, taskId)!;
}

export type Entry = { name: string; path: string; type: "file" | "dir" | "link"; size: number };

/** Le contenu d'UN dossier (l'arbre se déplie à la demande). `.git` n'existe pas ici. */
export async function listDir(s: EditorSession, rel: string): Promise<{ entries: Entry[]; truncated: boolean }> {
  touchEditorSession(s.id);
  const dir = await resolveIn(s.id, rel);
  const st = await lstat(dir);
  if (!st.isDirectory()) throw new EditorError(400, "ce n'est pas un dossier");
  const names = (await readdir(dir)).filter((n) => n !== ".git").sort((a, b) => a.localeCompare(b));
  const entries: Entry[] = [];
  for (const name of names.slice(0, MAX_ENTRIES)) {
    const s2 = await lstat(join(dir, name));
    entries.push({ name, path: rel ? `${rel}/${name}` : name, type: s2.isSymbolicLink() ? "link" : s2.isDirectory() ? "dir" : "file", size: s2.isFile() ? s2.size : 0 });
  }
  entries.sort((a, b) => (a.type === "dir" ? 0 : 1) - (b.type === "dir" ? 0 : 1) || a.name.localeCompare(b.name));
  return { entries, truncated: names.length > MAX_ENTRIES };
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

export async function readText(s: EditorSession, rel: string): Promise<{ path: string; content: string; size: number }> {
  touchEditorSession(s.id);
  const abs = await resolveIn(s.id, rel);
  const st = await lstat(abs);
  if (!st.isFile()) throw new EditorError(400, "ce n'est pas un fichier");
  if (st.size > MAX_FILE_BYTES) throw new EditorError(413, `fichier trop gros pour l'éditeur (plus de ${MAX_FILE_BYTES / 1e6} Mo)`);
  const buf = await readFile(abs);
  if (isBinary(buf)) throw new EditorError(415, "fichier binaire : non modifiable ici");
  return { path: rel, content: buf.toString("utf8"), size: st.size };
}

/** Taille de l'espace de travail (hors liens), avec arrêt dès que la limite est dépassée. */
async function workspaceBytes(id: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0, files = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else { files++; bytes += (await lstat(p)).size; if (bytes > MAX_WORKSPACE_BYTES * 2 || files > MAX_FILES_IN_WORKSPACE * 2) return; }
    }
  };
  await walk(treeOf(id));
  return { bytes, files };
}
async function assertRoom(id: string, extra: number, newFile: boolean) {
  const w = await workspaceBytes(id); // ponytail: parcours complet à chaque écriture ; un compteur mis en cache si les dépôts deviennent très gros
  if (w.bytes + extra > MAX_WORKSPACE_BYTES) throw new EditorError(413, `l'espace de travail dépasse ${MAX_WORKSPACE_BYTES / 1e6} Mo`);
  if (newFile && w.files + 1 > MAX_FILES_IN_WORKSPACE) throw new EditorError(413, "trop de fichiers dans l'espace de travail");
}

/** Brouillon : écrit dans l'espace de travail, rien ne quitte le serveur avant « Valider ». */
export async function writeText(s: EditorSession, rel: string, content: unknown): Promise<{ path: string; size: number }> {
  touchEditorSession(s.id);
  if (typeof content !== "string") throw new EditorError(400, "contenu invalide");
  const buf = Buffer.from(content, "utf8");
  if (buf.length > MAX_FILE_BYTES) throw new EditorError(413, `fichier trop gros (plus de ${MAX_FILE_BYTES / 1e6} Mo)`);
  if (buf.includes(0)) throw new EditorError(400, "contenu invalide");
  const abs = await resolveIn(s.id, rel, { mustExist: false });
  const st = await lstat(abs).catch(() => null);
  if (st && !st.isFile()) throw new EditorError(400, "ce n'est pas un fichier");
  if (st && isBinary(await readFile(abs))) throw new EditorError(415, "fichier binaire : non modifiable ici");
  await assertRoom(s.id, buf.length - (st?.size ?? 0), !st);
  await writeFile(abs, buf, { mode: 0o644 });
  return { path: rel, size: buf.length };
}

export async function fileOp(s: EditorSession, op: unknown, a: { path?: unknown; type?: unknown; from?: unknown; to?: unknown }): Promise<{ ok: true }> {
  touchEditorSession(s.id);
  if (op === "create") {
    const rel = safeRel(a.path);
    const abs = await resolveIn(s.id, rel, { mustExist: false });
    if (await lstat(abs).catch(() => null)) throw new EditorError(409, "existe déjà");
    if (a.type === "dir") await mkdir(abs); else if (a.type === "file") { await assertRoom(s.id, 0, true); await writeFile(abs, "", { flag: "wx", mode: 0o644 }); } else throw new EditorError(400, "type invalide (file ou dir)");
    return { ok: true };
  }
  if (op === "delete") {
    const rel = safeRel(a.path);
    const abs = await resolveIn(s.id, rel, { allowLink: true });
    await rm(abs, { recursive: true, force: false });
    return { ok: true };
  }
  if (op === "rename") {
    const from = safeRel(a.from), to = safeRel(a.to);
    if (to === from || to.startsWith(from + "/")) throw new EditorError(400, "déplacement impossible");
    const src = await resolveIn(s.id, from, { allowLink: true });
    const dst = await resolveIn(s.id, to, { mustExist: false });
    if (await lstat(dst).catch(() => null)) throw new EditorError(409, "la destination existe déjà");
    await rename(src, dst);
    return { ok: true };
  }
  throw new EditorError(400, "opération invalide (create, rename, delete)");
}

export async function discardSession(s: EditorSession) {
  deleteEditorSession(s.id);
  await cleanup(sessionDir(s.id));
}

/** Supprime les sessions inactives et les dossiers orphelins (session supprimée, projet supprimé, redémarrage). */
export async function sweepEditor(now = Date.now()) {
  for (const s of idleEditorSessions(now - IDLE_MS)) await discardSession(s).catch(() => {});
  const known = new Set(allEditorSessionIds().map(sessionDir));
  for (const d of await readdir(cfg.workDir).catch(() => [] as string[])) if (d.startsWith("edit-") && !known.has(d)) await rm(join(cfg.workDir, d), { recursive: true, force: true }).catch(() => {});
}

export const projectOf = (s: EditorSession) => getProjectById(s.project_id);
