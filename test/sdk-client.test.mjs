import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeSdkClient } from "../sdk-client.mjs";

test("Claude SDK client pauses on canUseTool and resumes after Relay approval", async () => {
  let queryParams = null;
  const sdk = {
    query(params) {
      queryParams = params;
      return queryObject(async function* () {
        yield { type: "assistant", session_id: params.options.sessionId, uuid: "u1", parent_tool_use_id: null, message: {
          id: "msg-1",
          role: "assistant",
          model: "sonnet",
          stop_reason: null,
          stop_sequence: null,
          usage: {},
          content: [{ type: "tool_use", id: "tool-1", name: "Write", input: { file_path: "probe.txt", content: "ok" } }],
        } };
        const allowed = await params.options.canUseTool("Write", { file_path: "probe.txt", content: "ok" }, {
          requestId: "permission-1",
          toolUseID: "tool-1",
          title: "Claude wants to write probe.txt",
          signal: new AbortController().signal,
        });
        yield { type: "user", session_id: params.options.sessionId, uuid: "u2", parent_tool_use_id: null, message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: JSON.stringify(allowed), is_error: false }],
        } };
        yield { type: "stream_event", session_id: params.options.sessionId, uuid: "u3", parent_tool_use_id: null, event: {
          type: "message_start",
          message: { id: "msg-2" },
        } };
        yield { type: "stream_event", session_id: params.options.sessionId, uuid: "u4", parent_tool_use_id: null, event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "checked workspace" },
        } };
        yield { type: "assistant", session_id: params.options.sessionId, uuid: "u5", parent_tool_use_id: null, message: {
          id: "msg-2",
          role: "assistant",
          model: "sonnet",
          stop_reason: null,
          stop_sequence: null,
          usage: {},
          content: [{ type: "thinking", thinking: "checked workspace" }],
        } };
        yield { type: "stream_event", session_id: params.options.sessionId, uuid: "u6", parent_tool_use_id: null, event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "done" },
        } };
        yield { type: "assistant", session_id: params.options.sessionId, uuid: "u7", parent_tool_use_id: null, message: {
          id: "msg-2",
          role: "assistant",
          model: "sonnet",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {},
          content: [{ type: "text", text: "done" }],
        } };
        yield { type: "result", session_id: params.options.sessionId, uuid: "u8", subtype: "success", is_error: false, result: "done" };
      });
    },
  };
  const client = new ClaudeSdkClient({ sdk });
  await client.start();
  const session = await client.createSession({ sessionId: "11111111-1111-4111-8111-111111111111", cwd: "/workspace/relay" });
  const requests = [];
  const activity = [];
  client.on("request", request => {
    requests.push(request);
    client.resolveRequest(request.id, { action: "accept", updatedInput: request.params.input });
  });
  client.on("activity", message => activity.push(message));
  await client.sendMessage(session.id, { text: "write a file", model: "sonnet", effort: "low" });
  await untilTurnCompleted(activity);

  assert.equal(queryParams.options.sessionId, session.id);
  assert.equal(queryParams.options.resume, undefined);
  assert.equal(queryParams.options.permissionMode, "default");
  assert.equal(requests[0].method, "tool/requestApproval");
  assert.equal(requests[0].params.toolName, "Write");
  assert.deepEqual(activity.map(message => message.method), [
    "item/started",
    "item/completed",
    "item/reasoning/summaryTextDelta",
    "item/agentMessage/delta",
    "turn/completed",
  ]);
  assert.equal(activity.find(message => message.method === "item/reasoning/summaryTextDelta").params.delta, "checked workspace");
  assert.equal(activity.filter(message => message.method === "item/reasoning/summaryTextDelta").length, 1);
  assert.equal(activity.filter(message => message.method === "item/agentMessage/delta").length, 1);
});

