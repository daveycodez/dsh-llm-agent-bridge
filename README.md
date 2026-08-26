# `dsh-llm-agent-bridge`

Brings vendor agent SDKs into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
as selectable LLM providers. Today that is **Claude**, served through Anthropic's
official [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk).

Pick it from the model dropdown in **any** DSH mode — Standard, PTC, Creator,
Minimal, or your own preset. DSH keeps its prompt, its tools, its approvals and
its conversation history; Claude does the thinking.

## How it works

DSH's LLM service routes a call to whichever adapter owns `options.provider`.
This plugin registers one adapter under the provider id `claude`, and
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
4. **Hands tool calls back to DSH to execute.** The MCP handler does no work: it
   parks, announces the call, and the adapter emits it as a DSH `tool-call`
   chunk with a `tool-calls` finish. DSH's own agent loop then runs the tool
   under its sandbox and approval policy, records `tool/call` and `tool/result`
   in its trajectory, opens the next step, and calls back with the result —
   which resumes the same Claude query rather than starting a new one.
   The bridged tools *are* listed in `allowedTools`, which pre-approves them at
   the SDK layer on purpose: they run through DSH's tool runtime, which resolves
   "ask" decisions through its own approval seam against the session's sandbox
   policy. Gating at the SDK layer as well would prompt on every call regardless
   of that policy — workspace-write included — which is not how DSH treats its
   own agent's calls.
5. Projects Claude's reasoning and text into DSH's native stream chunk
   vocabulary, so the conversation renders like any other model's, and reports
   the turn's token usage and the model's context window so DSH's own counters —
   input, output, cache-hit rate, tokens/sec, context pressure — work for Claude
   rows exactly as they do for its own. Usage arrives once per turn, on its last
   step, since one Claude query spans every step of that turn. The plugin
   contributes no client bundle and no renderer of its own: tool work is DSH's
   to display, from its own trajectory.

Claude still decides what to call and when; DSH executes. One DSH step per model
call, exactly as with DSH's own models — which is what puts Claude's tool calls
in the trajectory and keeps the conversation history shared between providers.

## Install

```bash
npx @deepseek-ai/dsh plugin --profile web add github:daveycodez/dsh-llm-agent-bridge#main
npx @deepseek-ai/dsh web
```

Authenticate Claude Code normally first (`claude`, then sign in). This plugin
never sees your credentials — see below.

## Plan usage in the composer

A usage ring sits in the composer's tool row while a Claude row is selected,
reporting the subscription limit that matters for the current model and opening
a panel of every reported window:

```
Plan usage limits · Max
  5-hour limit          Resets in 1 hr 8 min    10%
  Weekly · all models   Resets in 19 hr 18 min  81%
  Weekly · Fable        Resets in 19 hr 18 min  100%
```

The numbers come from the Agent SDK's own usage reporting — the same source as
Claude Code's `/usage` — served to the browser over this plugin's `/agent-bridge`
channel. No credential is read and no other plugin is required.

Reading them costs a Claude Code control session, so the answer is cached on the
host and again in the browser, with no idle polling: the ring revalidates when
you interact with it or while a turn runs, never on a timer. The underlying SDK
method is explicitly experimental, so a failure to read leaves the ring hidden
rather than failing anything.

## Switching models mid-session

The Claude session only knows the turns it answered. When it is created, or when
another model answered turns while it was deselected, the adapter prepends those
turns as a `<dsh-context>` block so switching providers mid-session does
not silently drop context.

Tool calls and their results live in DSH's own message history, so a later
DeepSeek turn sees the actual work rather than a prose summary.

One known limit: **DSH-side rewrites are not replayed.** If DSH compacts or edits
earlier turns after Claude has seen them, the Claude session keeps the original.

## DSH's session telemetry

`@deepseek-ai/dsh-base` mounts an OTLP exporter aimed at
`harness-telemetry.deepseeksvc.com`. It is off by default, but when it is on,
DSH's own note on the row says uploads carry session-log records "with no
session-telemetry/record redaction rule, so exports are the raw captured copy" —
and with this plugin installed, that copy contains Claude's output.

**The plugin turns a live exporter off at load — before any Claude turn is
possible** — and says so in the log:
it drains the pipeline through the backend's own `shutdown()`, then unmounts the
row so capture stops as well. Reading the mounted backend is exact — it sees the
exporter whatever switched it on, which a scan of environment and config layers
cannot promise.

