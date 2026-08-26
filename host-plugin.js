import { PluginHost } from "./internal/plugin-sdk.mjs";
import { createClaudeExecutionPlugin } from "./plugin.mjs";
import { createDshClaudePlugin } from "./dsh-plugin.js";

export const name = "dsh-llm-agent-bridge";
// `approval` and `userQuestions` back the permission and question bridges in
// claude-tools.js. Cordis throws "cannot get property 'x' without inject" at
// the point of use, so an undeclared service fails mid-turn, not at load.
export const inject = [
  "agents", "approval", "llm", "sessions", "sessionPersistence",
  "tools", "typert", "userQuestions", "webServer",
];

export async function apply(ctx, config = {}) {
  const host = new PluginHost();
  const release = ctx.effect(() => () => host.dispose(), "agent-bridge()");
  try {
    await host.activate([
      createClaudeExecutionPlugin({
        client: config.claude?.client, backend: config.claudeBackend, command: config.claudeCommand,
        args: config.claudeArgs, codeExecutablePath: config.claudeCodeExecutablePath,
        requestTimeoutMs: config.claudeRequestTimeoutMs, cwd: config.cwd,
      }),
      createDshClaudePlugin(ctx, config),
    ]);
  } catch (error) { await release(); throw error; }
}
