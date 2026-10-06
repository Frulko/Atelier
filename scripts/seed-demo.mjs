// Remplit une démo avec de la matière réaliste : des membres, 45 jours d'historique de tâches, des appels de modèles,
// un journal d'audit. S'exécute DANS le conteneur de l'orchestrateur (il réutilise ses modules) :
//   docker exec -i atelier-orchestrator node - < scripts/seed-demo.mjs
// Idempotent : ne fait rien si l'organisation a déjà de l'historique (SEED_RESET=1 pour repartir de zéro). Données factices : jamais en production.
const db = await import("/app/src/db.ts");
const { hashPassword } = await import("/app/src/auth.ts");
const { audit } = await import("/app/src/audit.ts");

const org = db.firstOrgId();
if (!org) { console.log("Pas d'organisation : rien à amorcer."); process.exit(0); }
// Adresses de site et historique de santé, pour que le tableau de bord montre un site en ligne, un site en panne et un projet non surveillé.
// Les « sites » sont l'orchestrateur lui-même (en ligne) et un port fermé (en panne) : la démo n'a besoin d'aucun site réel.
{
  const demoSites = { "boulangerie": "http://127.0.0.1:8080/healthz", "todo-api": "http://127.0.0.1:9/health" };
  for (const p of db.listProjects(org)) {
    const url = demoSites[p.slug];
    if (!url || p.site_url) continue;
    db.updateProject(p.id, org, { site_url: url });
    const down = p.slug === "todo-api";
    for (let i = 60; i >= 1; i--) {
      const bad = down ? i < 50 || i % 4 === 0 : i % 23 === 0; // en panne depuis ~50 min
      db.saveHealth(p.id, bad ? { ok: false, status: down ? null : 503, ms: down ? 3 : 120, error: down ? "connexion refusée" : "réponse HTTP 503" } : { ok: true, status: 200, ms: 20 + (i * 7) % 60, error: null }, Date.now() - i * 60_000);
    }
  }
}

if (process.env.SEED_RESET === "1") {
  // Repartir de zéro (démo seulement) : efface l'historique de l'organisation, garde les comptes.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(process.env.DB_FILE || "/data/atelier.db");
  raw.prepare("delete from events where task_id in (select id from tasks where org_id = ?)").run(org);
  for (const t of ["tasks", "proxy_calls", "audit_log"]) raw.prepare(`delete from ${t} where org_id = ?`).run(org);
  raw.close();
} else if (db.queryTasks(org).total >= 12) { console.log("Historique déjà présent : rien à faire."); process.exit(0); }

const DAY = 86_400_000, now = Date.now();
let seed = 20261005;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// équipe
const hash = await hashPassword("demo-equipe-123");
const people = [["marie.curie@demo.test", "admin"], ["paul.valery@demo.test", "member"], ["lea.durand@demo.test", "member"], ["sam.okafor@demo.test", "viewer"]];
const owner = db.getUserByEmail("admin@localhost");
const users = [owner];
for (const [email, role] of people) {
  const u = db.getUserByEmail(email) ?? db.createUser(email, hash);
  if (!db.roleOf(org, u.id)) db.addMember(org, u.id, role);
  users.push(u);
}
const doers = users.filter((u) => db.roleOf(org, u.id) !== "viewer");
const projects = db.listProjects(org);
if (!projects.length) { console.log("Aucun projet : rien à amorcer."); process.exit(0); }

const prompts = [
  "Ajoute un tarif dégressif sur l'onglet Voyage", "Corrige l'arrondi de la TVA dans le devis", "Renomme le bouton « Envoyer » en « Valider »",
  "Ajoute une colonne « Fournisseur » au tableau", "Change la couleur d'accent du site", "Ajoute une page Contact avec un formulaire",
  "Fais apparaître le total en gras", "Ajoute un export CSV de la liste", "Corrige la faute dans le titre de l'accueil", "Ajoute un filtre par date",
  "Passe le tableau en tri alphabétique", "Affiche un message quand la liste est vide", "Ajoute la mention légale en pied de page", "Réduis l'espacement des lignes",
];
const statusAt = () => { const r = rnd(); return r < 0.74 ? "done" : r < 0.86 ? "failed" : r < 0.93 ? "no_changes" : "cancelled"; };

