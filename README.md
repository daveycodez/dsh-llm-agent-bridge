# Relay Claude Plugin

`@relay/plugin-claude` adds a Claude Code conversation mode to DeepSeek Harness.
One DSH Session owns one Claude Agent SDK session, including model and reasoning
selection, approvals, questions, tool activity, interruption, and continuation.

The package has no dependency on Relay Events or any other Relay plugin. The Claude
Agent SDK is a normal npm dependency and is installed with the package; users still
authenticate with Claude normally.

Tools contributed by separately installed DSH plugins are mapped generically to an
in-process Claude SDK MCP server and execute through the owning Agent's DSH tool
runtime. This bridge requires the default SDK backend; explicit CLI fallback refuses
contributed tools instead of silently dropping them.

```bash
dsh plugin --profile web add @relay/plugin-claude
```

Build and verify from Relay:

```bash
npm run prepare:dsh
npm --workspace @relay/plugin-claude run typecheck
npm --workspace @relay/plugin-claude run build
npm run test:install:dsh-official
```
