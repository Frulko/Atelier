import { expect, test } from "vitest";
import type { TaskEvent } from "../../lib/types";
import { commandsOf } from "./commands";

const event = (id: number, type: string, data: unknown, turn = 1): TaskEvent => ({ id, type, text: JSON.stringify(data), turn, task_id: "task", ts: id });

test("commandes parallèles : le résultat reste associé à la bonne commande et au bon tour", () => {
  const events = [
    event(1, "command_start", { id: "a", command: "npm test" }),
    event(2, "command_start", { id: "b", command: "npm run build" }),
    event(3, "command_result", { id: "b", state: "failed", output: "build failed" }),
    event(4, "command_result", { id: "a", state: "completed", output: "tests pass" }),
    event(5, "command_start", { id: "a", command: "npm test" }, 2),
  ];
  const commands = commandsOf(events, true);
  expect(commands.map(c => c.state)).toEqual(["completed", "failed", "running"]);
  expect(commands[0]?.output).toBe("tests pass");
  expect(commandsOf(events, false)[2]?.state).toBe("unknown");
});

test("les anciens événements Bash sont visibles sans doubler les commandes structurées", () => {
  const e = event(1, "tool", {}); e.text = "Bash npm test";
  expect(commandsOf([e], false)[0]?.state).toBe("recorded");
  expect(commandsOf([e, event(2, "command_start", { id: "a", command: "npm test" })], true)).toHaveLength(1);
});

test("un événement invalide ou un résultat isolé ne casse pas le panneau", () => {
  const broken = event(1, "command_start", {}); broken.text = "{broken";
  expect(commandsOf([broken, event(2, "command_result", { id: "absent", state: "completed" }), event(3, "command_start", null)], true)).toEqual([]);
  const begin = event(4, "command_start", { id: "a", command: "sleep 1" });
  expect(commandsOf([begin, event(5, "command_result", { id: "a", state: "background" })], true)[0]?.state).toBe("background");
});
