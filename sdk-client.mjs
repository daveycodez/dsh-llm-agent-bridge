import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const DEFAULT_MODELS = [
  { id: "sonnet", displayName: "Claude Sonnet", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: reasoningEfforts() },
  { id: "opus", displayName: "Claude Opus", isDefault: false, defaultReasoningEffort: "high", supportedReasoningEfforts: reasoningEfforts() },
  { id: "haiku", displayName: "Claude Haiku", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: reasoningEfforts() },
];

function reasoningEfforts() {
  return ["low", "medium", "high"].map(reasoningEffort => ({ reasoningEffort }));
}

export class ClaudeSdkClient extends EventEmitter {
  constructor({ sdk = null, pathToClaudeCodeExecutable = undefined, requestTimeoutMs = 30 * 60_000 } = {}) {
    super();
    this.sdk = sdk;
    this.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessions = new Map();
    this.queries = new Map();
    this.pendingRequests = new Map();
    this.closed = false;
  }

  async start() {
    this.sdk ??= await import("@anthropic-ai/claude-agent-sdk");
    if (typeof this.sdk.query !== "function") throw new Error("Claude Agent SDK query() is unavailable");
    this.closed = false;
  }

  async listModels() {
    return DEFAULT_MODELS;
  }

  async createSession(config = {}) {
    const id = config.sessionId ?? randomUUID();
    this.sessions.set(id, { id, cwd: config.cwd ?? process.cwd(), created: false, config: structuredClone(config) });
    return { id, cwd: config.cwd ?? process.cwd(), turns: [] };
  }

  async resumeSession(sessionId, config = {}) {
    const existing = this.sessions.get(sessionId) ?? { id: sessionId, created: true, config: {} };
    this.sessions.set(sessionId, {
      ...existing,
      cwd: config.cwd ?? existing.cwd ?? process.cwd(),
      config: { ...existing.config, ...structuredClone(config) },
    });
    return { id: sessionId, cwd: config.cwd ?? existing.cwd ?? process.cwd(), turns: [] };
  }

  async sendMessage(sessionId, message = {}) {
    const session = this.sessions.get(sessionId) ?? (await this.resumeSession(sessionId, message));
    const turnId = randomUUID();
    const abortController = new AbortController();
    const options = this.queryOptions(session, message, abortController);
    const query = this.sdk.query({ prompt: message.text, options });
    this.queries.set(turnId, { query, abortController, sessionId });
    void this.consumeQuery(session, turnId, query).catch((error) => {
      this.emit("diagnostic", `Claude SDK query failed: ${error?.stack ?? error}`);
      this.completeTurn(session.id, turnId, "failed", error);
    });
    session.created = true;
    return { id: turnId, status: "inProgress", items: [] };
  }

  async interruptTurn(_sessionId, turnId) {
    const record = this.queries.get(turnId);
    if (!record) return;
    await record.query.interrupt?.().catch(() => {});
    record.abortController.abort();
    record.query.close?.();
  }

  async releaseSession(sessionId) {
    for (const [turnId, record] of this.queries) {
      if (record.sessionId === sessionId) {
        record.abortController.abort();
        record.query.close?.();
        this.queries.delete(turnId);
      }
    }
    this.sessions.delete(sessionId);
  }

  async close() {
    this.closed = true;
    for (const record of this.queries.values()) {
      record.abortController.abort();
      record.query.close?.();
    }
    this.queries.clear();
    for (const request of this.pendingRequests.values()) {
      request.resolve({ behavior: "deny", message: "Relay Claude SDK client closed" });
    }
    this.pendingRequests.clear();
  }

  resolveRequest(requestId, response = {}) {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) throw new Error(`unknown pending Claude request ${requestId}`);
    this.pendingRequests.delete(String(requestId));
    request.resolve(responseForRequest(request, response));
  }

  rejectRequest(requestId, error) {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) return;
    this.pendingRequests.delete(String(requestId));
    request.resolve({ behavior: "deny", message: error?.message ?? String(error) });
  }

  queryOptions(session, message, abortController) {
    return {
      abortController,
      cwd: message.cwd ?? session.cwd ?? process.cwd(),
      model: message.model ?? session.config?.model,
      effort: message.effort ?? session.config?.effort,
      permissionMode: sdkPermissionMode(message),
      settingSources: message.settingSources ?? session.config?.settingSources ?? ["user", "project", "local"],
      systemPrompt: message.systemPrompt ?? session.config?.systemPrompt,
      pathToClaudeCodeExecutable: this.pathToClaudeCodeExecutable,
      includePartialMessages: true,
      ...(session.created ? { resume: session.id } : { sessionId: session.id }),
      canUseTool: (toolName, input, options) => this.requestPermission(session.id, toolName, input, options),
    };
  }

  requestPermission(sessionId, toolName, input, options = {}) {
    const id = options.requestId ?? randomUUID();
    return new Promise((resolve) => {
      const request = {
        id,
        method: toolName === "AskUserQuestion" ? "tool/requestUserInput" : "tool/requestApproval",
        signal: options.signal,
        params: {
          sessionId,
          toolName,
          input: structuredClone(input ?? {}),
          title: options.title,
          displayName: options.displayName,
          description: options.description,
          decisionReason: options.decisionReason,
          blockedPath: options.blockedPath,
          toolUseID: options.toolUseID,
          suggestions: structuredClone(options.suggestions ?? []),
        },
      };
      this.pendingRequests.set(String(id), { request, resolve, input });
      options.signal?.addEventListener("abort", () => this.rejectRequest(id, new Error("Claude permission request was cancelled")), { once: true });
      this.emit("request", request);
    });
  }

  async consumeQuery(session, turnId, query) {
    const state = { currentMessageId: null, text: new Map(), reasoning: new Map(), activities: new Set() };
    let completed = false;
    try {
      for await (const message of query) {
        for (const event of normalizeSdkMessage(message, state)) {
          this.emit("activity", { method: event.method, params: { sessionId: session.id, turnId, ...event.params } });
        }
        if (message.type === "result") {
          completed = true;
          this.completeTurn(session.id, turnId, message.is_error ? "failed" : "completed", resultError(message));
        }
      }
      if (!completed) this.completeTurn(session.id, turnId, "completed");
    } finally {
      this.queries.delete(turnId);
    }
  }

  completeTurn(sessionId, turnId, status, error = null) {
    this.emit("activity", {
      method: "turn/completed",
      params: {
        sessionId,
        turn: {
          id: turnId,
          status,
          error: error ? { message: error.message } : null,
          items: [],
        },
      },
    });
  }
}

