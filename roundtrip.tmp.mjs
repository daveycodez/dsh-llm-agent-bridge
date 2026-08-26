import { ClaudeDshAdapter } from "./claude-adapter.js";
import { ClaudeSdkClient } from "./sdk-client.mjs";
import { ClaudeSessionRuntime } from "./session-runtime.mjs";
import { execSync } from "node:child_process";

const client = new ClaudeSdkClient();
const runtime = new ClaudeSessionRuntime({ client, cwd: process.cwd() });
const ready = runtime.initialize();
const adapter = new ClaudeDshAdapter({ runtime, ready });
runtime.on("request", req => runtime.resolveRequest(req.id, { action: "accept" }));

const agent = { id: "rt-1", ctx: {}, session: { header: { cwd: process.cwd() }, events: [], append() {} } };
adapter.attachAgent(agent);

const tools = [{ name: "bash", description: "Run a bash command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];
let messages = [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "how many .mjs files are here? use a tool, then answer with the number." }] }];

for (let step = 1; step <= 6; step++) {
  const chunks = [];
  for await (const chunk of adapter.stream({
    provider: "claude", model: "haiku", sessionId: agent.id, tools, messages,
    system: "You are an AI agent powered by DeepSeek Harness. Use the bash tool.",
  })) chunks.push(chunk);

  const finish = chunks.at(-1);
  const text = chunks.filter(c => c.type === "text-delta").map(c => c.text).join("");
  const calls = chunks.filter(c => c.type === "block-end" && c.block.type === "tool-call").map(c => c.block);
  console.log(`step ${step}: finish=${finish.reason.kind} toolCalls=${calls.length} text=${JSON.stringify(text.slice(0, 90))}`);

  if (finish.reason.kind !== "tool-calls") break;

  // Stand in for DSH's agent loop: execute, then hand the results back.
  const results = calls.map(call => {
    const args = JSON.parse(call.arguments);
    console.log(`  DSH executes ${call.name}: ${args.command}`);
    const out = execSync(String(args.command), { encoding: "utf8" }).slice(0, 300);
    return { type: "tool-result", toolCallId: call.id, content: [{ type: "text", text: out }] };
  });
  messages = [...messages, { role: "assistant", content: calls.map(c => ({ type: "tool-call", ...c })) }, { role: "user", content: results }];
}
process.exit(0);
