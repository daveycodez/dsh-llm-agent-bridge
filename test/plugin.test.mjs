import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PluginHost } from "../../../packages/plugin-sdk/index.mjs";
import { createClaudeExecutionPlugin } from "../plugin.mjs";

test("Claude plugin exposes operation capabilities and closes its backend", async () => {
  const client = new FakeClaudeClient();
  const host = new PluginHost();
  await host.activate([createClaudeExecutionPlugin({ client, cwd: "/workspace" })]);
  const execution = host.capabilities.require("relay.execution.claude.v1", "^1.0.0");

  await execution.whenReady();
  assert.deepEqual(execution.listModels().map((model) => model.id), ["claude-test"]);
  assert.equal("runtime" in execution, false);
  assert.equal("client" in execution, false);
  const requests = [];
  const stop = execution.subscribeRequest((request) => requests.push(request.id));
  client.emit("request", { id: "request-1", method: "test", params: {} });
  assert.deepEqual(requests, ["request-1"]);
  stop();
  client.emit("request", { id: "request-2", method: "test", params: {} });
  assert.deepEqual(requests, ["request-1"]);

  await host.dispose();
  assert.equal(client.closed, true);
});

class FakeClaudeClient extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  async start() {}
  async listModels() { return [{ id: "claude-test", isDefault: true }]; }
  async close() { this.closed = true; }
}
