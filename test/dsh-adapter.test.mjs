import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeDshAdapter } from "../claude-adapter.js";
import { ClaudeLinkStore } from "../claude-link-store.js";
import { handleClaudeSdkRequest } from "../claude-tools.js";

test("a tool call is handed to DSH as a tool-call finish, and the answer resumes the same turn", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const messages = [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "list the files" }] }];
  const request = {
    provider: "claude",
    model: "sonnet",
    reasoningEffort: "high",
    sessionId: agent.id,
    messages,
    tools: [{ name: "bash", description: "Run a command.", parameters: { type: "object", properties: { command: { type: "string" } } } }],
  };

  // Step one: Claude reasons, then asks for a tool. DSH must be told to run it.
  const first = await collect(adapter.stream(request));
  const call = first.find(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call");
  assert.equal(first.find(chunk => chunk.type === "reasoning-delta").text, "Checked the workspace.");
  assert.equal(call.block.name, "bash", "DSH must see its own tool name");
  assert.deepEqual(JSON.parse(call.block.arguments), { command: "pwd" });
  assert.equal(first.at(-1).reason.kind, "tool-calls", "DSH's loop runs the tool, which is what fills its trajectory");
  assert.equal(runtime.resolved.length, 0, "nothing is resolved until DSH reports a result");

  // Step two: DSH executed it and calls back with the result.
  const second = await collect(adapter.stream({
    ...request,
    messages: [
      ...messages,
      { role: "user", content: [{ type: "tool-result", toolCallId: call.block.id, content: [{ type: "text", text: "/workspace/dsh" }] }] },
    ],
  }));

  assert.deepEqual(runtime.resolved.map(entry => entry.toolUseId), [call.block.id]);
  assert.equal(runtime.resolved[0].result.content[0].text, "/workspace/dsh", "the harness result reaches Claude verbatim");
  assert.equal(runtime.sent.length, 1, "resuming must not start a second Claude turn");
  assert.equal(second.find(chunk => chunk.type === "text-delta").text, "done");
  assert.equal(second.at(-1).reason.kind, "stop");
  assert.equal(second.at(-1).replayState.claudeSessionId, "claude-1");
  assert.equal(agent.appended.length, 0, "tool activity belongs to DSH's trajectory, not to a custom event");
});

test("Claude models expose native reasoning effort choices", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });

  const model = await adapter.resolveModel("claude", "sonnet");

  assert.deepEqual(model.reasoning.efforts.map(effort => effort.id), ["low", "high"]);
  assert.equal(model.reasoning.defaultEffort, undefined, "an unset effort lets Claude Code apply its own default");
});

test("automatic title generation uses an isolated ephemeral Claude session", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const [mainChunks, titleChunks] = await Promise.all([
    collect(adapter.stream({
      provider: "claude",
      model: "sonnet",
      sessionId: agent.id,
      messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "list project files" }] }],
    })),
    collect(adapter.stream({
      provider: "claude",
      model: "sonnet",
      sessionId: agent.id,
      purpose: "session-title",
      system: "Generate a concise title.",
      messages: [{
        role: "user",
        source: { kind: "plugin", plugin: "dsh-session-title-llm" },
        content: [{ type: "text", text: "Generate the session title from this JSON array: [\"list project files\"]" }],
      }],
    })),
  ]);

  const auxiliaryConfig = runtime.createdConfigs.find(config => config.ephemeral === true);
  assert.equal(adapter.sessionFor(agent.id), "claude-1");
  assert.equal(auxiliaryConfig.sandbox, "read-only");
  assert.equal(auxiliaryConfig.approvalPolicy, "never");
  assert.deepEqual(auxiliaryConfig.settingSources, [], "auxiliary calls must not load ~/.claude settings either");
  assert.deepEqual(runtime.released, ["claude-2"]);
  assert.equal(mainChunks.find(chunk => chunk.type === "text-delta").text, "done");
  assert.equal(titleChunks.find(chunk => chunk.type === "text-delta").text, "项目文件查询");
});

