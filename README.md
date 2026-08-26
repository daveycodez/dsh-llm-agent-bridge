# `dsh-llm-claude-agent-sdk`

Adds **Claude** to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
as a selectable LLM provider, served through Anthropic's official
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

Pick it from the model dropdown in **any** DSH mode — Standard, PTC, Creator,
Minimal, or your own preset. DSH keeps its prompt, its tools, its approvals and
its conversation history; Claude does the thinking.

## How it works

DSH's LLM service routes a call to whichever adapter owns `options.provider`.
This plugin registers one adapter under the provider id `claude-agent-sdk`, and
that adapter:

1. Creates (or resumes) a Claude Agent SDK session keyed to the DSH session.
2. Passes **DSH's** assembled system prompt through as the SDK's `systemPrompt`,
   with `settingSources: []` so no `~/.claude` settings, `CLAUDE.md`, skills, or
   hooks load on top of it.
3. Hands DSH's tools to Claude as an in-process MCP server (`mcp__dsh__*`) and
   passes `tools: []` so Claude Code's own built-ins are removed from context —
   `allowedTools` alone only pre-approves, it does not scope, and the built-ins
   would win. `toolAliases` redirects built-in names at the DSH tool of the same
   name, since DSH's prompt refers to its tools bare ("use the read tool").
   Claude's permission requests surface as DSH's own approval prompts: the
   bridged tools are deliberately *not* listed in `allowedTools` unless DSH's
   policy is never-ask, because a bare `allowedTools` entry auto-approves the
   tool before `canUseTool` runs and would silently bypass the prompt.
4. Projects Claude's reasoning, text, and tool activity into DSH's native stream
   chunk vocabulary, so the conversation renders like any other model's.

Claude keeps its own agent loop *within* a DSH turn: it calls a tool, reads the
result, decides again, and returns one answer. DSH's own loop sits out.

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add dsh-llm-claude-agent-sdk
npx @deepseek-ai/dsh web
```

Authenticate Claude Code normally first (`claude`, then sign in). This plugin
never sees your credentials — see below.

## Switching models mid-session

The Claude session only knows the turns it answered. When it is created, or when
another model answered turns while it was deselected, the adapter prepends those
turns as a `<dsh-session-history>` block so switching providers mid-session does
not silently drop context.

Two known limits:

- **Tool work is not shared history.** Claude's tool calls render in the DSH
  conversation as activity events, but are not written into the message history
  other models read. A later DeepSeek turn sees Claude's prose, not the
  individual edits.
- **DSH-side rewrites are not replayed.** If DSH compacts or edits earlier turns
  after Claude has seen them, the Claude session keeps the original.

## Anthropic terms compliance

This plugin uses your Claude subscription the way Anthropic's
[legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
requires: it never collects, stores, or intermediates your credentials.

- The **only** route to Anthropic is `await import("@anthropic-ai/claude-agent-sdk")`
  — the official SDK, which runs the published Claude Code binary. That binary
  performs its own authentication and token refresh, exactly as when you run
  `claude` yourself.
- No source file reads `~/.claude/.credentials.json`, the macOS Keychain,
  `CLAUDE_CODE_OAUTH_TOKEN`, or any API-key environment variable.
- No source file constructs an `Authorization` header or calls
  `api.anthropic.com` directly.
- The CLI fallback spawns `claude` with this process's environment and nothing
  else: there is no per-turn env override, so no caller can inject
  `ANTHROPIC_BASE_URL` or an API key into the binary that holds your login.

Verify it yourself:

```bash
grep -rnE "credentials\.json|find-generic-password|CLAUDE_CODE_OAUTH_TOKEN|Authorization|api\.anthropic\.com" *.js *.mjs src internal
```

Two things that remain your responsibility:

- **Keep DSH bound to localhost.** A DSH instance other people can reach means
  your subscription is serving their requests, which the terms prohibit. DSH
  refuses `--host 0.0.0.0` outright ("it would expose remote code execution to
  the network"), but that guard matches the literal string only — a LAN address
  or `::` still binds, and a tunnel pointed at the web port bypasses it
  entirely. Don't tunnel DSH.
- **Use an API key for unattended workloads.** Subscription limits assume
  "ordinary, individual usage"; batch or scheduled runs belong on a key.

## Credits

Forked from [`relay-dsh-plugin-claude`](https://github.com/yangbobo2021/relay-dsh-plugin-claude)
by yangbobo2021 (MIT), which integrates Claude Code as its own DSH *mode*. This
fork takes the opposite trade: Claude as a *provider* usable from every mode,
with DSH owning the prompt and tools.

MIT.