test("Claude SDK client maps Relay denial back to canUseTool", async () => {
  let permissionResult = null;
  const sdk = {
    query(params) {
      return queryObject(async function* () {
        permissionResult = await params.options.canUseTool("Bash", { command: "rm -rf tmp" }, {
          requestId: "permission-2",
          toolUseID: "tool-2",
          signal: new AbortController().signal,
        });
        yield { type: "result", session_id: params.options.sessionId, uuid: "u1", subtype: "success", is_error: false, result: "blocked" };
      });
    },
  };
  const client = new ClaudeSdkClient({ sdk });
  await client.start();
  const session = await client.createSession({ sessionId: "22222222-2222-4222-8222-222222222222" });
  client.on("request", request => client.resolveRequest(request.id, { action: "decline", message: "No thanks" }));
  const activity = [];
  client.on("activity", message => activity.push(message));
  await client.sendMessage(session.id, { text: "remove tmp" });
  await untilTurnCompleted(activity);

  assert.deepEqual(permissionResult, { behavior: "deny", message: "No thanks" });
});

test("Claude SDK maps generic DSH schemas to an in-process MCP server", async () => {
  let queryParams = null;
  let serverOptions = null;
  const calls = [];
  const sdk = {
    createSdkMcpServer(options) {
      serverOptions = options;
      return { type: "sdk", name: options.name };
    },
    tool(name, description, inputSchema, handler) {
      return { name, description, inputSchema, handler };
    },
    query(params) {
      queryParams = params;
      return queryObject(async function* () {
        yield { type: "result", session_id: params.options.sessionId, uuid: "u1", subtype: "success", is_error: false, result: "done" };
      });
    },
  };
  const client = new ClaudeSdkClient({ sdk });
  await client.start();
  const session = await client.createSession({ sessionId: "44444444-4444-4444-8444-444444444444" });
  const activity = [];
  client.on("activity", message => activity.push(message));
  await client.sendMessage(session.id, {
    text: "use the probe",
    dshTools: [{
      name: "cross_plugin_probe",
      description: "Probe a separately installed DSH plugin.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" }, count: { type: "integer" } },
        required: ["value"],
      },
    }],
  });
  await untilTurnCompleted(activity);

  assert.deepEqual(Object.keys(queryParams.options.mcpServers), ["dsh"]);
  assert.deepEqual(queryParams.options.allowedTools, ["mcp__dsh__cross_plugin_probe"], "DSH's tool runtime owns the approval decision, not the SDK layer");
  assert.equal(serverOptions.tools[0].name, "cross_plugin_probe");
  assert.equal(serverOptions.tools[0].inputSchema.value.isOptional(), false);
  assert.equal(serverOptions.tools[0].inputSchema.count.isOptional(), true);
  // The handler parks and announces itself; the harness runs the tool and the
  // result comes back through resolveToolCall.
  const parked = [];
  client.on("activity", message => { if (message.method === "tool/parked") parked.push(message.params); });
  const pending = serverOptions.tools[0].handler({ value: "ok" }, { signal: new AbortController().signal });
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();

  assert.equal(settled, false, "the call must wait for the harness");
  assert.equal(calls.length, 0, "the plugin must not execute DSH's tools itself");
  assert.equal(parked.length, 1, "a parked call must be announced or the harness never learns of it");
  assert.equal(parked[0].name, "cross_plugin_probe");
  assert.deepEqual(parked[0].arguments, { value: "ok" });

  client.resolveToolCall(parked[0].parkId, { content: [{ type: "text", text: "probe complete" }], isError: false });
  const result = await pending;
  assert.deepEqual(result.content, [{ type: "text", text: "probe complete" }]);
  assert.equal(result.isError, false);
});

test("a result for an unknown call is refused rather than silently swallowed", () => {
  const client = new ClaudeSdkClient({ sdk: {} });

  assert.equal(client.resolveToolCall("never-parked", { content: [] }), false);
});

test("abandoning a turn fails every parked call instead of hanging it", async () => {
  const client = new ClaudeSdkClient({ sdk: {} });
  const parked = client.parkToolCall("session-1", "turn-1", "bash", { command: "pwd" });

  client.rejectAllToolCalls(new Error("turn abandoned"));

  await assert.rejects(() => parked, /turn abandoned/);
});