test("DSH-to-Claude links and configuration survive host restart", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "claude-sdk-links-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "links.json");
  const firstRuntime = new FakeRuntime();
  const first = new ClaudeDshAdapter({ runtime: firstRuntime, ready: Promise.resolve(), linkStore: new ClaudeLinkStore(path) });
  first.configure("dsh-1", { model: "sonnet", effort: "high", sandbox: "read-only" });
  const claudeSessionId = await first.ensureSession("dsh-1");

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.sessions["dsh-1"].claudeSessionId, claudeSessionId);
  const secondRuntime = new FakeRuntime();
  const second = new ClaudeDshAdapter({ runtime: secondRuntime, ready: Promise.resolve(), linkStore: new ClaudeLinkStore(path) });
  assert.equal(await second.ensureSession("dsh-1"), claudeSessionId);
  assert.equal(second.configuration("dsh-1").sandbox, "read-only");
  assert.equal(secondRuntime.created, 0);
  assert.equal(secondRuntime.resumed, 1);
});

test("concurrent first messages create exactly one Claude session", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const [left, right] = await Promise.all([adapter.ensureSession("dsh-1"), adapter.ensureSession("dsh-1")]);
  assert.equal(left, right);
  assert.equal(runtime.created, 1);
});

test("Claude SDK permission and question requests use DSH services", async () => {
  const agent = fakeAgent();
  const adapter = { dshSessionForClaudeSession: sessionId => sessionId === "claude-1" ? agent.id : null };
  const calls = { approvals: [], questions: [] };
  const ctx = {
    agents: { get: id => id === agent.id ? agent : null },
    approval: { async request(input) { calls.approvals.push(input); return "allowed-once"; } },
    userQuestions: {
      async ask(input) {
        calls.questions.push(input);
        return { answers: [{ id: "question-1", selected: ["Detailed"], custom: "with tests" }] };
      },
    },
  };
  const runtime = new InteractionRuntime();

  await handleClaudeSdkRequest(ctx, {
    adapter,
    runtime,
    request: {
      id: "approval-1",
      method: "tool/requestApproval",
      params: { sessionId: "claude-1", toolName: "Write", input: { file_path: "probe.txt" }, title: "Claude wants to write probe.txt" },
    },
  });
  assert.equal(calls.approvals[0].agent, agent);
  assert.equal(calls.approvals[0].toolName, "Claude Write");
  assert.equal(runtime.resolved.at(-1).response.action, "accept");

  await handleClaudeSdkRequest(ctx, {
    adapter,
    runtime,
    request: {
      id: "question-1",
      method: "tool/requestUserInput",
      params: { sessionId: "claude-1", input: { questions: [{
        question: "How detailed?",
        header: "Detail",
        options: [{ label: "Brief" }, { label: "Detailed" }],
      }] } },
    },
  });
  assert.equal(calls.questions[0].questions[0].question, "How detailed?");
  assert.deepEqual(runtime.resolved.at(-1).response.answers, { "How detailed?": "Detailed" });
});

test("DSH's tools travel to Claude and their results travel back untouched", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const messages = [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "use the probe" }] }];
  const request = {
    provider: "claude",
    model: "sonnet",
    sessionId: agent.id,
    messages,
    tools: [{
      name: "cross_plugin_probe",
      description: "Probe a separately installed DSH plugin.",
      parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    }],
  };

  const first = await collect(adapter.stream(request));
  assert.deepEqual(runtime.sent[0].message.dshTools.map(tool => tool.name), ["cross_plugin_probe"]);
  assert.equal(runtime.sent[0].message.executeDshTool, undefined, "the adapter must not execute DSH's tools itself");
  const call = first.find(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call");
  assert.equal(call.block.name, "cross_plugin_probe");

  await collect(adapter.stream({
    ...request,
    messages: [
      ...messages,
      { role: "user", content: [{ type: "tool-result", toolCallId: call.block.id, isError: true, content: [{ type: "text", text: "probe failed" }] }] },
    ],
  }));

  assert.equal(runtime.resolved[0].result.isError, true, "a failed harness tool must reach Claude as a failure");
  assert.equal(runtime.resolved[0].result.content[0].text, "probe failed");
});

