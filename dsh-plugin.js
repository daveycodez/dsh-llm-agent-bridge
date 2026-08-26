import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { definePlugin } from "./internal/plugin-sdk.mjs";
import { ClaudeDshAdapter, CLAUDE_PROVIDER } from "./claude-adapter.js";
import { ClaudeLinkStore } from "./claude-link-store.js";
import { handleClaudeSdkRequest } from "./claude-tools.js";

export function createDshClaudePlugin(ctx, config = {}) {
  return definePlugin({
    manifest: {
      id: "dsh.llm.agent-bridge", version: "1.0.0", provides: { "agent-bridge.dsh.v1": "1.0.0" },
      requires: { "agent-bridge.execution.v1": "^1.0.0" }, permissions: ["dsh:llm", "dsh:agents"],
    },
    async activate({ capabilities, defer }) {
      const runtime = capabilities.require("agent-bridge.execution.v1");
      const adapter = new ClaudeDshAdapter({
        runtime, ready: runtime.whenReady(),
        linkStore: new ClaudeLinkStore(resolveLinkPath(config.linkPath)), logger: ctx.logger,
      });
      defer(ctx.llm.registerAdapter([CLAUDE_PROVIDER], adapter));
      defer(runtime.subscribeRequest(request => {
        void handleClaudeSdkRequest(ctx, { adapter, runtime, request })
          .catch(error => ctx.logger.error(`Relay failed to handle a Claude interaction: ${error?.stack ?? error}`));
      }));
      defer(ctx.on("agent/created", ({ agent }) => { adapter.attachAgent(agent); }));
      defer(ctx.on("agent/disposed", ({ agent }) => { adapter.detachAgent(agent.id); }));
      for (const agent of ctx.agents.list()) adapter.attachAgent(agent);
      return { capabilities: { "agent-bridge.dsh.v1": Object.freeze({ provider: CLAUDE_PROVIDER }) } };
    },
  });
}

function resolveLinkPath(value) {
  const configured = value ?? process.env.DSH_AGENT_BRIDGE_LINK_PATH ?? process.env.DSH_CLAUDE_SDK_LINK_PATH;
  if (configured) return resolve(configured);
  const home = resolve(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"));
  const path = join(home, "plugin-data", "agent-bridge-links.json");
  // Adopt the pre-rename file so sessions keep their Claude session links.
  const previous = join(home, "plugin-data", "claude-agent-sdk-links.json");
  if (!existsSync(path) && existsSync(previous)) {
    try {
      renameSync(previous, path);
    } catch {
      return previous;
    }
  }
  return path;
}
