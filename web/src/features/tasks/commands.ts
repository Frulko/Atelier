import type { TaskEvent } from "../../lib/types";

export type CommandState = "running" | "completed" | "failed" | "interrupted" | "background" | "recorded" | "unknown";
export type CommandEntry = { id: string; command: string; output: string; state: CommandState; source: string; turn: number; ts: number };
export const COMMAND_STATE: Record<CommandState, string> = {
  running: "En cours", completed: "Terminée", failed: "Échec", interrupted: "Interrompue", background: "En arrière-plan", recorded: "Historique sans résultat", unknown: "Résultat non reçu",
};

export function commandsOf(events: TaskEvent[], running: boolean): CommandEntry[] {
  const commands = new Map<string, CommandEntry>();
  const legacy: CommandEntry[] = [];
  for (const event of events) {
    const turn = event.turn ?? 1;
    if (event.type === "tool" && event.text.startsWith("Bash ")) {
      legacy.push({ id: `legacy-${event.id}`, command: event.text.slice(5), output: "", state: "recorded", source: "Agent", turn, ts: event.ts });
      continue;
    }
    if (event.type !== "command_start" && event.type !== "command_result") continue;
    try {
      const data = JSON.parse(event.text);
      if (!data || typeof data.id !== "string") continue;
      const id = `${turn}:${data.id}`;
      if (event.type === "command_start" && typeof data.command === "string" && !commands.has(id)) {
        commands.set(id, { id, command: data.command, output: "", state: "running", source: typeof data.source === "string" ? data.source : "Agent", turn, ts: event.ts });
      } else if (event.type === "command_result") {
        const command = commands.get(id);
        if (command && ["completed", "failed", "interrupted", "background"].includes(data.state)) {
          command.state = data.state;
          command.output = typeof data.output === "string" ? data.output : "";
        }
      }
    } catch { /* Un ancien événement mal formé ne doit pas casser le journal. */ }
  }
  const known = new Set([...commands.values()].map(c => `${c.turn}:${c.command}`));
  return [...commands.values(), ...legacy.filter(c => !known.has(`${c.turn}:${c.command}`))]
    .sort((a, b) => a.ts - b.ts)
    .map(c => !running && (c.state === "running" || c.state === "background") ? { ...c, state: "unknown" } : c);
}
