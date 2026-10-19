import test from "node:test";
import assert from "node:assert/strict";
import { commandHooks } from "../sandbox/commands.mjs";

test("Bash hooks emit launch before completion and keep parallel tool IDs", async () => {
  const events = [], hooks = commandHooks(e => events.push(e));
  const call = (name, input) => hooks[name][0].hooks[0]({ tool_name: "Bash", ...input });
  await call("PreToolUse", { tool_use_id: "a", tool_input: { command: "npm test" } });
  await call("PreToolUse", { tool_use_id: "b", tool_input: { command: "npm run build" }, agent_id: "subagent" });
  assert.deepEqual(events.map(e => e.type), ["command_start", "command_start"]);
  assert.equal(events[1].source, "Sous-agent");
  await call("PostToolUseFailure", { tool_use_id: "b", error: "build failed" });
  await call("PostToolUse", { tool_use_id: "a", tool_response: { stdout: "pass", stderr: "", interrupted: false } });
  assert.equal(events[2].commandId, "b"); assert.equal(events[2].state, "failed");
  assert.equal(events[3].commandId, "a"); assert.equal(events[3].output, "pass\n");
});

test("Bash hooks distinguish background and interruption without exposing image data", async () => {
  const events = [], hooks = commandHooks(e => events.push(e));
  const call = (result) => hooks.PostToolUse[0].hooks[0]({ tool_name: "Bash", tool_use_id: "a", tool_response: result });
  await call({ backgroundTaskId: "bg", stdout: "started" });
  await call({ interrupted: true });
  await call({ isImage: true, stdout: "image-bytes" });
  assert.equal(events[0].state, "background"); assert.equal(events[1].state, "interrupted");
  assert.equal(events[2].output, "[Sortie image]");
});

test("direct npm installation closes the command and directs agents to the guarded installer", async () => {
  const events = [], hooks = commandHooks(e => events.push(e));
  const result = await hooks.PreToolUse[0].hooks[0]({ tool_name: "Bash", tool_use_id: "npm", tool_input: { command: "npm install" } });
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(events.map(e => e.type), ["command_start", "command_result"]);
  assert.equal(events[1].state, "failed");
  assert.match(events[1].output, /install_dependencies/);
});