let n = 0;
for (let age = 44; age >= 0; age--) {
  const weekday = new Date(now - age * DAY).getUTCDay();
  const count = weekday === 0 || weekday === 6 ? Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 5) + (age < 10 ? 1 : 0);
  for (let k = 0; k < count; k++) {
    const id = `d${(++n).toString(16).padStart(7, "0")}`, user = pick(doers), project = pick(projects), status = statusAt();
    const created = now - age * DAY + Math.floor(rnd() * 10 * 3_600_000) + 8 * 3_600_000 - 12 * 3_600_000;
    const secs = 40 + Math.floor(rnd() * 360), cost = status === "cancelled" || status === "no_changes" ? Math.round(rnd() * 20) / 100 : Math.round((0.12 + rnd() * 2.2) * 100) / 100;
    db.createTask(id, org, user.id, project.id, pick(prompts));
    db.updateTaskCreatedAtForTest(id, Math.min(created, now - 60_000));
    const files = status === "done" ? [pick(["app.js", "style.css", "index.html", "cantine.js", "server.js"]), ...(rnd() < 0.4 ? ["NOTES.md"] : [])] : [];
    db.updateTask(id, { status, cost, started_at: Math.min(created, now - 60_000) + 2000, finished_at: Math.min(created, now - 60_000) + 2000 + secs * 1000, branch: status === "done" ? `atelier/${id}` : null, files_json: files.length ? JSON.stringify(files) : null, flagged: files.includes("cantine.js") ? 1 : 0 });
    for (const [t, text] of [["step", "Demande reçue, en file d'attente."], ["step", "Copie du projet dans le bac à sable…"], ["step", "L'agent travaille…"], ["text", "J'ai préparé la modification demandée."], ["step", "Vérification du projet…"], [status === "failed" ? "error" : "done", status === "failed" ? "La vérification échoue encore après les corrections." : status === "done" ? `Branche atelier/${id} envoyée.` : "Terminé."]])
      db.addEvent(id, t, text);
    const at = Math.min(created, now - 60_000);
    for (let c = 0; c < 2 + Math.floor(rnd() * 5); c++) db.recordProxyCall(org, id, rnd() < 0.9 ? "anthropic" : "openai", rnd() < 0.04 ? 529 : 200, at + 3000 + c * 20_000);
    audit({ orgId: org, userId: user.id, ip: "10.0.0." + (2 + Math.floor(rnd() * 20)), ts: at }, "task.create", { type: "task", id }, { project: project.name });
    if (status === "cancelled") audit({ orgId: org, userId: user.id, ip: "10.0.0.5", ts: at + 30_000 }, "task.cancel", { type: "task", id });
  }
}
db.setOrgBudget(org, 150);

// quelques événements d'administration, datés de façon plausible (un tous les trois jours environ)
const admin = users[1];
[
  ["member.role", { type: "user", id: users[2].id }, { email: users[2].email, from: "viewer", to: "member" }, owner.id],
  ["invitation.create", { type: "invitation", id: "x1" }, { email: "nouveau@demo.test", role: "member" }, admin.id],
  ["project.update", { type: "project", id: projects[0].id }, { fields: ["check", "protectedPaths"] }, admin.id],
  ["org.budget_set", { type: "org", id: org }, { budgetUsdMonth: 150 }, owner.id],
].forEach(([action, target, meta, userId], i) =>
  audit({ orgId: org, userId, ip: "10.0.0.5", ts: now - (i + 1) * 3 * DAY - 2 * 3_600_000 }, action, target, meta));

console.log(`Démo amorcée : ${n} tâches sur 45 jours, ${users.length} membres, budget 150 $.`);