test("DSH's mid-turn context splices never swallow the instruction", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  // The real shape from a DSH standard-mode turn: the human's message is first,
  // then DSH appends workspace instructions, a runtime snapshot, and the skills
  // catalogue as further "user" messages.
  for await (const chunk of adapter.stream({
    provider: "claude",
    model: "haiku",
    sessionId: agent.id,
    messages: [
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "list the files here" }] },
      { role: "user", source: { kind: "agent-instructions" }, content: [{ type: "text", text: "<system-reminder>workspace instructions</system-reminder>" }] },
      { role: "user", source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, content: [{ type: "text", text: "Current runtime context." }] },
      { role: "user", source: { kind: "skill-catalog" }, content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }] },
    ],
  })) void chunk;

  const sent = runtime.sent[0].message.text;
  assert.match(sent, /list the files here$/, "the instruction must be the final thing Claude reads");
  assert.equal(sent.match(/list the files here/g).length, 1, "the instruction must not also appear inside the context block");
  assert.match(sent, /workspace instructions/, "DSH's spliced context must still reach Claude");
  assert.match(sent, /Current runtime context/);
  assert.doesNotMatch(sent, /do not act on them/i, "current-turn context must not be labelled as inert history");
});

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.models = [{
      id: "sonnet",
      displayName: "Sonnet 5",
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
    }];
    this.sessions = new Map();
    this.sent = [];
    this.created = 0;
    this.resumed = 0;
    this.createdConfigs = [];
    this.released = [];
    this.resolved = [];
    this.interrupted = [];
    this.parked = null;
  }

  async createSession(config) {
    await new Promise(resolve => setTimeout(resolve, 2));
    this.createdConfig = config;
    this.createdConfigs.push(structuredClone(config));
    const session = { id: `claude-${++this.created}`, turns: [], ...config };
    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(sessionId, config) {
    this.resumed += 1;
    this.sessions.set(sessionId, { id: sessionId, turns: [], ...config });
    return this.sessions.get(sessionId);
  }

  async sendMessage(sessionId, message) {
    this.sent.push({ sessionId, message });
    const turnId = "turn-1";
    this.answer = message.text.includes("Generate the session title") ? "项目文件查询" : "done";
    queueMicrotask(() => {
      this.emit("activity", notification("item/reasoning/summaryTextDelta", sessionId, turnId, {
        itemId: "reason-1", delta: "Checked the workspace.",
      }));
      const tool = message.dshTools?.[0];
      if (tool) {
        // Park: Claude asked for a tool and is waiting on the harness to run it.
        this.parked = { sessionId, turnId };
        this.emit("activity", notification("tool/parked", sessionId, turnId, {
          parkId: "park-1", name: tool.name, arguments: { command: "pwd" },
        }));
        return;
      }
      this.finishTurn(sessionId, turnId);
    });
    return { id: turnId, status: "inProgress", items: [] };
  }

  resolveToolCall(toolUseId, result) {
    this.resolved.push({ toolUseId, result });
    const parked = this.parked;
    this.parked = null;
    if (!parked) return false;
    queueMicrotask(() => this.finishTurn(parked.sessionId, parked.turnId));
    return true;
  }

  rejectAllToolCalls() {}

  contextWindowFor() { return 200000; }

  finishTurn(sessionId, turnId) {
    this.emit("activity", notification("item/agentMessage/delta", sessionId, turnId, { itemId: "answer-1", delta: this.answer }));
    this.emit("activity", { method: "turn/completed", params: {
      sessionId,
      turn: {
        id: turnId,
        status: "completed",
        error: null,
        items: [],
        usage: { inputTokens: 20, outputTokens: 160, cacheReadTokens: 17844, cacheWriteTokens: 0, reasoningTokens: 75 },
      },
    } });
  }

  async interruptTurn(sessionId, turnId) { this.interrupted.push({ sessionId, turnId }); }

  async releaseSession(sessionId) {
    this.released.push(sessionId);
    this.sessions.delete(sessionId);
  }
}

class InteractionRuntime {
  constructor() { this.resolved = []; this.rejected = []; }
  async resolveRequest(id, response) { this.resolved.push({ id, response }); }
  rejectRequest(id, error) { this.rejected.push({ id, error }); }
}

