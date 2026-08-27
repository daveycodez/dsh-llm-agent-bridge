import assert from "node:assert/strict";
import test from "node:test";

import { ULTRACODE_BASE_EFFORT, ULTRACODE_EFFORT, hasWorkflowTool, orchestrationPolicy, withOrchestrationPolicy } from "../orchestration.js";

const schema = { type: "object", properties: { input: { type: "string" } }, required: [] };
const TOOLS = [
  { name: "bash", description: "Run a command.", parameters: schema },
  { name: "workflow", description: "Orchestrate subagents at scale.", parameters: schema },
  { name: "subagent", description: "Delegate one focused task.", parameters: schema },
];

test("orchestration is gated by default, standing under Ultracode", () => {
  const gated = orchestrationPolicy(TOOLS, false);
  assert.match(gated, /ONLY call mcp__dsh__workflow when the user has explicitly opted/);
  assert.match(gated, /not have it inferred/);
  assert.match(gated, /do NOT call it/);
  assert.match(gated, /mcp__dsh__subagent/, "it must name the alternative, not just the prohibition");
  assert.doesNotMatch(gated, /\bWorkflow tool\b/, "the policy governs the harness's tool, not Claude Code's");

  const standing = orchestrationPolicy(TOOLS, true);
  assert.match(standing, /opt-in to multi-agent orchestration is standing/);
  assert.match(standing, /token cost is not a constraint/);
  assert.match(standing, /Solo only on conversational turns/);
  assert.doesNotMatch(standing, /do NOT call it/);

  for (const policy of [gated, standing]) {
    assert.match(policy, /under 15 agents/, "both halves carry the size guideline");
  }
});

test("a turn without a workflow tool gets no policy at all", () => {
  // Nothing to govern: the harness offered no fan-out tool this turn.
  assert.equal(hasWorkflowTool([TOOLS[0]]), false);
  assert.equal(orchestrationPolicy([TOOLS[0]], false), null);
  assert.equal(orchestrationPolicy([TOOLS[0]], true), null);
  assert.equal(orchestrationPolicy(undefined, true), null);
});

test("the policy is appended to the harness prompt, never replaces it", () => {
  const prompt = "You are an AI agent powered by DeepSeek Harness.";
  const merged = withOrchestrationPolicy(prompt, orchestrationPolicy(TOOLS, true));

  assert.ok(merged.startsWith(prompt), "the harness owns the prompt; this only adds to it");
  assert.match(merged, /Ultracode/);
  assert.equal(withOrchestrationPolicy(prompt, null), prompt, "no policy leaves the prompt untouched");
});

test("Ultracode selects xhigh and is offered only where xhigh exists", async () => {
  const { ClaudeSdkClient } = await import("../sdk-client.mjs");
  let captured = null;
  const sdk = {
    query(params) { captured = params.options; return Object.assign((async function* () {})(), { close() {}, interrupt: async () => {} }); },
    createSdkMcpServer: config => ({ config }),
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
  };
  const client = new ClaudeSdkClient({ sdk });
  const session = await client.createSession({ sessionId: "s-ultra" });

  await client.sendMessage(session.id, { text: "audit this", effort: ULTRACODE_EFFORT, dshTools: TOOLS });

  assert.equal(captured.effort, ULTRACODE_BASE_EFFORT, "ultracode is not an SDK effort; it selects xhigh");
  assert.deepEqual(captured.settings, { ultracode: true, enableWorkflows: true });
  assert.match(captured.systemPrompt, /standing/, "and carries the standing orchestration posture");

  await client.sendMessage(session.id, { text: "audit this", effort: "xhigh", dshTools: TOOLS });
  assert.equal(captured.settings, undefined, "plain xhigh must not turn ultracode on");
  assert.match(captured.systemPrompt, /ONLY call mcp__dsh__workflow/, "it gets the gate instead");
});
