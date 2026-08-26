import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { PluginHost } from "../internal/plugin-sdk.mjs";
import { createClaudeExecutionPlugin } from "../plugin.mjs";

test("Claude plugin exposes operation capabilities and closes its backend", async () => {
  const client = new FakeClaudeClient();
  const host = new PluginHost();
  await host.activate([createClaudeExecutionPlugin({ client, cwd: "/workspace" })]);
  const execution = host.capabilities.require("agent-bridge.execution.v1", "^1.0.0");

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

test("every service the plugin dereferences at runtime is declared in inject", async () => {
  const { inject } = await import("../host-plugin.js");
  const sources = await Promise.all(["../claude-tools.js", "../dsh-plugin.js", "../claude-adapter.js"]
    .map(file => readFile(new URL(file, import.meta.url), "utf8")));

  const used = new Set();
  for (const source of sources) {
    for (const [, name] of source.matchAll(/\bctx\.([a-zA-Z][a-zA-Z0-9]*)\b/g)) used.add(name);
  }
  // cordis's own context API, not services: on/effect/inject/plugin, plus the
  // logger every context carries and llm, declared under its service name.
  for (const method of ["on", "effect", "inject", "plugin", "logger", "llm"]) used.delete(method);

  for (const name of used) {
    assert.ok(inject.includes(name), `ctx.${name} is used but not declared in inject; cordis throws only when the line runs`);
  }
});

test("the fallback client forwards every method the runtime calls on it", async () => {
  const { DELEGATED_CLIENT_METHODS } = await import("../plugin.mjs");
  const runtimeSource = await readFile(new URL("../session-runtime.mjs", import.meta.url), "utf8");

  const used = new Set();
  for (const [, name] of runtimeSource.matchAll(/this\.client\.([a-zA-Z][a-zA-Z0-9]*)/g)) used.add(name);
  // `start` is the wrapper's own decision point, and `on` comes from EventEmitter.
  used.delete("start");
  used.delete("on");

  for (const name of used) {
    assert.ok(
      DELEGATED_CLIENT_METHODS.includes(name),
      `the runtime calls client.${name}, but the fallback wrapper does not forward it — it would resolve against the inherited CLI stub instead of the active client`,
    );
  }
});

test("a parked call resolves through the fallback wrapper, not the stub it inherits", async () => {
  const { FallbackClaudeClient } = await import("../plugin.mjs");
  const { ClaudeSdkClient } = await import("../sdk-client.mjs");

  // The shape that broke live: backend "auto", so the runtime holds the wrapper
  // while the parked call lives on the SDK client behind it.
  const primary = new ClaudeSdkClient({ sdk: {} });
  const fallback = new (await import("../cli-client.mjs")).ClaudeCliClient();
  const client = new FallbackClaudeClient({ primary, fallback });
  client.active = primary;

  const parked = [];
  primary.on("activity", message => { if (message.method === "tool/parked") parked.push(message.params); });
  const pending = primary.parkToolCall("claude-1", "turn-1", "bash", { command: "pwd" });

  assert.equal(
    client.resolveToolCall(parked[0].parkId, { content: [{ type: "text", text: "ok" }] }),
    true,
    "the wrapper must reach the active client; the inherited CLI stub always returns false",
  );
  assert.deepEqual((await pending).content, [{ type: "text", text: "ok" }]);
});