test("Claude SDK client interrupts and aborts an in-progress query", async () => {
  let queryParams = null;
  let interrupted = 0;
  let closed = 0;
  let releaseNext;
  const sdk = {
    query(params) {
      queryParams = params;
      return {
        async next() { return new Promise(resolve => { releaseNext = resolve; }); },
        async return() { return { done: true }; },
        [Symbol.asyncIterator]() { return this; },
        async interrupt() { interrupted += 1; },
        close() { closed += 1; releaseNext?.({ done: true }); },
      };
    },
  };
  const client = new ClaudeSdkClient({ sdk });
  await client.start();
  const session = await client.createSession({ sessionId: "33333333-3333-4333-8333-333333333333" });
  const turn = await client.sendMessage(session.id, { text: "keep working" });

  await client.interruptTurn(session.id, turn.id);

  assert.equal(interrupted, 1);
  assert.equal(closed, 1);
  assert.equal(queryParams.options.abortController.signal.aborted, true);
});

function queryObject(factory) {
  const iterator = factory();
  return {
    async next() { return iterator.next(); },
    async return() { return iterator.return?.() ?? { done: true }; },
    async throw(error) { return iterator.throw?.(error) ?? Promise.reject(error); },
    [Symbol.asyncIterator]() { return this; },
    async interrupt() { return { still_queued: [] }; },
    close() {},
  };
}