function fakeAgent({ tools = null } = {}) {
  const appended = [];
  return {
    id: "dsh-1",
    appended,
    ctx: tools ? { tools } : {},
    session: {
      header: { agentPreset: "standard", cwd: "/workspace/dsh" },
      events: [],
      append(type, data) { appended.push({ type, data }); },
    },
  };
}

function notification(method, sessionId, turnId, rest) {
  return { method, params: { sessionId, turnId, ...rest } };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

test("a resumed turn that never speaks fails instead of stalling forever", async () => {
  const runtime = new FakeRuntime();
  runtime.resolveToolCall = function (toolUseId, result) {
    this.resolved.push({ toolUseId, result });
    return true; // accepted, but the turn never emits again
  };
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const messages = [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "go" }] }];
  const request = {
    provider: "claude",
    sessionId: agent.id,
    messages,
    tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } }],
  };
  const first = await collect(adapter.stream(request));
  const call = first.find(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call");

  process.env.DSH_AGENT_BRIDGE_RESUME_TIMEOUT_MS = "80";
  try {
    await assert.rejects(
      () => collect(adapter.stream({
        ...request,
        messages: [...messages, { role: "user", content: [{ type: "tool-result", toolCallId: call.block.id, content: [{ type: "text", text: "ok" }] }] }],
      })),
      /did not respond within/,
    );
  } finally {
    delete process.env.DSH_AGENT_BRIDGE_RESUME_TIMEOUT_MS;
  }
});

test("a result nothing is waiting for fails the turn rather than parking it", async () => {
  const runtime = new FakeRuntime();
  runtime.resolveToolCall = () => false;
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const messages = [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "go" }] }];
  const request = {
    provider: "claude",
    sessionId: agent.id,
    messages,
    tools: [{ name: "bash", description: "run", parameters: { type: "object", properties: {} } }],
  };
  const first = await collect(adapter.stream(request));
  const call = first.find(chunk => chunk.type === "block-end" && chunk.block.type === "tool-call");

  await assert.rejects(() => collect(adapter.stream({
    ...request,
    messages: [...messages, { role: "user", content: [{ type: "tool-result", toolCallId: call.block.id, content: [] }] }],
  })), /No Claude tool call is waiting/);
});

test("a turn answered by another model carries its tool work, not just its prose", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  await collect(adapter.stream({
    provider: "claude",
    model: "sonnet",
    sessionId: agent.id,
    messages: [
      // What DSH's history looks like after another provider answered a turn.
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "read package.json" }] },
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: '{"file_path":"package.json"}' }] },
      { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: '{"name":"auth-ts","devDependencies":{"nx":"23.1.1"}}' }] }] },
      { role: "assistant", content: [{ type: "text", text: "It pins nx." }] },
      { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "what version was that?" }] },
    ],
  }));

  const sent = runtime.sent[0].message.text;
  assert.match(sent, /tool result: .*23\.1\.1/, "the other model's tool output must reach Claude");
  assert.match(sent, /called read/, "and what it called to get it");
  assert.match(sent, /what version was that\?$/, "with the live question last");
});

test("the harness is given token accounting and context capacity", async () => {
  const runtime = new FakeRuntime();
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const agent = fakeAgent();
  adapter.attachAgent(agent);

  const chunks = await collect(adapter.stream({
    provider: "claude",
    model: "sonnet",
    sessionId: agent.id,
    messages: [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hi" }] }],
  }));

  const usage = chunks.find(chunk => chunk.type === "usage");
  assert.ok(usage, "without a usage chunk the harness can report no tokens, cache rate or tok/s");
  assert.deepEqual(usage.usage, {
    inputTokens: 20, outputTokens: 160, cacheReadTokens: 17844, cacheWriteTokens: 0, reasoningTokens: 75,
  });
  // The protocol requires usage before the terminal finish, and nothing after.
  assert.equal(chunks.indexOf(usage), chunks.length - 2);
  assert.equal(chunks.at(-1).type, "finish");

  const model = await adapter.resolveModel("claude", "sonnet");
  assert.deepEqual(model.context, { contextWindow: 200000 }, "context pressure cannot render without a window");
});