function normalizeSdkMessage(message, state) {
  const events = [];
  if (message.type === "stream_event") {
    const event = message.event;
    if (event?.type === "message_start") {
      state.currentMessageId = event.message?.id ?? message.uuid ?? null;
      return events;
    }
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const itemId = streamItemId(state, "text", event.index);
      state.text.set(itemId, `${state.text.get(itemId) ?? ""}${event.delta.text}`);
      events.push({ method: "item/agentMessage/delta", params: { itemId, delta: event.delta.text } });
    }
    if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
      const itemId = streamItemId(state, "reason", event.index);
      state.reasoning.set(itemId, `${state.reasoning.get(itemId) ?? ""}${event.delta.thinking}`);
      events.push({ method: "item/reasoning/summaryTextDelta", params: { itemId, delta: event.delta.thinking } });
    }
    return events;
  }
  if (message.type === "assistant") {
    const content = message.message?.content ?? [];
    for (const [index, block] of content.entries()) {
      if (block.type === "text" && block.text) {
        const itemId = block.id ?? messageItemId(state.text, message, "text", content, index);
        const previous = state.text.get(itemId) ?? "";
        const delta = block.text.startsWith(previous) ? block.text.slice(previous.length) : block.text;
        state.text.set(itemId, block.text);
        if (delta) events.push({ method: "item/agentMessage/delta", params: { itemId, delta } });
      }
      if (block.type === "thinking" && block.thinking) {
        const itemId = block.id ?? messageItemId(state.reasoning, message, "reason", content, index);
        const previous = state.reasoning.get(itemId) ?? "";
        const delta = block.thinking.startsWith(previous) ? block.thinking.slice(previous.length) : block.thinking;
        state.reasoning.set(itemId, block.thinking);
        if (delta) events.push({ method: "item/reasoning/summaryTextDelta", params: { itemId, delta } });
      }
      if (block.type === "tool_use") {
        const item = { type: "toolUse", id: block.id, name: block.name, input: block.input, status: "inProgress" };
        if (!state.activities.has(item.id)) {
          state.activities.add(item.id);
          events.push({ method: "item/started", params: { item } });
        }
      }
    }
  }
  if (message.type === "user") {
    for (const block of message.message?.content ?? []) {
      if (block.type !== "tool_result") continue;
      events.push({
        method: "item/completed",
        params: {
          item: {
            type: "toolUse",
            id: block.tool_use_id,
            output: block.content,
            status: block.is_error ? "failed" : "completed",
          },
        },
      });
    }
  }
  if (message.type === "system" && message.subtype === "permission_denied") {
    events.push({
      method: "item/completed",
      params: {
        item: {
          type: "toolUse",
          id: message.tool_use_id,
          name: message.tool_name,
          output: message.message,
          status: "failed",
        },
      },
    });
  }
  return events;
}

function streamItemId(state, type, index) {
  return `${state.currentMessageId ?? "message"}-${type}-${index ?? 0}`;
}

function messageItemId(items, message, type, content, index) {
  const prefix = `${message.message?.id ?? message.uuid ?? "message"}-${type}-`;
  const ordinal = content.slice(0, index).filter(block => block.type === (type === "reason" ? "thinking" : type)).length;
  const existing = [...items.keys()]
    .filter(itemId => itemId.startsWith(prefix))
    .sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)));
  return existing[ordinal] ?? `${prefix}${index}`;
}

function responseForRequest(pending, response) {
  if (response.action === "accept" || response.action === "allow") {
    return { behavior: "allow", updatedInput: response.updatedInput ?? pending.input };
  }
  if (response.action === "answer") {
    return { behavior: "allow", updatedInput: { ...pending.input, answers: response.answers ?? {} } };
  }
  return { behavior: "deny", message: response.message ?? "User declined this Claude tool request" };
}

function resultError(message) {
  if (!message?.is_error) return null;
  return new Error(message.errors?.join("\n") || message.subtype || "Claude SDK turn failed");
}

function sdkPermissionMode(message) {
  if (message.permissionMode) return message.permissionMode;
  if (message.approvalPolicy === "never") return "dontAsk";
  if (message.sandbox === "read-only") return "plan";
  return "default";
}
