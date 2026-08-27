window.__ModuleLoader__.load({
	id: "dsh-llm-agent-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/effort-accent.ts
		/**
		* Accent for the Ultracode effort, in both places the picker shows it.
		*
		* An adapter can only describe an effort as `{ id, name, description }` — the
		* contract carries no colour, icon or emphasis — and neither the dropdown row
		* nor the composer trigger exposes the effort id in the DOM. The label text is
		* therefore the only handle, exactly as the settings-nav glyph in
		* dsh-plugin-usage-meter found its cell by label.
		*
		* Two targets, two tokens, both referenced as `var(...)` rather than resolved
		* here, so a theme change repaints them without this plugin knowing:
		*
		* - the dropdown row takes `--dsw-alias-button-info-fill`, the solid accent;
		* - the trigger's effort chip — the muted text beside the model name — takes
		*   `--dsw-alias-button-info-hover`, the lighter one, since it sits against the
		*   composer rather than inside a menu.
		*
		* Both are weighted one step above whatever they ship at, read from the
		* computed style rather than hard-coded, so a restyle upstream keeps the
		* relationship instead of the number.
		*
		* The decoration runs after render on the same terms as that nav glyph: inline
		* styles on existing nodes rather than replaced ones, so React's tree is never
		* invalidated; `important`, because the picker's own classes set both
		* properties on these nodes; a marker so re-renders skip them and two installs
		* cannot fight; and a disposer that restores every node it touched. Every
		* failure path leaves the element exactly as shipped.
		*
		* Delete this file if the effort contract ever grows a presentation field, or
		* if either surface starts exposing the effort id — both would be better
		* handles than a label.
		*/
		/** The label the adapter gives the Ultracode effort. */
		const ULTRACODE_LABEL = "Ultracode";
		/** Solid accent, for the row inside the dropdown. */
		const DROPDOWN_COLOR = "var(--dsw-alias-button-info-fill)";
		/** Lighter accent, for the muted effort chip on the composer trigger. */
		const TRIGGER_COLOR = "var(--dsw-alias-button-info-hover)";
		/** How much heavier the accented text sits than its neighbours. */
		const WEIGHT_STEP = 100;
		/** Marks a node this module styled, so re-renders skip it. */
		const PATCHED_FLAG = "agentBridgeUltracode";
		function queryAll(selector) {
			try {
				return typeof document === "undefined" ? [] : [...document.querySelectorAll(selector)];
			} catch {
				return [];
			}
		}
		/**
		* One step above what the element already renders at.
		*
		* The trigger chip inherits its weight rather than declaring one, so the
		* shipped value is read from the computed style; anything unreadable falls back
		* to the 500 the picker's own labels use.
		*/
		function heavierWeight(element) {
			let shipped = 500;
			try {
				const computed = Number.parseInt(window.getComputedStyle(element).fontWeight, 10);
				if (Number.isFinite(computed) && computed > 0) shipped = computed;
			} catch {}
			return String(Math.min(900, shipped + WEIGHT_STEP));
		}
		function paint(element, color, restores) {
			if (element.dataset[PATCHED_FLAG] !== void 0) return;
			const weight = heavierWeight(element);
			restores.push({
				element,
				color: element.style.color,
				fontWeight: element.style.fontWeight
			});
			element.dataset[PATCHED_FLAG] = "true";
			element.style.setProperty("color", color, "important");
			element.style.setProperty("font-weight", weight, "important");
		}
		/**
		* The element holding a row's label: the innermost span whose text is exactly
		* the label, so the colour lands on the node whose own rule would otherwise
		* win, and a row whose name merely contains the word is left alone.
		*/
		function labelElement(row) {
			for (const span of [...row.querySelectorAll("span")]) {
				if (span.querySelector("span") !== null) continue;
				if ((span.textContent ?? "").trim() === ULTRACODE_LABEL) return span;
			}
			return null;
		}
		function decorate(restores) {
			for (const row of queryAll("button[role=\"menuitemradio\"]")) try {
				const element = labelElement(row);
				if (element !== null) paint(element, DROPDOWN_COLOR, restores);
			} catch {}
			for (const chip of queryAll("[class*=\"triggerEffort\"]")) try {
				if ((chip.textContent ?? "").trim() !== ULTRACODE_LABEL) continue;
				paint(chip, TRIGGER_COLOR, restores);
			} catch {}
		}
		/**
		* Start accenting both surfaces, and return a disposer that restores every node
		* it touched.
		*/
		function installEffortAccent() {
			const restores = [];
			const run = () => {
				decorate(restores);
			};
			run();
			let observer;
			try {
				if (typeof MutationObserver !== "undefined" && typeof document !== "undefined" && document.body !== null) {
					observer = new MutationObserver(run);
					observer.observe(document.body, {
						childList: true,
						subtree: true
					});
				}
			} catch {
				observer = void 0;
			}
			return () => {
				try {
					observer?.disconnect();
				} catch {}
				for (const entry of restores) try {
					delete entry.element.dataset[PATCHED_FLAG];
					entry.element.style.removeProperty("color");
					entry.element.style.removeProperty("font-weight");
					if (entry.color) entry.element.style.color = entry.color;
					if (entry.fontWeight) entry.element.style.fontWeight = entry.fontWeight;
				} catch {}
				restores.length = 0;
			};
		}
		//#endregion
		//#region src/client/usage.ts
		/**
		* The shared usage store: one SWR cache for the whole plugin, reading through
		* this plugin's own `/agent-bridge` RPC channel.
		*
		* Two properties drive every design decision here:
		*
		* 1. Each miss costs a Claude Code control session on the host, which is far
		*    heavier than an HTTP call, and the upstream plan endpoint behind it is
		*    rate limited in its own right.
		* 2. The slot renders once per session, so a per-component fetcher would
		*    multiply that cost by the number of open sessions.
		*
		* Hence: one module-level store, one floor governing every caller, no idle
		* polling, and a second cache on the host behind this one.
		*/
		/** Logical RPC channel this plugin's host half serves. */
		const CHANNEL = "/agent-bridge";
		/** Key under which the last good reading is cached across reloads. */
		const CACHE_KEY = "dsh.agent-bridge.plan-usage";
		/** Cadence while a turn is actually running (bounded by the floor). */
		const RUNNING_INTERVAL_MS = 18e4;
		/** First 429 stands down this long; subsequent ones double up to the cap. */
		const BACKOFF_START_MS = 3e5;
		const BACKOFF_MAX_MS = 6e5;
		/** A request that never settles must not wedge the store. */
		const REQUEST_TIMEOUT_MS = 15e3;
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}
		/**
		* Whether a failure is a rate limit. The failure reaches the browser as
		* `{ code: 'internal', message }` — the RPC branch types `details` as an empty
		* object upstream, so nothing structured survives — and the status is
		* recovered from the message text.
		*/
		function isRateLimited(message) {
			return /\b429\b/.test(message) || /rate.?limit/i.test(message);
		}
		/**
		* The delay the provider asked for, when the node half disclosed one.
		*
		* dsh-plugin-subscriptions historically dropped `Retry-After` inside
		* `oauthEndpointError`, so this returned nothing and the caller fell back to a
		* fixed backoff. V1ki/dsh-plugin-subscriptions#41 parses the header and
		* appends a ` (retry-after: 300s)` suffix — the only channel that survives
		* that RPC boundary — so the first pattern below reads the interval the
		* provider actually named. The looser pattern stays for any other phrasing,
		* and an installation without that change simply keeps the fixed backoff.
		*/
		function retryHintMs(message) {
			const match = /retry-after:\s*(\d+)s/i.exec(message) ?? /retry[- ]after["':\s]*(\d+)/i.exec(message);
			if (match === null) return null;
			const seconds = Number(match[1]);
			return Number.isFinite(seconds) && seconds > 0 ? seconds * 1e3 : null;
		}
		function readCache() {
			try {
				const raw = window.localStorage.getItem(CACHE_KEY);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				if (parsed?.usage && Array.isArray(parsed.usage.windows)) return parsed;
			} catch {}
			return null;
		}
		function writeCache(usage, at) {
			try {
				window.localStorage.setItem(CACHE_KEY, JSON.stringify({
					usage,
					at
				}));
			} catch {}
		}
		/**
		* Create the shared store.
		* @param rpc - the connection's RPC caller.
		* @returns the store; call `request()` to revalidate under the floor.
		*/
		function createUsageStore(rpc) {
			const listeners = /* @__PURE__ */ new Set();
			let state = readCache() ?? {
				usage: null,
				at: 0
			};
			let inflight = false;
			let blockedUntil = 0;
			let backoffMs = 0;
			const publish = (next) => {
				state = next;
				for (const fn of [...listeners]) fn(state);
			};
			const request = () => {
				const now = Date.now();
				if (inflight || now < blockedUntil || now - state.at < 18e4) return;
				inflight = true;
				let settled = false;
				const finish = (apply) => {
					if (settled) return;
					settled = true;
					inflight = false;
					clearTimeout(watchdog);
					apply?.();
				};
				const watchdog = setTimeout(() => {
					finish();
				}, REQUEST_TIMEOUT_MS);
				rpc.call(CHANNEL, "usage", {}).then((raw) => {
					const result = raw;
					if (!result.ok) throw new Error(result.error?.message ?? "usage lookup failed");
					finish(() => {
						backoffMs = 0;
						blockedUntil = 0;
						const at = Date.now();
						const usage = result.value;
						writeCache(usage, at);
						publish({
							usage,
							at
						});
					});
				}, (error) => {
					const message = messageOf(error);
					finish(() => {
						if (!isRateLimited(message)) return;
						backoffMs = retryHintMs(message) ?? (backoffMs === 0 ? BACKOFF_START_MS : Math.min(backoffMs * 2, BACKOFF_MAX_MS));
						blockedUntil = Date.now() + backoffMs;
					});
				});
			};
			return {
				get: () => state,
				subscribe(fn) {
					listeners.add(fn);
					return () => {
						listeners.delete(fn);
					};
				},
				request
			};
		}
		/**
		* The window the ring represents: the current model's own weekly limit when
		* the provider scopes one to it, otherwise the shared weekly pool — the two
		* readings a user is actually spending.
		*
		* The scope match is derived rather than hardcoded. An earlier version tested
		* for Fable by name, which would silently fall back to the shared pool the day
		* a limit is scoped to any other model; comparing the reported scope against
		* the model id keeps working as the plan shape changes.
		*
		* Falls back to the most consumed window so the ring still means something on
		* a plan shape this code has not seen.
		*/
		function pickWindow(windows, model) {
			if (windows.length === 0) return null;
			const weekly = windows.filter((w) => w.kind === "weekly");
			if (typeof model === "string") {
				const scoped = weekly.find((w) => typeof w.scope === "string" && w.scope.length > 0 && model.toLowerCase().includes(w.scope.toLowerCase()));
				if (scoped !== void 0) return scoped;
			}
			const overall = weekly.find((w) => w.scope === void 0 || w.scope === "");
			if (overall !== void 0) return overall;
			if (weekly.length > 0) return weekly[0];
			return [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
		}
		//#endregion
		//#region src/client/UsageMeter.module.css.inlined.js
		const css = "/* Chrome mirrors the shipped ContextMeter so the two seats in the composer's\n   trailing row are indistinguishable: a 28x28 round trigger with the\n   interactive hover fill, and a menu-token panel whose children inherit one\n   12/20 type scale. Only ContextMeter's two text tones appear here —\n   label-primary at weight 500 for figures, label-tertiary for muted copy. */\n\n.dsh-ab-root {\n  display: inline-flex;\n  position: relative;\n  /* The model trigger's padding is asymmetric (0 4px 0 8px), so without this\n     the gap on our side of the dropdown reads 27px against the context ring's\n     23px on the other. Cancels exactly that difference. */\n  margin-right: -4px;\n}\n\n.dsh-ab-trigger {\n  width: 28px;\n  height: 28px;\n  padding: 0;\n  border: none;\n  border-radius: 999px;\n  background: none;\n  cursor: pointer;\n  flex: none;\n  display: grid;\n  place-items: center;\n}\n\n.dsh-ab-trigger:hover {\n  background: var(--dsw-alias-interactive-bg-hover);\n}\n\n.dsh-ab-track {\n  fill: none;\n  stroke: var(--dsw-alias-border-l3);\n  stroke-width: 2px;\n}\n\n.dsh-ab-fill {\n  fill: none;\n  stroke-width: 2px;\n  stroke-linecap: round;\n  transition: stroke-dasharray 0.3s ease, stroke 0.3s ease;\n}\n\n/* 320px: the widest row (\"Weekly · all models\" + \"Resets Thu 11:59 AM\" + a\n   percent, plus two 8px gaps) measures ~273px, which clears this content box\n   but not the 238px ContextMeter's 264px would leave. */\n.dsh-ab-panel {\n  position: absolute;\n  right: 0;\n  bottom: calc(100% + 8px);\n  z-index: 100;\n  box-sizing: border-box;\n  width: 320px;\n  max-width: calc(100vw - 32px);\n  padding: 12px;\n  border: 1px solid var(--dsw-alias-border-inverted);\n  border-radius: 12px;\n  background: var(--dsw-specific-menu);\n  box-shadow: var(--dsw-shadow-lv3);\n  color: var(--dsw-alias-label-secondary);\n  font-size: 12px;\n  line-height: 20px;\n  cursor: default;\n}\n\n/* Leading trim. A 12px glyph in a 20px line box carries 4px of half-leading,\n   so without this the caption's ink sits 16px below the top edge while the\n   last bar — a solid block with no leading — sits 12px above the bottom, and\n   the panel reads top-heavy. ContextMeter never needs it because its first\n   and last children are both text. */\n.dsh-ab-caption {\n  margin: -4px 0 10px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.dsh-ab-limit + .dsh-ab-limit {\n  margin-top: 12px;\n}\n\n.dsh-ab-line {\n  display: flex;\n  align-items: baseline;\n  gap: 8px;\n}\n\n.dsh-ab-name {\n  min-width: 0;\n  color: var(--dsw-alias-label-primary);\n  font-weight: 500;\n  white-space: nowrap;\n  overflow: hidden;\n  text-overflow: ellipsis;\n}\n\n.dsh-ab-reset {\n  margin-left: auto;\n  color: var(--dsw-alias-label-tertiary);\n  white-space: nowrap;\n  flex: none;\n}\n\n.dsh-ab-percent {\n  color: var(--dsw-alias-label-primary);\n  font-weight: 500;\n  font-variant-numeric: tabular-nums;\n  white-space: nowrap;\n  flex: none;\n}\n\n/* Percent with no reset phrase beside it still trails the row. */\n.dsh-ab-percentAlone {\n  margin-left: auto;\n}\n\n.dsh-ab-bar {\n  height: 4px;\n  margin-top: 6px;\n  border-radius: 999px;\n  background: var(--dsw-alias-interactive-bg-hover);\n  overflow: hidden;\n}\n\n.dsh-ab-barFill {\n  height: 100%;\n  border-radius: 999px;\n  transition: width 0.3s ease, background-color 0.3s ease;\n}\n\n.dsh-ab-empty {\n  color: var(--dsw-alias-label-tertiary);\n}\n";
		const TAG = "dsh-llm-agent-bridge/UsageMeter.module.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${TAG}"]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-llm-agent-bridge";
			tag.dataset.pluginCss = TAG;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var UsageMeter_module_css_inlined_default = {
			"root": "dsh-ab-root",
			"trigger": "dsh-ab-trigger",
			"track": "dsh-ab-track",
			"fill": "dsh-ab-fill",
			"panel": "dsh-ab-panel",
			"caption": "dsh-ab-caption",
			"limit": "dsh-ab-limit",
			"line": "dsh-ab-line",
			"name": "dsh-ab-name",
			"reset": "dsh-ab-reset",
			"percent": "dsh-ab-percent",
			"percentAlone": "dsh-ab-percentAlone",
			"bar": "dsh-ab-bar",
			"barFill": "dsh-ab-barFill",
			"empty": "dsh-ab-empty"
		};
		/** Clamp a reported percentage into the range the meter can draw. */
		function clampPercent(value) {
			return Math.min(100, Math.max(0, value));
		}
		/**
		* Claude's own row vocabulary, so the panel reads like the product it
		* reports on: "5-hour limit", "Weekly · all models", "Weekly · Fable".
		*/
		function windowLabel(window) {
			if (window.kind === "session") return "5-hour limit";
			if (window.kind === "weekly") return window.scope !== void 0 && window.scope !== "" ? `Weekly · ${window.scope}` : "Weekly · all models";
			return window.scope !== void 0 && window.scope !== "" ? window.scope : "Limit";
		}
		/** Tooltip and accessible name for the ring, e.g. `Weekly · all models 75%`. */
		function ringLabel(window) {
			if (window === null) return "Claude usage";
			return `${windowLabel(window)} ${Math.round(window.usedPercent)}%`;
		}
		/** The design token a given consumption maps to. */
		function thresholdColor(percent) {
			if (percent >= 95) return "var(--dsw-alias-state-error-primary)";
			if (percent >= 75) return "var(--dsw-alias-state-warn-label)";
			return "var(--dsw-static-blue-450)";
		}
		/**
		* Reset phrasing, following the product: a countdown while the window is
		* close ("Resets in 4 hr 35 min") and a weekday clock time beyond a day
		* ("Resets Thu 11:59 AM"), where a countdown would be noise.
		*/
		function formatReset(resetsAt, now = Date.now()) {
			if (resetsAt === void 0 || resetsAt === 0) return "";
			const diff = resetsAt - now;
			const MINUTE = 6e4;
			if (diff > 0 && diff < 24 * 36e5) {
				const totalMinutes = Math.round(diff / MINUTE);
				const hours = Math.floor(totalMinutes / 60);
				const minutes = totalMinutes % 60;
				if (hours > 0) return `Resets in ${hours} hr${minutes > 0 ? ` ${minutes} min` : ""}`;
				return `Resets in ${minutes} min`;
			}
			const date = new Date(resetsAt);
			const weekday = [
				"Sun",
				"Mon",
				"Tue",
				"Wed",
				"Thu",
				"Fri",
				"Sat"
			][date.getDay()];
			const rawHours = date.getHours();
			const suffix = rawHours >= 12 ? "PM" : "AM";
			return `Resets ${weekday} ${rawHours % 12 === 0 ? 12 : rawHours % 12}:${String(date.getMinutes()).padStart(2, "0")} ${suffix}`;
		}
		/**
		* The panel caption, e.g. `Plan usage limits · Max`. The tier comes from the
		* Agent SDK's `subscription_type`; without one the caption reads plainly.
		*/
		function planCaption(usage) {
			const plan = usage?.plan;
			if (typeof plan !== "string" || plan.length === 0) return "Plan usage limits";
			return `Plan usage limits · ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;
		}
		//#endregion
		//#region src/client/UsageMeter.tsx
		/**
		* The composer usage ring: a ContextMeter-shaped meter in the input tool row
		* that reports the Claude subscription limit relevant to the session's current
		* model, and opens a panel of every reported limit.
		*
		* It renders only while a Claude model is selected, so it never claims to
		* describe a turn it has no data for.
		*/
		/** Ring geometry, matching the shipped ContextMeter: 14px box, 2px stroke. */
		const RADIUS = 5.5;
		const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
		/** ContextMeter's own hover delay. */
		const TOOLTIP_DELAY_MS = 200;
		/**
		* Model-gate cadence. The current model is not on the session snapshot, no
		* model-change event exists in the client catalog, and the model selector's
		* store is private to that plugin — so the gate polls `sessions.models`. That
		* is a LOCAL host RPC with no upstream traffic, so it can run briskly.
		*/
		const GATE_POLL_MS = 700;
		/**
		* A model switch is always a user gesture, so any pointer or Enter gesture
		* schedules a short probe burst. The poll is the safety net; the burst is what
		* makes the ring appear and disappear promptly rather than a tick later.
		*/
		const GATE_BURST_MS = [
			90,
			260,
			600,
			1100
		];
		const GATE_BURST_THROTTLE_MS = 350;
		/**
		* The ring itself. Kept separate so the trigger stays a plain button — the
		* Tooltip primitive clones its child and needs to own that element's handlers.
		*/
		function Ring({ percent, color }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 14 14",
				width: "14",
				height: "14",
				"aria-hidden": true,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					className: UsageMeter_module_css_inlined_default.track,
					cx: "7",
					cy: "7",
					r: RADIUS
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
					className: UsageMeter_module_css_inlined_default.fill,
					cx: "7",
					cy: "7",
					r: RADIUS,
					stroke: color,
					strokeDasharray: `${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`,
					transform: "rotate(-90 7 7)"
				})]
			});
		}
		function UsageMeter({ checkModel, store, useSession }) {
			const running = useSession?.((snapshot) => snapshot.running === true) === true;
			const [gate, setGate] = (0, react.useState)({
				visible: false,
				model: null
			});
			const [usageState, setUsageState] = (0, react.useState)(() => store?.get() ?? {
				usage: null,
				at: 0
			});
			const [open, setOpen] = (0, react.useState)(false);
			const rootRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (store === void 0) return;
				setUsageState(store.get());
				return store.subscribe(setUsageState);
			}, [store]);
			(0, react.useEffect)(() => {
				if (checkModel === void 0) return;
				let cancelled = false;
				let inflight = false;
				let lastBurst = 0;
				const burstTimers = [];
				const check = () => {
					if (cancelled || inflight) return;
					inflight = true;
					checkModel().then((next) => {
						if (cancelled) return;
						setGate((prev) => prev.visible === next.visible && prev.model === next.model ? prev : next);
					}, () => {}).finally(() => {
						inflight = false;
					});
				};
				const clearBurst = () => {
					while (burstTimers.length > 0) clearTimeout(burstTimers.pop());
				};
				const burst = (event) => {
					if (event.type === "keyup" && event.key !== "Enter") return;
					const now = Date.now();
					if (now - lastBurst < GATE_BURST_THROTTLE_MS) return;
					lastBurst = now;
					clearBurst();
					for (const delay of GATE_BURST_MS) burstTimers.push(setTimeout(check, delay));
				};
				check();
				const poll = setInterval(check, GATE_POLL_MS);
				document.addEventListener("pointerdown", burst, true);
				document.addEventListener("keyup", burst, true);
				return () => {
					cancelled = true;
					clearBurst();
					clearInterval(poll);
					document.removeEventListener("pointerdown", burst, true);
					document.removeEventListener("keyup", burst, true);
				};
			}, [checkModel]);
			(0, react.useEffect)(() => {
				if (!gate.visible || !running || store === void 0) return;
				const timer = setInterval(() => {
					store.request();
				}, RUNNING_INTERVAL_MS);
				return () => {
					clearInterval(timer);
				};
			}, [
				running,
				gate.visible,
				store
			]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			(0, react.useLayoutEffect)(() => {
				if (!gate.visible && open) setOpen(false);
			}, [gate.visible, open]);
			/**
			* Hover is the revalidation trigger. Pointing at the ring is the earliest
			* honest signal of intent, so the panel opens onto an already-fresh reading
			* instead of refetching underneath the user. The Tooltip resolves its label
			* only while visible, which makes this the natural hook.
			*/
			const resolveLabel = (0, react.useCallback)(() => {
				store?.request();
				return ringLabel(pickWindow(usageState.usage?.windows ?? [], gate.model));
			}, [
				store,
				usageState,
				gate.model
			]);
			if (!gate.visible) return null;
			const windows = usageState.usage?.windows ?? [];
			const selected = pickWindow(windows, gate.model);
			const percent = selected === null ? 0 : clampPercent(selected.usedPercent);
			const color = thresholdColor(percent);
			const label = ringLabel(selected);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: UsageMeter_module_css_inlined_default.root,
				ref: rootRef,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
					label: resolveLabel,
					side: "top",
					delayMs: TOOLTIP_DELAY_MS,
					disabled: open,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: UsageMeter_module_css_inlined_default.trigger,
						style: { color },
						"aria-label": label,
						"aria-haspopup": "dialog",
						"aria-expanded": open,
						onClick: () => {
							setOpen(!open);
						},
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Ring, {
							percent,
							color
						})
					})
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: UsageMeter_module_css_inlined_default.panel,
					role: "dialog",
					"aria-label": "Subscription usage",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: UsageMeter_module_css_inlined_default.caption,
						children: planCaption(usageState.usage)
					}), windows.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: UsageMeter_module_css_inlined_default.empty,
						children: "No usage data yet."
					}) : windows.map((window, index) => {
						const used = clampPercent(window.usedPercent);
						const reset = formatReset(window.resetsAt);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: UsageMeter_module_css_inlined_default.limit,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: UsageMeter_module_css_inlined_default.line,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: UsageMeter_module_css_inlined_default.name,
										children: windowLabel(window)
									}),
									reset !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: UsageMeter_module_css_inlined_default.reset,
										children: reset
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: reset === "" ? `${UsageMeter_module_css_inlined_default.percent} ${UsageMeter_module_css_inlined_default.percentAlone}` : UsageMeter_module_css_inlined_default.percent,
										children: `${String(Math.round(used))}%`
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: UsageMeter_module_css_inlined_default.bar,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: UsageMeter_module_css_inlined_default.barFill,
									style: {
										width: `${String(used)}%`,
										background: thresholdColor(used)
									}
								})
							})]
						}, `${window.kind}:${window.scope ?? ""}:${String(index)}`);
					})]
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Browser half: registers the plan-usage ring in the composer's right tool row.
		*
		* The ring sits in `conversation.input.right`, immediately left of the model
		* selector, and renders only while a Claude row is selected — so it never
		* claims to describe a turn it has no data for.
		*
		* Its numbers come from this plugin's own `/agent-bridge` channel, which reads
		* them through the Claude Agent SDK. Nothing here knows about credentials, and
		* no other plugin needs to be installed for the ring to work.
		*/
		/** `slots` carries the registration seat; `connection` the RPC caller and session API. */
		const inject = ["slots", "connection"];
		/** The provider id this plugin registers its adapter under. */
		const PROVIDER = "claude";
		/**
		* Resolve whether the session's current model is one of ours, and which.
		* Rejects on failure so the caller keeps its last known state rather than
		* treating an RPC hiccup as "not a Claude model" and hiding the ring.
		*/
		function createModelChecker(connection, sessionId) {
			return async () => {
				const { result } = await connection.api.sessions.models({ sessionId });
				if (!result.ok) throw new Error("sessions.models failed");
				const current = result.value?.current ?? null;
				if (current === null || current.provider !== PROVIDER) return {
					visible: false,
					model: null
				};
				return {
					visible: true,
					model: current.model
				};
			};
		}
		/**
		* Register the composer ring.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			const connection = ctx.get("connection");
			ctx.effect(() => installEffortAccent(), "dsh-llm-agent-bridge: ultracode effort accent");
			const store = createUsageStore(connection.rpc);
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "agent-bridge-usage",
				order: 20,
				inject: (sessionId) => ({
					checkModel: createModelChecker(connection, sessionId),
					store
				})
			}, UsageMeter));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map