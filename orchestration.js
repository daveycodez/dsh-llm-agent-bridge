/**
 * Orchestration policy for the harness's own workflow tool.
 *
 * DSH ships `workflow` — a tool that runs a script fanning work out across many
 * subagents — and this plugin bridges it like any other tool. Claude Code gates
 * its own equivalent behind an explicit opt-in, because a fan-out can spawn
 * dozens of agents and spend accordingly. DSH's tool carries no such gate, and
 * a plain xhigh turn was observed calling it twice on an ordinary audit
 * request, so the gate is supplied here.
 *
 * The wording mirrors Claude Code's own policy for the same reason the models
 * follow it there: it states the cost, defines what counts as opting in, and
 * says plainly what to do instead. Two halves, matching that structure —
 *
 * - by default, orchestration must be asked for rather than inferred;
 * - under the Ultracode effort, the opt-in is standing.
 *
 * Both are appended to the harness's own system prompt; neither replaces any
 * part of it.
 */

/** The effort id that turns standing orchestration on. */
export const ULTRACODE_EFFORT = "ultracode";

/** What the SDK is actually asked for when Ultracode is selected. */
export const ULTRACODE_BASE_EFFORT = "xhigh";

/** The harness tools this policy governs. */
const WORKFLOW_TOOL = "mcp__dsh__workflow";
const SUBAGENT_TOOL = "mcp__dsh__subagent";

/** Advisory ceiling, matching the default guideline Claude Code carries. */
const SIZE_GUIDELINE = "Keep workflows under 15 agents unless the user's prompt calls for a different scale. This is a guideline, not a hard limit.";

const GATED = [
  `ONLY call ${WORKFLOW_TOOL} when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:`,
  "",
  `- The user selected the Ultracode effort for this session's model.`,
  `- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.`,
  `- The user invoked a skill or command whose instructions tell you to run one.`,
  "",
  `For any other task — even one that would clearly benefit from parallelism — do NOT call it. Use ${SUBAGENT_TOOL} for an individual subagent, or briefly describe what a multi-agent workflow could do and roughly what it would cost, and ask the user whether to run it. Mention that selecting the Ultracode effort opts in for the rest of the session.`,
  "",
  SIZE_GUIDELINE,
].join("\n");

const STANDING = [
  `The user selected the Ultracode effort, so the opt-in to multi-agent orchestration is standing: author and run a workflow through ${WORKFLOW_TOOL} for every substantive task by default. The goal is the most exhaustive, correct answer you can produce — token cost is not a constraint.`,
  "",
  `For multi-phase work (understand → design → implement → review), that often means several workflows in sequence, one per phase, so the user stays in the loop between them. Decompose the work, fan it out across subagents, and verify findings adversarially before reporting them. Solo only on conversational turns and trivial mechanical edits.`,
  "",
  SIZE_GUIDELINE,
].join("\n");

/** Whether the harness offered a workflow tool for this turn. */
export function hasWorkflowTool(tools) {
  return (tools ?? []).some(tool => tool?.name === "workflow");
}

/**
 * The policy paragraph for one turn, or null when there is nothing to govern.
 *
 * @param tools - the harness tools offered this turn.
 * @param ultracode - whether the Ultracode effort is selected.
 */
export function orchestrationPolicy(tools, ultracode) {
  if (!hasWorkflowTool(tools)) return null;
  return ultracode ? STANDING : GATED;
}

/** Append the policy to the harness's own prompt, leaving it otherwise intact. */
export function withOrchestrationPolicy(systemPrompt, policy) {
  if (!policy) return systemPrompt;
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) return policy;
  return `${systemPrompt}\n\n${policy}`;
}