async function untilTurnCompleted(activity) {
  const deadline = Date.now() + 1_000;
  while (!activity.some(message => message.method === "turn/completed")) {
    if (Date.now() > deadline) throw new Error("timed out waiting for turn/completed");
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

test("the catalog drops the default row and names models from their canonical ids", async () => {
  let closed = false;
  const sdk = {
    query() {
      return {
        async *[Symbol.asyncIterator]() {},
        async supportedModels() {
          return [
            { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)", description: "Best for everyday tasks", supportedEffortLevels: ["low", "medium", "high"] },
            { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]", displayName: "Opus (1M context)", description: "Best for everyday tasks", supportedEffortLevels: ["low", "medium", "high"] },
            { value: "claude-fable-5[1m]", resolvedModel: "claude-fable-5", displayName: "Fable", description: "", supportedEffortLevels: ["low", "high"] },
            { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "", supportsEffort: false },
          ];
        },
        close() { closed = true; },
      };
    },
  };

  const models = await new ClaudeSdkClient({ sdk }).listModels();

  assert.deepEqual(models.map(model => model.id), ["opus[1m]", "claude-fable-5[1m]", "haiku"]);
  assert.deepEqual(models.map(model => model.displayName), ["Opus 5", "Fable 5", "Haiku 4.5"]);
  assert.equal(models.every(model => model.description === undefined), true);
  assert.equal(models[0].isDefault, true, "the recommendation carried by the default row moves onto its named twin");
  assert.deepEqual(models[1].supportedReasoningEfforts.map(effort => effort.reasoningEffort), ["low", "high"]);
  assert.equal(models[1].defaultReasoningEffort, undefined, "the SDK reports no default effort, so none is invented");
  assert.equal(models[2].supportedReasoningEfforts, undefined);
  assert.equal(closed, true);
});

test("an unavailable catalog falls back to the built-in model list", async () => {
  const sdk = { query() { return { async supportedModels() { throw new Error("no control channel"); }, close() {} }; } };
  const diagnostics = [];
  const client = new ClaudeSdkClient({ sdk });
  client.on("diagnostic", message => diagnostics.push(message));

  const models = await client.listModels();

  assert.equal(models.some(model => model.id === "sonnet"), true);
  assert.match(diagnostics[0], /catalog unavailable/);
});

test("Claude Code's own tools are removed from context so DSH owns the toolset", async () => {
  let captured = null;
  const sdk = {
    query(params) { captured = params.options; return Object.assign((async function* () {})(), { close() {}, interrupt: async () => {} }); },
    createSdkMcpServer: config => ({ config }),
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
  };
  const client = new ClaudeSdkClient({ sdk });
  const session = await client.createSession({ sessionId: "s1", cwd: "/workspace" });
  await client.sendMessage(session.id, {
    text: "hi",
    dshTools: [{ name: "bash", description: "run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    executeDshTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });

  assert.deepEqual(captured.tools, [], "no built-in tools may remain in context");
  assert.deepEqual(captured.toolAliases, { Bash: "mcp__dsh__bash" });
  assert.deepEqual(captured.allowedTools, ["mcp__dsh__bash"], "DSH gates its own tools against the session's sandbox policy");
});

test("DSH tools are pre-approved regardless of policy, because DSH gates them", async () => {
  let captured = null;
  const sdk = {
    query(params) { captured = params.options; return Object.assign((async function* () {})(), { close() {}, interrupt: async () => {} }); },
    createSdkMcpServer: config => ({ config }),
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
  };
  const client = new ClaudeSdkClient({ sdk });
  const session = await client.createSession({ sessionId: "s2", cwd: "/workspace" });
  await client.sendMessage(session.id, {
    text: "hi",
    approvalPolicy: "never",
    dshTools: [{ name: "bash", description: "run", parameters: { type: "object", properties: {}, required: [] } }],
    executeDshTool: async () => ({ content: [] }),
  });

  assert.deepEqual(captured.allowedTools, ["mcp__dsh__bash"]);
});

test("a caller that forgets settingSources still loads none of the user's Claude config", async () => {
  let captured = null;
  const sdk = {
    query(params) { captured = params.options; return Object.assign((async function* () {})(), { close() {}, interrupt: async () => {} }); },
  };
  const client = new ClaudeSdkClient({ sdk });
  const session = await client.createSession({ sessionId: "s-default" });

  // No settingSources anywhere: not on the message, not on the session config.
  await client.sendMessage(session.id, { text: "hi" });

  assert.deepEqual(captured.settingSources, [], "the default must not mount ~/.claude on top of the harness prompt");
});

test("Anthropic's usage shape maps onto the harness's, cache split intact", async () => {
  const { tokenUsage } = await import("../sdk-client.mjs");

  assert.deepEqual(tokenUsage({
    input_tokens: 261,
    output_tokens: 5,
    cache_read_input_tokens: 1200,
    cache_creation_input_tokens: 40,
    output_tokens_details: { thinking_tokens: 3 },
  }), { inputTokens: 261, outputTokens: 5, cacheReadTokens: 1200, cacheWriteTokens: 40, reasoningTokens: 3 });

  // Reads and writes must stay separate: the harness derives a cache-hit rate.
  const usage = tokenUsage({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 });
  assert.equal(usage.cacheReadTokens / (usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens), 0.9);

  assert.equal(tokenUsage(null), null);
  assert.deepEqual(tokenUsage({}), { inputTokens: 0, outputTokens: 0 });
});

test("context capacity is learned from result messages and defaulted until then", async () => {
  const client = new ClaudeSdkClient({ sdk: {} });

  assert.equal(client.contextWindowFor("haiku"), 200000, "a sane default before any turn has run");
  assert.equal(client.contextWindowFor("opus[1m]", "claude-opus-5[1m]"), 1000000, "the long-context rows are recognised");

  client.learnContextWindows({
    "claude-haiku-4-5-20251001": { contextWindow: 200000, canonicalModel: "claude-haiku-4-5" },
    "claude-sonnet-5": { contextWindow: 500000 },
  });

  assert.equal(client.contextWindowFor("sonnet", "claude-sonnet-5"), 500000, "the reported number wins over the default");
  assert.equal(client.contextWindowFor("haiku", "claude-haiku-4-5-20251001"), 200000);
});

test("readable reasoning is requested, and opting out asks for nothing", async () => {
  let captured = null;
  const sdk = {
    query(params) { captured = params.options; return Object.assign((async function* () {})(), { close() {}, interrupt: async () => {} }); },
  };
  const client = new ClaudeSdkClient({ sdk });
  const session = await client.createSession({ sessionId: "s-think" });

  await client.sendMessage(session.id, { text: "hi" });
  // Without display: "summarized" the thinking blocks arrive with empty text —
  // a signature and a token count, nothing to render.
  assert.deepEqual(captured.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(captured.settingSources, [], "and none of it comes from ~/.claude");

  await client.sendMessage(session.id, { text: "hi", thinkingSummaries: false });
  assert.equal(captured.thinking, undefined, "opting out leaves the SDK's own default alone");
});
