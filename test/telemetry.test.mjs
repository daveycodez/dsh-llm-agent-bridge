import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeDshAdapter } from "../claude-adapter.js";
import { TELEMETRY_ENDPOINT_DEFAULT, telemetryExport } from "../telemetry.js";

test("telemetry detection mirrors dsh-base's own row semantics", () => {
  assert.equal(telemetryExport({}), null, "unset means disabled");
  assert.equal(telemetryExport({ DSH_TELEMETRY_MODE: "DISABLED" }), null);
  assert.equal(telemetryExport({ DSH_TELEMETRY_MODE: "disabled" }), null, "case must not decide it");
  assert.equal(telemetryExport({ DSH_TELEMETRY_MODE: "  " }), null);

  assert.deepEqual(telemetryExport({ DSH_TELEMETRY_MODE: "FULL" }), {
    mode: "FULL",
    endpoint: TELEMETRY_ENDPOINT_DEFAULT,
  });
  assert.deepEqual(telemetryExport({ DSH_TELEMETRY_MODE: "FEEDBACK_ONLY", DSH_TELEMETRY_OTLP_URL: "http://localhost:4318/v1/logs" }), {
    mode: "FEEDBACK_ONLY",
    endpoint: "http://localhost:4318/v1/logs",
  });

  // dsh-base: "A non-empty DSH_TELEMETRY_DISABLED - any value, including
  // '0'/'false' - opts the process out".
  for (const value of ["1", "0", "false", "no"]) {
    assert.equal(telemetryExport({ DSH_TELEMETRY_MODE: "FULL", DSH_TELEMETRY_DISABLED: value }), null, `DSH_TELEMETRY_DISABLED=${value} must opt out`);
  }
});

test("no turn reaches Claude while DSH is exporting session records", async () => {
  const runtime = { listModels: () => [], sessions: new Map() };
  const adapter = new ClaudeDshAdapter({ runtime, ready: Promise.resolve() });
  const previous = process.env.DSH_TELEMETRY_MODE;
  process.env.DSH_TELEMETRY_MODE = "FULL";
  try {
    await assert.rejects(
      async () => { for await (const chunk of adapter.stream({ sessionId: "s1", messages: [] })) void chunk; },
      /DSH session telemetry is enabled[\s\S]*DSH_TELEMETRY_DISABLED=1/,
      "the refusal must name the way out",
    );
    await assert.rejects(
      async () => { for await (const chunk of adapter.stream({ sessionId: "s1", purpose: "title", messages: [] })) void chunk; },
      /telemetry is enabled/,
      "auxiliary calls carry conversation text too",
    );
  } finally {
    if (previous === undefined) delete process.env.DSH_TELEMETRY_MODE;
    else process.env.DSH_TELEMETRY_MODE = previous;
  }
});
