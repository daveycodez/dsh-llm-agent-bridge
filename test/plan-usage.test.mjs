import assert from "node:assert/strict";
import test from "node:test";

import { planUsageFrom } from "../plan-usage.js";

test("the SDK's windows become the rows the ring renders", () => {
  const usage = planUsageFrom({
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 10, resets_at: "2026-08-27T00:50:00.472479+00:00" },
      seven_day: { utilization: 81, resets_at: "2026-08-27T19:00:00.472500+00:00" },
      model_scoped: [{ display_name: "Fable", utilization: 100, resets_at: "2026-08-27T19:00:00.472705+00:00" }],
    },
  });

  assert.equal(usage.supported, true);
  assert.equal(usage.plan, "max", "the caption reads 'Plan usage limits · Max' from this");
  assert.deepEqual(usage.windows.map(window => [window.kind, window.scope, window.usedPercent]), [
    ["session", undefined, 10],
    ["weekly", undefined, 81],
    ["weekly", "Fable", 100],
  ]);
  assert.equal(usage.windows[0].resetsAt, Date.parse("2026-08-27T00:50:00.472479+00:00"));
});

test("a per-model bucket is labelled by the server, not by us", () => {
  const usage = planUsageFrom({
    rate_limits_available: true,
    rate_limits: { model_scoped: [{ display_name: "SomeModelWeHaveNeverHeardOf", utilization: 5, resets_at: null }] },
  });

  assert.deepEqual(usage.windows, [{ kind: "weekly", scope: "SomeModelWeHaveNeverHeardOf", usedPercent: 5 }]);
});

test("an API-key session reports unsupported rather than empty", () => {
  // rate_limits_available is false for API key, Bedrock and Vertex sessions:
  // a fact about the session, not a failure to report.
  assert.deepEqual(planUsageFrom({ subscription_type: null, rate_limits_available: false, rate_limits: null }), { supported: false });
  assert.deepEqual(planUsageFrom(null), { supported: false });
});

test("windows without a usable number are dropped, not drawn as zero", () => {
  const usage = planUsageFrom({
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: null, resets_at: null },
      seven_day: { utilization: 42, resets_at: "not a date" },
    },
  });

  assert.deepEqual(usage.windows, [{ kind: "weekly", usedPercent: 42 }], "a null utilization draws nothing");
});

test("a reading is held briefly so several sessions cost one control session", async () => {
  const { ClaudeSdkClient } = await import("../sdk-client.mjs");
  let reads = 0;
  let now = 1_000_000;
  const client = new ClaudeSdkClient({ sdk: {}, clock: () => now });
  client.readPlanUsage = async () => { reads += 1; return { supported: true, plan: "max", windows: [] }; };

  const [first, second] = await Promise.all([client.planUsage(), client.planUsage()]);
  assert.equal(reads, 1, "concurrent askers share one read");
  assert.deepEqual(first, second);

  await client.planUsage();
  assert.equal(reads, 1, "and a later asker inside the window reuses it");

  now += 120_001;
  await client.planUsage();
  assert.equal(reads, 2, "past the window it reads again");
});

test("an unavailable reading degrades to unsupported, never to a thrown turn", async () => {
  const { ClaudeSdkClient } = await import("../sdk-client.mjs");
  const client = new ClaudeSdkClient({ sdk: {} });
  const diagnostics = [];
  client.on("diagnostic", message => diagnostics.push(message));
  client.readPlanUsage = async () => { throw new Error("control channel refused"); };

  assert.deepEqual(await client.planUsage(), { supported: false });
  assert.match(diagnostics[0], /plan usage unavailable/);
});
