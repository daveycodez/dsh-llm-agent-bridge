import { LlmAdapter } from "@deepseek-ai/dsh-llm";
import { debugLog } from "./debug.js";
import { dshToolResult } from "./sdk-client.mjs";
import { scanOnlyTelemetryControl } from "./telemetry-control.js";

// Identification, not branding: the row names the thing it invokes.
export const CLAUDE_PROVIDER = "claude";

export class ClaudeDshAdapter extends LlmAdapter {
  constructor({ runtime, ready, linkStore = null, logger = console, telemetry = scanOnlyTelemetryControl(), thinkingSummaries = true }) {
    super();
    this.telemetry = telemetry;
    this.thinkingSummaries = thinkingSummaries;
    this.runtime = runtime;
    this.ready = ready;
    this.logger = logger;
    this.linkStore = linkStore;
    this.links = new Map();
    this.settings = new Map();
    this.pendingSessions = new Map();
    this.agents = new Map();
    this.seen = new Map();
    // DSH sessions whose Claude turn is parked on tool calls DSH is executing.
    this.suspended = new Map();
    for (const [sessionId, record] of linkStore?.entries() ?? []) {
      const claudeSessionId = record.claudeSessionId ?? record.sessionId ?? record.threadId;
      if (claudeSessionId) this.links.set(sessionId, claudeSessionId);
      this.settings.set(sessionId, record.config);
      if (Number.isSafeInteger(record.seen)) this.seen.set(sessionId, record.seen);
    }
  }

  providerInfo() {
    // Anthropic's Agent SDK branding guidance lists both "Claude Agent"
    // (preferred for dropdowns) and bare "Claude" (within a menu labelled
    // "Agents") as allowed. DSH's picker has no such heading, so the literal
    // reading favours the former — but "preferred" is not "required", and bare
    // "Claude" is what every BYO-subscription harness ships, T3 Code included.
    // What the guidance forbids is naming the product after Claude Code, which
    // nothing here does.
    return { id: CLAUDE_PROVIDER, name: "Claude" };
  }

