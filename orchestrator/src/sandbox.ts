import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { issueTaskToken, resolveTaskToken, revokeTaskTokens } from "./tokens.ts";
import { cfg } from "./config.ts";

const run = promisify(execFile);

export const HARDENING = [
  "--dns", "127.0.0.1", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--memory", "1g", "--cpus", "1", "--pids-limit", "512",
];

/** Lance l'agent dans un conteneur jetable ; chaque ligne JSON de stdout est remise à onEvent. */
export function runAgent(opts: {
  name: string; tree: string; prompt: string; engine: string;
  /** Connaissances de l'équipe (Markdown), données à l'agent comme contexte ; vide si aucune. */
  knowledge?: string;
  /** Réglages du projet : instructions de l'équipe, modèle, tours maximum, budget par exécution. */
  instructions?: string; model?: string; subagentModel?: string; maxTurns?: number; budgetUsd?: number;
  /** Jeton de tâche : tient lieu de clé d'API dans le bac à sable (voir tokens.ts). */
  token: string;
  onEvent: (e: { type: string; text?: string; name?: string; detail?: string; ok?: boolean; cost?: number }) => void;
}): Promise<{ ok: boolean; cost: number; reported:boolean; waiting?:string }> {
  const args = [
    "run", "--rm", "--name", opts.name, "--label", "atelier=1", "--label", `atelier-owner=${cfg.sandboxNetwork}`,
    "--network", cfg.sandboxNetwork, ...HARDENING,
    "-v", `${opts.tree}:/work`,
    "-e", "TASK_PROMPT",
    "-e", `ATELIER_HUMAN_URL=${cfg.proxyUrl}/human/questions`,
    "-e", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1",
    "-e", "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2",
    "-e", "TASK_KNOWLEDGE",
    "-e", "TASK_INSTRUCTIONS",
    ...(opts.model ? ["-e", `ATELIER_MODEL=${opts.model}`] : []),
    ...(opts.subagentModel ? ["-e", `CLAUDE_CODE_SUBAGENT_MODEL=${opts.subagentModel}`, "-e", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1"] : []),
    ...(opts.maxTurns ? ["-e", `MAX_TURNS=${opts.maxTurns}`] : []),
    "-e", `ATELIER_ENGINE=${opts.engine}`,
    // Un préfixe par fournisseur : le proxy choisit l'amont et injecte la vraie clé.
    "-e", `ANTHROPIC_BASE_URL=${cfg.proxyUrl}/anthropic`,
    "-e", "ANTHROPIC_API_KEY",
    "-e", `OPENAI_BASE_URL=${cfg.proxyUrl}/openai/v1`,
    "-e", "OPENAI_API_KEY",
    "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "-e", "DISABLE_TELEMETRY=1",
    "-e", `MAX_BUDGET_USD=${opts.budgetUsd ?? cfg.maxBudgetUsd}`,
    ...(cfg.fakeAgent ? ["-e", "ATELIER_FAKE_AGENT=1"] : []),
    cfg.sandboxImage,
  ];
  return new Promise((resolve) => {
    // Environnement MINIMAL du client docker : seules les variables relayées par « -e NOM » entrent dans le conteneur,
    // et ni les clés de l'orchestrateur ni ses autres secrets ne sont dans cet environnement.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TASK_PROMPT: opts.prompt, TASK_KNOWLEDGE: opts.knowledge ?? "", TASK_INSTRUCTIONS: opts.instructions ?? "", ANTHROPIC_API_KEY: opts.token, OPENAI_API_KEY: opts.token };
    for (const k of ["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"]) if (process.env[k]) env[k] = process.env[k];
    const p = spawn("docker", args, { env });
    const timer = setTimeout(() => { opts.onEvent({ type: "error", text: "Délai dépassé, agent arrêté." }); kill(opts.name); }, cfg.agentTimeoutS * 1000);
    let ok = false, cost = 0, reported=false, waiting:string|undefined, buf = "";
    const line = (l: string) => {
      try {
        const e = JSON.parse(l);
        if(e.type==="human_wait")waiting=e.questionId;
        if (e.type === "result") { reported=typeof e.cost === "number" && Number.isFinite(e.cost) && e.cost>=0; ok = !!e.ok; cost = typeof e.cost === "number" && Number.isFinite(e.cost) && e.cost >= 0 ? e.cost : 0; }
        opts.onEvent(e);
      } catch { if (l.trim()) opts.onEvent({ type: "log", text: l }); }
    };
    p.stdout.on("data", (d) => { buf += d; const ls = buf.split("\n"); buf = ls.pop()!; ls.forEach(line); });
    p.stderr.on("data", (d) => opts.onEvent({ type: "log", text: String(d).trim() }));
    p.on("error", () => { clearTimeout(timer); resolve({ ok: false, cost, reported, waiting }); });
    p.on("close", (code) => { ok = ok && code === 0; clearTimeout(timer); if (buf) line(buf); resolve({ ok, cost, reported, waiting }); });
  });
}

/** Vérification du projet : sans réseau, sans agent. Rend la sortie pour la renvoyer à l'agent si ça échoue. */
export async function runCheck(name: string, tree: string, command: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await run("docker", [
      "run", "--rm", "--name", name, "--label", "atelier=1", "--label", `atelier-owner=${cfg.sandboxNetwork}`, "--network", "none", ...HARDENING,
      "-v", `${tree}:/work`, "--entrypoint", "sh", cfg.sandboxImage, "-c", command,
    ], { timeout: 300_000, maxBuffer: 5e6 });
    return { ok: true, output: (stdout + stderr).slice(-3000) };
  } catch (e: any) {
    await kill(name);
    return { ok: false, output: String((e.stdout ?? "") + (e.stderr ?? "") || e.message).slice(-3000) };
  }
}

export const kill = (name: string) => run("docker", ["kill", name]).catch(() => {});

export async function installDependencies(name: string, tree: string, token: string): Promise<void> {
  const context=resolveTaskToken(token);
  if(!context)throw new Error("Jeton d'installation expiré.");
  const registryToken=issueTaskToken(name,context.orgId,"npm");
  try {
    await run("docker", ["run", "--rm", "--name", name, "--label", "atelier=1", "--label", `atelier-owner=${cfg.sandboxNetwork}`, "--network", cfg.sandboxNetwork, ...HARDENING,
      "-v", `${tree}:/work`, "-e", "ATELIER_NPM_TOKEN", "-e", `ATELIER_NPM_REGISTRY=${cfg.proxyUrl}/npm/`,
      "--entrypoint", "node", cfg.sandboxImage, "/opt/runner/install.mjs"],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, ATELIER_NPM_TOKEN: registryToken, ...Object.fromEntries(["DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT"].filter(k => process.env[k]).map(k => [k, process.env[k]])) }, timeout: 260_000, maxBuffer: 5e6 });
  } catch { await kill(name); throw new Error("Installation des dépendances impossible. Les paquets doivent venir du registre npm ; les scripts d'installation sont désactivés."); }
  finally { revokeTaskTokens(name); }
}

export async function stopOrphanContainers() {
  const { stdout } = await run("docker", ["ps", "-aq", "--filter", `label=atelier-owner=${cfg.sandboxNetwork}`]);
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length) await run("docker", ["rm", "-f", ...ids]);
}
