window.__ModuleLoader__.load({
	id: "@relay/plugin-claude",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region \0relay-css-module:/Users/boboyang/work/Relay/integrations/claude/src/client/ClaudeActivityView.module.css.mjs
		const css = ".La7zLW_activity{width:min(100%,960px);color:var(--dsw-alias-label-secondary)}.La7zLW_summary{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;align-items:center;gap:8px;font-size:13px;display:flex}.La7zLW_summary :first-child{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.La7zLW_detail{border-left:1px solid var(--dsw-alias-border-l2);margin:4px 0 8px 28px;padding-left:12px;overflow:hidden}.La7zLW_detail pre{max-height:320px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;word-break:break-word;margin:0 0 8px;overflow:auto}.La7zLW_provenance{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;margin-bottom:8px;font-size:12px;line-height:18px;overflow:hidden}";
		const tagId = "@relay/plugin-claude/ClaudeActivityView.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@relay/plugin-claude";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var ClaudeActivityView_module_css_default = {
			"detail": "La7zLW_detail",
			"provenance": "La7zLW_provenance",
			"summary": "La7zLW_summary",
			"activity": "La7zLW_activity"
		};
		//#endregion
		//#region src/client/ClaudeActivityView.tsx
		function dotState(status) {
			if (status === "running") return "ongoing";
			if (status === "error") return "error";
			return "done";
		}
		const ClaudeActivityView = (0, react.memo)(function ClaudeActivityView({ node }) {
			const activity = node.data;
			const [open, setOpen] = (0, react.useState)(false);
			const expandable = activity.input !== void 0 || activity.output !== void 0 || activity.provenance !== void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: ClaudeActivityView_module_css_default.activity,
				"data-claude-activity": activity.type,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.DisclosureRow, {
					icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCodeOutline16, {}),
					title: activity.title,
					open,
					expandable,
					onToggle: () => {
						setOpen((value) => !value);
					},
					expandOnRowClick: true,
					collapsedContent: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: ClaudeActivityView_module_css_default.summary,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: activity.summary }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
							state: dotState(activity.status),
							size: 8
						})]
					}),
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: ClaudeActivityView_module_css_default.detail,
						children: [
							activity.provenance !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: ClaudeActivityView_module_css_default.provenance,
								title: `Claude Code · Session ${activity.provenance.claudeSessionId} · Turn ${activity.provenance.turnId}`,
								children: [
									"Claude Code · Session ",
									shortId(activity.provenance.claudeSessionId),
									" · Turn ",
									shortId(activity.provenance.turnId)
								]
							}) : null,
							activity.input !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: activity.input }) : null,
							activity.output !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", { children: activity.output }) : null
						]
					})
				})
			});
		});
		function shortId(value) {
			return value.length > 15 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
		}
		//#endregion
		//#region src/client/claude-activity.ts
		const claudeActivityDefinition = {
			kind: "relay-claude-activity",
			target: "chat",
			match: (event) => event.type === "relay-claude/activity" ? {
				id: event.data.itemId,
				role: event.data.phase === "started" ? "start" : "update"
			} : null,
			start: (_context, match) => {
				if (match.event.type !== "relay-claude/activity") throw new Error("Claude activity start requires relay-claude/activity");
				return {
					...match.event.data.activity,
					provenance: {
						claudeSessionId: match.event.data.claudeSessionId,
						turnId: match.event.data.turnId
					}
				};
			},
			update: (context, match) => match.event.type === "relay-claude/activity" ? {
				...match.event.data.activity,
				provenance: {
					claudeSessionId: match.event.data.claudeSessionId,
					turnId: match.event.data.turnId
				}
			} : context.state,
			buildViewNode: (context) => {
				if (context.start === void 0 || context.state === void 0) return null;
				return {
					key: context.key,
					kind: "relay-claude-activity",
					id: context.id,
					target: "chat",
					anchorSeq: context.start.event.seq,
					location: context.start.location,
					visibility: "visible",
					data: context.state
				};
			}
		};
		//#endregion
		//#region src/client/index.ts
		const inject = [
			"slots",
			"theme",
			"locale",
			"remote",
			"sessions",
			"connection",
			"conversationEvents"
		];
		async function apply(ctx) {
			ctx.conversationEvents.register(claudeActivityDefinition);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "relay-claude-activity"
			}, ClaudeActivityView));
			const unsubscribe = installModelSelection(ctx);
			return async () => {
				unsubscribe();
			};
		}
		function installModelSelection(ctx) {
			const connection = ctx.get("connection");
			const selecting = /* @__PURE__ */ new Set();
			const sync = () => {
				const list = ctx.sessions.list.getSnapshot();
				const id = list.current;
				if (id === void 0 || list.byId[id]?.blank !== true || selecting.has(id)) return;
				const preset = list.byId[id]?.agentPreset;
				if (preset === "relay-codex") return;
				selecting.add(id);
				connection.api.sessions.models({ sessionId: id }).then(async (response) => {
					const { result } = response;
					if (!result.ok) return;
					const target = preset === "relay-claude" ? result.value.groups.find((group) => group.id === "relay-claude") : result.value.current.provider === "relay-claude" ? result.value.groups.find((group) => group.id !== "relay-claude" && group.id !== "relay-codex") : void 0;
					const model = target?.models[0];
					if (target && model) await connection.api.sessions.selectModel({
						sessionId: id,
						provider: target.id,
						model: model.id,
						...model.reasoning?.defaultEffort ? { reasoningEffort: model.reasoning.defaultEffort } : {}
					});
				}).catch(() => {}).finally(() => {
					selecting.delete(id);
				});
			};
			const off = ctx.sessions.list.subscribe(sync);
			sync();
			return off;
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map