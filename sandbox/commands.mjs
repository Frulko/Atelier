export function commandHooks(emit) {
  const hook = (event) => [{ matcher: "^Bash$", hooks: [async (input) => {
    if (input.tool_name !== "Bash" || typeof input.tool_use_id !== "string") return {};
    if (event === "start") {
      if (typeof input.tool_input?.command === "string") emit({
        type: "command_start", commandId: input.tool_use_id, command: input.tool_input.command,
        source: input.agent_id ? "Sous-agent" : "Agent",
      });
      if (/(?:^|[;&|]\s*)npm\s+(?:install|i|ci)\b/.test(input.tool_input?.command ?? "")) {
        emit({ type: "command_result", commandId: input.tool_use_id, state: "failed", output: "Installation directe refusée : utilise mcp__atelier__install_dependencies pour accéder au registre npm autorisé." });
        return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Utilise mcp__atelier__install_dependencies après modification du package.json ; npm install direct n'a pas accès au réseau." },
        };
      }
    } else {
      const result = input.tool_response;
      const output = event === "failure" ? input.error : result?.isImage ? "[Sortie image]"
        : typeof result === "string" ? result : [result?.stdout, result?.stderr].filter(v => typeof v === "string").join("\n");
      emit({ type: "command_result", commandId: input.tool_use_id,
        state: input.is_interrupt || result?.interrupted ? "interrupted" : event === "failure" ? "failed" : result?.backgroundTaskId ? "background" : "completed",
        output: typeof output === "string" ? output : "",
      });
    }
    return {};
  }] }];
  return { PreToolUse: hook("start"), PostToolUse: hook("end"), PostToolUseFailure: hook("failure") };
}