Afterwards it re-reads the host rather than trusting its own teardown, and if an
exporter survived, the turn fails instead. `disable` degrades to `refuse` rather
than reporting a success it cannot verify. The test suite mounts the real
`dsh-session-telemetry-otel` backend in `FULL` against a loopback collector and
asserts both that the row is gone from the host and that nothing reached the
collector.

What this does not cover: an exporter some other plugin adds. It runs before the
adapter is registered, so nothing Claude produced can have been captured or
queued beforehand — but it reaches the row DSH ships, not an arbitrary one.
Setting `DSH_TELEMETRY_DISABLED=1` in the launching shell prevents the exporter
from ever being constructed, which is strictly better if you control the
environment.

Configure the behaviour on the plugin row if the default does not suit:

```yaml
- id: agent-bridge-llm
  name: 'dsh-llm-agent-bridge'
  config:
    telemetry: disable   # default; `refuse` fails the turn instead, `ignore` skips the guard
```

`refuse` is the choice for anyone who would rather the plugin never touch host
configuration: turns fail with an inline error naming what to switch off.

## Tracing a stalled turn

The handoff spans two `stream()` calls with a live Claude query parked between
them, so a stall has no stack to show. Set `DSH_AGENT_BRIDGE_DEBUG=1` to record
each decision to `$DSH_HOME/plugin-data/agent-bridge-debug.log` (or give it a
path of your own):

```bash
DSH_AGENT_BRIDGE_DEBUG=1 dsh web
```

Each line names the parked call ids and the tool-result ids that came back, so a
mismatch is visible directly. A resumed turn that stays silent fails after five
minutes rather than hanging; `DSH_AGENT_BRIDGE_RESUME_TIMEOUT_MS` overrides that.

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
grep -rnE "credentials\.json|find-generic-password|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|Authorization|api\.anthropic\.com" *.js *.mjs internal
```

### What this does not claim

Running this locally, on your own subscription, signed in through Anthropic's own
flow, matches the carve-out on that page for "an end user signing in to the
unmodified Claude Code binary with their own Claude subscription". Publishing a
plugin whose function is to route Agent SDK traffic through subscription OAuth
is addressed by a different sentence in the same section — developers "should use
API key authentication through Claude Console". Both are true at once, and the
second is advisory rather than prohibitive. Only Anthropic can rule on it; this
README describes what the code does, not what they permit.

An API key resolves the question outright: export `ANTHROPIC_API_KEY` in the
shell that launches DSH and the binary uses it, with no change to this plugin.

Two things that remain your responsibility:

- **Keep DSH bound to localhost.** A DSH instance other people can reach means
  your subscription is serving their requests, which the terms prohibit. DSH
  refuses `--host 0.0.0.0` outright ("it would expose remote code execution to
  the network"), but that guard matches the literal string only — a LAN address
  or `::` still binds, and a tunnel pointed at the web port bypasses it
  entirely. Don't tunnel DSH.
- **Use an API key for unattended workloads.** Subscription limits assume
  "ordinary, individual usage"; batch or scheduled runs belong on a key.
- **Telemetry is turned off for you.** See below — you do not have to configure
  anything, though `DSH_TELEMETRY_DISABLED=1` in the launching shell is still
  the version with no gap at all. `@deepseek-ai/dsh-base` mounts an OTLP exporter
  pointed at `harness-telemetry.deepseeksvc.com`. It defaults to `DISABLED` and
  stays off unless you set `DSH_TELEMETRY_MODE`, but DSH's own note says
  uploading mirrors session-log records "with no session-telemetry/record
  redaction rule, so exports are the raw captured copy." With this plugin
  installed, that raw copy contains Claude's outputs — and Anthropic's Consumer
  Terms prohibit using the Services to develop or train competing models. Don't
  set `DSH_TELEMETRY_MODE`; to opt out irrevocably, set `DSH_TELEMETRY_DISABLED`
  to any non-empty value, which patches the row off entirely.

  Check your own posture:

  ```bash
  env | grep DSH_TELEMETRY; grep -i telemetry "${DSH_HOME:-$HOME/.dsh}/settings.yaml"
  ```

## Credits

Forked from [`relay-dsh-plugin-claude`](https://github.com/yangbobo2021/relay-dsh-plugin-claude)
by yangbobo2021 (MIT), which integrates Claude Code as its own DSH *mode*. This
fork takes the opposite trade: Claude as a *provider* usable from every mode,
with DSH owning the prompt and tools.

MIT.