  async listModels() {
    await this.ready;
    return runtimeModels(this.runtime)
      .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)))
      .map(model => ({
        provider: CLAUDE_PROVIDER,
        id: model.id,
        name: model.displayName ?? model.id,
        inputModalities: ["text", "image"],
      }));
  }

  async resolveModel(provider, model) {
    await this.ready;
    const info = runtimeModels(this.runtime).find(candidate => candidate.id === model);
    const contextWindow = this.runtime.contextWindowFor?.(model, info?.resolvedModel);
    return {
      provider,
      id: model,
      name: info?.displayName ?? model,
      inputModalities: ["text", "image"],
      // Without this the harness cannot show context pressure for the row.
      ...(contextWindow ? { context: { contextWindow } } : {}),
      ...(Array.isArray(info?.supportedReasoningEfforts)
        ? {
            reasoning: {
              efforts: info.supportedReasoningEfforts.map(effort => ({
                id: effort.reasoningEffort ?? effort.id ?? effort,
                name: reasoningEffortName(effort.reasoningEffort ?? effort.id ?? effort),
              })),
              defaultEffort: info.defaultReasoningEffort,
            },
          }
        : {}),
    };
  }

  attachAgent(agent) {
    this.agents.set(String(agent.id), agent);
    this.configuration(agent.id, agent.session.header.cwd);
    return true;
  }

  detachAgent(sessionId) {
    this.agents.delete(String(sessionId));
  }

  configuration(sessionId, cwd) {
    const key = String(sessionId);
    const existing = this.settings.get(key);
    if (existing) return existing;
    const models = runtimeModels(this.runtime);
    const model = models.find(candidate => candidate.isDefault) ?? models[0];
    const config = {
      model: model?.id ?? "sonnet",
      effort: model?.defaultReasoningEffort,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      cwd: cwd ?? process.cwd(),
      // DSH's preset owns the prompt and the tool set; do not load ~/.claude
      // settings, CLAUDE.md, or the claude_code system prompt on top of it.
      settingSources: [],
      systemPrompt: undefined,
      thinkingSummaries: this.thinkingSummaries,
    };
    this.settings.set(key, config);
    return config;
  }

  configure(sessionId, patch = {}) {
    const key = String(sessionId);
    const next = { ...this.configuration(key), ...compact(patch) };
    this.settings.set(key, next);
    const claudeSessionId = this.links.get(key);
    if (claudeSessionId) {
      patchRuntimeSession(this.runtime, claudeSessionId, next);
    }
    this.persistLink(key);
    return structuredClone(next);
  }

  async ensureSession(sessionId) {
    const key = String(sessionId);
    const pending = this.pendingSessions.get(key);
    if (pending) return pending;
    const operation = this.createOrResumeSession(key).finally(() => {
      this.pendingSessions.delete(key);
    });
    this.pendingSessions.set(key, operation);
    return operation;
  }

  async createOrResumeSession(sessionId) {
    await this.ready;
    const settings = { ...this.configuration(sessionId) };
    const linked = this.links.get(sessionId);
    if (linked && hasRuntimeSession(this.runtime, linked)) return linked;
    if (linked) {
      try {
        await this.runtime.resumeSession(linked, settings);
        return linked;
      } catch (error) {
        this.logger.warn(`Relay could not resume Claude session ${linked}; creating a replacement: ${error.message}`);
        this.links.delete(sessionId);
      }
    }
    const created = await this.runtime.createSession(settings);
    this.links.set(sessionId, created.id);
    this.persistLink(sessionId);
    return created.id;
  }

  persistLink(sessionId) {
    this.linkStore?.set(sessionId, {
      claudeSessionId: this.links.get(sessionId) ?? null,
      config: this.configuration(sessionId),
      seen: this.seen.get(String(sessionId)) ?? 0,
    });
  }

  sessionFor(sessionId) {
    return this.links.get(String(sessionId)) ?? null;
  }

  dshSessionForClaudeSession(claudeSessionId) {
    for (const [sessionId, candidate] of this.links) {
      if (candidate === claudeSessionId) return sessionId;
    }
    return null;
  }

  async *stream(options) {
    await this.telemetry.enforce();
    if (options.purpose) {
      yield* this.streamAuxiliary(options);
      return;
    }
    const sessionId = String(options.sessionId ?? "");
    if (!sessionId) throw new Error("The Claude adapter requires a DSH session id");
    const agent = this.agents.get(sessionId);
    if (!agent) throw new Error(`The Claude adapter has no attached agent for ${sessionId}`);

    // A turn suspended on tool calls resumes here: DSH ran them and is calling
    // back with the results, so the same Claude query continues rather than a
    // new one starting.
    const suspended = this.suspended.get(sessionId);
    debugLog("stream", {
      sessionId,
      messages: options.messages?.length ?? 0,
      tools: options.tools?.length ?? 0,
      suspended: suspended ? suspended.calls : null,
      toolResultIds: allToolResultIds(options.messages),
    });
    if (suspended) {
      const results = toolResultsFor(options.messages, suspended.calls);
      if (results.length) {
        debugLog("resume", { sessionId, turnId: suspended.turnId, resolving: results.map(result => result.toolCallId) });
        yield* this.runTurn(agent, sessionId, suspended.claudeSessionId, options, async () => {
          for (const result of results) {
            const delivered = this.runtime.resolveToolCall(result.toolCallId, dshToolResult(result));
            debugLog("resolve", { toolCallId: result.toolCallId, delivered });
            if (!delivered) {
              // Nothing is waiting on this id, so nothing will ever wake the
              // turn. Fail now rather than stalling for the user to notice.
              throw new Error(`No Claude tool call is waiting for result ${result.toolCallId}; the turn cannot be resumed`);
            }
          }
          return suspended.turnId;
        }, { firstEventTimeoutMs: resumeTimeoutMs() });
        return;
      }
      debugLog("abandon", { sessionId, turnId: suspended.turnId, expected: suspended.calls });
      // No results for the calls we parked: the turn was abandoned (interrupted,
      // or the user typed over it). Release Claude before starting a new one.
      await this.abandonTurn(sessionId, suspended);
    }

    const instruction = latestUserIndex(options.messages);
    const text = instruction === -1 ? "" : messageText(options.messages[instruction]);
    if (!text) throw new Error("The Claude adapter received no user text");
    const nativePermissions = permissionConfiguration(agent.session.events);
    const config = this.configure(sessionId, {
      model: options.model,
      effort: options.reasoningEffort,
      systemPrompt: options.system,
      ...nativePermissions,
      cwd: agent.session.header.cwd,
    });
    const dshTools = structuredClone(options.tools ?? []);
    const claudeSessionId = await this.ensureSession(sessionId);
    const prompt = this.seedPrompt(sessionId, options.messages, instruction, text);
    yield* this.runTurn(agent, sessionId, claudeSessionId, options, async () => {
      const started = await this.runtime.sendMessage(claudeSessionId, { text: prompt, ...config, dshTools });
      return started.id;
    });
  }

  /**
   * Project one DSH step of a Claude turn.
   *
   * A step ends one of two ways: Claude finishes, or it calls tools. Tool calls
   * are handed to DSH as `tool-call` chunks with a `tool-calls` finish, so DSH's
   * own agent loop executes them — under its sandbox and approval policy, and
   * recorded in its trajectory — and then calls back into `stream()` with the
   * results, which resume the same Claude query.
   */
  async *runTurn(agent, sessionId, claudeSessionId, options, start, { firstEventTimeoutMs = 0 } = {}) {
    const queue = new ActivityQueue(options.signal, "Claude");
    const onActivity = (message) => {
      const candidate = message.params?.sessionId ?? message.params?.session?.id;
      if (candidate === claudeSessionId) queue.push(message);
    };
    // Subscribe before starting or resuming: a runtime that emits synchronously
    // would otherwise deliver the whole turn before anyone is listening.
    const stopActivity = subscribeRuntimeActivity(this.runtime, onActivity);
    let turnId = null;
    try {
      turnId = await start();
      debugLog("turn/started", { sessionId, claudeSessionId, turnId });
      const state = createStreamState();
      let completedTurn = null;
      let batch = null;
      let first = true;
      while (!completedTurn && !batch) {
        // A resumed turn that never speaks again is the one failure with no
        // stack to show for it: the query is parked inside the SDK. Bound the
        // first wait so it surfaces as an error the user can act on.
        const message = await (first && firstEventTimeoutMs
          ? withTimeout(queue.next(), firstEventTimeoutMs, `Claude did not respond within ${Math.round(firstEventTimeoutMs / 1000)}s of the tool result being delivered`)
          : queue.next());
        first = false;
        const params = message.params ?? {};
        if (params.turnId && params.turnId !== turnId) continue;
        if (message.method === "turn/completed") {
          if (params.turn?.id !== turnId) continue;
          for (const item of params.turn.items ?? []) {
            for (const chunk of this.completeItem(item, state)) yield chunk;
          }
          completedTurn = params.turn;
          break;
        }
        if (isToolParked(message)) {
          batch = [message.params, ...drainParkedToolCalls(queue, turnId)];
          break;
        }
        for (const chunk of this.projectActivity(message, state)) yield chunk;
      }

      for (const chunk of closeOpenBlocks(state)) yield chunk;

      // The protocol wants usage before the terminal finish. One Claude query
      // spans every step of a turn, so its result - and this chunk - arrive
      // once, on the last step, already totalled.
      if (completedTurn?.usage) yield { type: "usage", usage: completedTurn.usage };

      if (batch) {
        const calls = batch.map(parked => ({
          id: parked.parkId,
          name: parked.name,
          arguments: JSON.stringify(parked.arguments ?? {}),
        }));
        for (const call of calls) {
          const index = state.nextIndex++;
          yield { type: "block-start", index, blockType: "tool-call" };
          yield { type: "tool-call-delta", index, id: call.id, name: call.name, argumentsDelta: call.arguments };
          yield { type: "block-end", index, block: { type: "tool-call", id: call.id, name: call.name, arguments: call.arguments } };
        }
        this.suspended.set(sessionId, { claudeSessionId, turnId, calls: calls.map(call => call.id) });
        debugLog("handoff", { sessionId, turnId, calls: calls.map(call => ({ id: call.id, name: call.name })) });
        yield { type: "finish", reason: { kind: "tool-calls" } };
        return;
      }

      this.suspended.delete(sessionId);
      if (completedTurn.status === "failed") {
        yield {
          type: "finish",
          reason: { kind: "error", failure: { message: completedTurn.error?.message ?? "Claude turn failed", code: "CLAUDE_TURN_FAILED" } },
        };
      } else {
        this.seen.set(sessionId, options.messages.length);
        this.persistLink(sessionId);
        debugLog("finish", { sessionId, turnId, kind: "stop" });
        yield { type: "finish", reason: { kind: "stop" }, replayState: { claudeSessionId, turnId } };
      }
    } catch (error) {
      debugLog("turn/error", { sessionId, turnId, aborted: Boolean(options.signal?.aborted), message: String(error?.message ?? error) });
      if (options.signal?.aborted) {
        if (turnId) await this.abandonTurn(sessionId, { claudeSessionId, turnId });
        yield { type: "finish", reason: { kind: "aborted", failure: { message: "Claude turn cancelled", code: "ABORTED" } } };
        return;
      }
      this.suspended.delete(sessionId);
      throw error;
    } finally {
      stopActivity();
      queue.close();
    }
  }

  /** Release a Claude turn nobody is going to finish, and unpark its tool calls. */
  async abandonTurn(sessionId, { claudeSessionId, turnId }) {
    this.suspended.delete(sessionId);
    this.runtime.rejectAllToolCalls?.(new Error("The DSH turn was abandoned before the tool result arrived"));
    if (turnId) await this.runtime.interruptTurn(claudeSessionId, turnId).catch(() => {});
  }

  async *streamAuxiliary(options) {
    await this.telemetry.enforce();
    await this.ready;
    const text = auxiliaryInput(options.messages);
    if (!text) throw new Error(`Relay Claude adapter received no ${options.purpose} input`);
    const sessionId = String(options.sessionId ?? "");
    const agent = this.agents.get(sessionId);
    const cwd = agent?.session.header.cwd ?? this.settings.get(sessionId)?.cwd ?? process.cwd();
    const created = await this.runtime.createSession({
      model: options.model,
      effort: options.reasoningEffort,
      sandbox: "read-only",
      approvalPolicy: "never",
      cwd,
      ephemeral: true,
      settingSources: [],
      systemPrompt: options.system,
    });
    const claudeSessionId = created.id;
    const queue = new ActivityQueue(options.signal, "Claude");
    const onActivity = (message) => {
      const candidate = message.params?.sessionId ?? message.params?.session?.id;
      if (candidate === claudeSessionId) queue.push(message);
    };
    const stopActivity = subscribeRuntimeActivity(this.runtime, onActivity);
    let turnId = null;
    try {
      const started = await this.runtime.sendMessage(claudeSessionId, {
        text,
        model: options.model,
        effort: options.reasoningEffort,
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      turnId = started.id;
      const state = createStreamState();
      let completedTurn = null;
      while (!completedTurn) {
        const message = await queue.next();
        const params = message.params ?? {};
        if (params.turnId && params.turnId !== turnId) continue;
        if (message.method === "turn/completed") {
          if (params.turn?.id !== turnId) continue;
          for (const item of params.turn.items ?? []) {
            for (const chunk of completeAuxiliaryItem(state, item)) yield chunk;
          }
          completedTurn = params.turn;
          break;
        }
        for (const chunk of projectAuxiliaryActivity(message, state)) yield chunk;
      }
      for (const block of state.blocks.values()) {
        if (block.closed) continue;
        block.closed = true;
        yield { type: "block-end", index: block.index, block: { type: block.type, text: block.text } };
      }
      yield completedTurn.status === "failed"
        ? { type: "finish", reason: { kind: "error", failure: { message: completedTurn.error?.message ?? `Claude ${options.purpose} failed`, code: "CLAUDE_AUXILIARY_FAILED" } } }
        : { type: "finish", reason: { kind: "stop" } };
    } finally {
      stopActivity();
      queue.close();
      await this.runtime.releaseSession(claudeSessionId);
    }
  }

  /**
   * DSH owns the conversation; the Claude session only knows the turns it
   * answered. When the session is new, or when other models answered turns in
   * between, prepend those turns so a mid-session model switch does not drop
   * context.
   */
  seedPrompt(sessionId, messages, instruction, text) {
    const key = String(sessionId);
    const seen = this.seen.get(key) ?? 0;
    const context = messages
      .map((message, index) => ({ message, index }))
      .filter(entry => entry.index >= seen && entry.index !== instruction)
      .map(entry => {
        const body = seedText(entry.message);
        return body ? `${entry.message.role ?? "user"}: ${body}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    if (!context) return text;
    return [
      "<dsh-context>",
      "Context from the DeepSeek Harness session: workspace instructions, runtime snapshots, and any turns answered by another model. Background only — the request to act on follows this block.",
      context,
      "</dsh-context>",
      "",
      text,
    ].join("\n");
  }

  projectActivity(message, state) {
    const params = message.params ?? {};
    if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
      return textDelta(state, params.itemId, "reasoning", params.delta ?? "");
    }
    if (message.method === "item/agentMessage/delta") {
      return textDelta(state, params.itemId, "text", params.delta ?? "");
    }
    if (message.method === "item/completed") return this.completeItem(params.item, state);
    return [];
  }

  completeItem(item, state) {
    if (!item?.id || state.completed.has(item.id)) return [];
    state.completed.add(item.id);
    if (item.type === "reasoning") return completeTextItem(state, item.id, "reasoning", reasoningText(item));
    if (item.type === "agentMessage") return completeTextItem(state, item.id, "text", item.text ?? "");
    // Tool items are DSH's to render: it executed them and recorded them in its
    // own trajectory.
    return [];
  }
}

class ActivityQueue {
  constructor(signal, label) {
    this.signal = signal;
    this.label = label;
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }

  push(value) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(value);
    else this.values.push(value);
  }

  next() {
    if (this.values.length) return Promise.resolve(this.values.shift());
    if (this.closed) return Promise.reject(new Error(`${this.label} activity stream closed`));
    if (this.signal?.aborted) return Promise.reject(this.signal.reason ?? new Error("aborted"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      if (this.signal) {
        const abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(this.signal.reason ?? new Error("aborted"));
        };
        this.signal.addEventListener("abort", abort, { once: true });
        waiter.resolve = (value) => {
          this.signal.removeEventListener("abort", abort);
          resolve(value);
        };
      }
    });
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(`${this.label} activity stream closed`));
  }
}

/** A tool call parked by the SDK bridge, waiting for DSH to run it. */
function isToolParked(message) {
  return message.method === "tool/parked" && Boolean(message.params?.parkId);
}

/**
 * Claude can call several tools in one message, and the SDK reports them as
 * separate events emitted in the same tick. Take the siblings already queued so
 * the whole batch reaches DSH as one step, the way DSH's own loop handles a
 * multi-call assistant message.
 */
function drainParkedToolCalls(queue, turnId) {
  const parked = [];
  while (queue.values.length) {
    const next = queue.values[0];
    if (!isToolParked(next)) break;
    if (next.params?.turnId && next.params.turnId !== turnId) break;
    queue.values.shift();
    parked.push(next.params);
  }
  return parked;
}

/** Every tool-result id present, for tracing a mismatch against what was parked. */
function allToolResultIds(messages) {
  const ids = [];
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === "tool-result") ids.push(block.toolCallId);
    }
  }
  return ids;
}

/** The results DSH executed for the calls this turn parked on. */
function toolResultsFor(messages, callIds) {
  const wanted = new Set(callIds);
  const results = [];
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type !== "tool-result" || !wanted.has(block.toolCallId)) continue;
      results.push({ toolCallId: block.toolCallId, content: block.content ?? [], isError: Boolean(block.isError) });
    }
  }
  return results;
}

/** How long a resumed turn may stay silent before it is called a failure. */
function resumeTimeoutMs() {
  const configured = Number.parseInt((process.env.DSH_AGENT_BRIDGE_RESUME_TIMEOUT_MS ?? "").trim(), 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 300_000;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

function closeOpenBlocks(state) {
  const chunks = [];
  for (const block of state.blocks.values()) {
    if (block.closed) continue;
    block.closed = true;
    chunks.push({ type: "block-end", index: block.index, block: { type: block.type, text: block.text } });
  }
  return chunks;
}

function createStreamState() {
  return {
    nextIndex: 0,
    blocks: new Map(),
    completed: new Set(),
    activityItems: new Map(),
    startedActivities: new Set(),
    completedActivities: new Set(),
  };
}

function textDelta(state, id, type, delta) {
  if (!id || !delta) return [];
  let block = state.blocks.get(id);
  const chunks = [];
  if (!block) {
    block = { index: state.nextIndex++, type, text: "", closed: false };
    state.blocks.set(id, block);
    chunks.push({ type: "block-start", index: block.index, blockType: type });
  }
  if (block.closed) return chunks;
  block.text += delta;
  chunks.push({ type: type === "reasoning" ? "reasoning-delta" : "text-delta", index: block.index, text: delta });
  return chunks;
}

function completeTextItem(state, id, type, completeText) {
  const chunks = [];
  let block = state.blocks.get(id);
  if (!block) {
    block = { index: state.nextIndex++, type, text: "", closed: false };
    state.blocks.set(id, block);
    chunks.push({ type: "block-start", index: block.index, blockType: type });
  }
  if (completeText && completeText.startsWith(block.text) && completeText.length > block.text.length) {
    const delta = completeText.slice(block.text.length);
    block.text = completeText;
    chunks.push({ type: type === "reasoning" ? "reasoning-delta" : "text-delta", index: block.index, text: delta });
  }
  if (!block.closed) {
    block.closed = true;
    chunks.push({ type: "block-end", index: block.index, block: { type, text: block.text } });
  }
  return chunks;
}

function permissionConfiguration(events) {
  let sandbox = "workspace-write";
  let approvalPolicy = "on-request";
  for (const event of events) {
    if (event.type === "sandbox/mode") sandbox = event.data.mode;
    if (event.type === "approval/policy") approvalPolicy = event.data.policy === "never" ? "never" : "on-request";
    if (event.type === "permission/preset") sandbox = event.data.preset;
  }
  return { sandbox, approvalPolicy };
}

function reasoningText(item) {
  return [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join("\n\n");
}

function summarizeValue(value) {
  if (value === undefined || value === null) return "";
  return firstLine(typeof value === "string" ? value : JSON.stringify(value));
}

function firstLine(value) {
  return String(value ?? "").split("\n")[0].slice(0, 240);
}

function humanize(value) {
  return String(value).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, letter => letter.toUpperCase());
}

function reasoningEffortName(value) {
  return String(value) === "xhigh" ? "Extra high" : humanize(value);
}

/**
 * DSH splices its own context messages (workspace instructions, runtime
 * snapshots, the skill catalog) *after* the human's message inside the same
 * turn, so the instruction is not the last entry. Find the human's message and
 * let everything else travel as context.
 */
function latestUserIndex(messages) {
  let fallback = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user" || !messageText(message)) continue;
    if (message.source?.kind === "user") return index;
    if (fallback === -1) fallback = index;
  }
  return fallback;
}

/**
 * Render one message for the catch-up block.
 *
 * Unlike {@link messageText} this keeps the tool work, because a turn answered
 * by another model is mostly tool calls and their results — carrying only the
 * prose would hand Claude a summary of work it cannot see. Results are bounded:
 * this is context, not a transcript.
 */
function seedText(message) {
  const parts = [];
  for (const block of message?.content ?? []) {
    if (block?.type === "text" && block.text?.trim()) parts.push(block.text.trim());
    if (block?.type === "tool-call") parts.push(`called ${block.name}(${bound(block.arguments, 400)})`);
    if (block?.type === "tool-result") {
      const text = (block.content ?? [])
        .filter(inner => inner?.type === "text")
        .map(inner => inner.text)
        .join("\n")
        .trim();
      if (text) parts.push(`${block.isError ? "tool failed" : "tool result"}: ${bound(text, 1500)}`);
    }
  }
  return parts.join("\n").trim();
}

function bound(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function messageText(message) {
  return (message?.content ?? [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
    .trim();
}

function auxiliaryInput(messages) {
  return messages.map((message) => {
    const text = (message?.content ?? [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim();
    return text ? `${message.role ?? "user"}: ${text}` : "";
  }).filter(Boolean).join("\n\n");
}

function projectAuxiliaryActivity(message, state) {
  const params = message.params ?? {};
  if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
    return textDelta(state, params.itemId, "reasoning", params.delta ?? "");
  }
  if (message.method === "item/agentMessage/delta") return textDelta(state, params.itemId, "text", params.delta ?? "");
  if (message.method === "item/completed") return completeAuxiliaryItem(state, params.item);
  return [];
}

function completeAuxiliaryItem(state, item) {
  if (!item?.id || state.completed.has(item.id)) return [];
  state.completed.add(item.id);
  if (item.type === "reasoning") return completeTextItem(state, item.id, "reasoning", reasoningText(item));
  if (item.type === "agentMessage") return completeTextItem(state, item.id, "text", item.text ?? "");
  return [];
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function runtimeModels(runtime) {
  return typeof runtime.listModels === "function" ? runtime.listModels() : [...runtime.models];
}

function hasRuntimeSession(runtime, sessionId) {
  return typeof runtime.hasSession === "function"
    ? runtime.hasSession(sessionId)
    : runtime.sessions.has(sessionId);
}

function patchRuntimeSession(runtime, sessionId, patch) {
  if (typeof runtime.patchSession === "function") return runtime.patchSession(sessionId, patch);
  const session = runtime.sessions.get(sessionId);
  if (session) Object.assign(session, patch);
  return Boolean(session);
}

function subscribeRuntimeActivity(runtime, listener) {
  if (typeof runtime.subscribeActivity === "function") return runtime.subscribeActivity(listener);
  runtime.on("activity", listener);
  return () => runtime.off("activity", listener);
}

