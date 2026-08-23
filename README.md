# Relay Claude Plugin for DeepSeek Harness

Run native Claude Code conversations inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Each DSH Session owns one Claude Agent SDK session, so Claude keeps its own model
context and execution lifecycle while DSH provides the conversation UI.

This repository is developed as part of [Relay](https://github.com/yangbobo2021/Relay),
an open-source project for long-running agent work, external events, DSH
integrations, and composable agent backends. The plugin is independently
installable: using it does not require the Relay application or any other Relay
plugin.

## What It Adds

- A **Claude Code** choice on DSH's native New Session screen.
- One durable Claude Agent SDK session for each Claude-backed DSH Session.
- Model and reasoning selection.
- Approval and user-question flows in the DSH conversation.
- Tool activity, interruption, and session continuation.
- Generic access to tools contributed by other installed DSH plugins.

DSH tools are exposed to Claude through an in-process Claude SDK MCP server and
execute through the owning Agent's DSH tool runtime. This bridge uses the default
SDK backend. An explicitly selected CLI fallback refuses contributed tools instead
of silently dropping them.

## Requirements

- Node.js 22.13 or newer.
- A current DeepSeek Harness installation with the `web` profile.
- `pnpm` on `PATH`, as required by DSH plugin management.
- A Claude account authenticated for local Claude Code use.

The Claude Agent SDK is a normal package dependency and is installed with the
plugin. Authentication remains owned by the user and Claude Code.

## Install

The plugin can be installed directly from GitHub today:

```bash
dsh plugin --profile web add github:yangbobo2021/relay-dsh-plugin-claude
```

Restart the running DSH Web profile after installation. Open **New Session** and
choose **Claude Code**.

The package name is `@relay/dsh-plugin-claude`. After an npm release is available,
the equivalent registry installation is:

```bash
dsh plugin --profile web add @relay/dsh-plugin-claude
```

Remove the plugin and restart the profile with:

```bash
dsh plugin --profile web remove @relay/dsh-plugin-claude
```

## Plugin Boundary

This package owns only the Claude conversation backend and its small native DSH
conversation surfaces. It has no runtime dependency on Relay Events or another
Relay plugin. Installing it does not:

- add Wait, Monitor, callback, or event-routing behavior;
- replace the official DSH layout; or
- install Files or Terminal views.

Those capabilities are optional, independently composed plugins. Relay Events can
be installed when external events should resume conversations, while Relay's
Workbench, Files, and Terminal plugins provide additional DSH Web surfaces. Claude
works without any of them.

## Relationship to Relay

[Relay](https://github.com/yangbobo2021/Relay) is the integration and compatibility
home in which this plugin was designed and validated. Relay combines DSH
conversations with durable waits, monitors, external-event delivery, reusable
workbench views, and multiple agent backends. This repository is kept separate so
Claude users can install only the backend they need and so the plugin can track
official DSH releases without carrying the full Relay runtime.

Explore or star the Relay repository to follow the broader multi-backend DSH and
long-running-agent work: <https://github.com/yangbobo2021/Relay>.

## Development

Clone the plugin, install its development dependencies, and point verification at
an official DSH checkout:

```bash
git clone https://github.com/yangbobo2021/relay-dsh-plugin-claude.git
cd relay-dsh-plugin-claude
npm install
DSH_ROOT=/path/to/deepseek-harness npm run verify
npm pack
```

`npm run verify` runs type checking, tests, and the production build. The plugin's
test suite includes independence and package-boundary checks so an accidental
dependency on Relay or another feature plugin fails validation.

## Status and Feedback

The plugin is under active development. Report integration problems or feature
requests in this repository's [issue tracker](https://github.com/yangbobo2021/relay-dsh-plugin-claude/issues).
