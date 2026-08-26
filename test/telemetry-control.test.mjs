import assert from "node:assert/strict";
import test from "node:test";

import { createTelemetryControl, exportingState, scanOnlyTelemetryControl } from "../telemetry-control.js";

function hostWithTelemetry(sharing, { fiber = true } = {}) {
  const record = { shutdown: 0, disposed: 0 };
  let mounted = true;
  const backend = {
    sharing,
    provider: sharing === "disabled" ? undefined : {},
    async shutdown() { record.shutdown += 1; },
    // Disposing a cordis fiber unmounts the service it provides, so the host
    // stops answering for it — that is what the guard verifies against.
    ctx: fiber ? { fiber: { async dispose() { record.disposed += 1; mounted = false; } } } : {},
  };
  const ctx = { get: name => (name === "sessionTelemetry" && mounted ? backend : undefined) };
  return { ctx, record, unmount: () => { mounted = false; } };
}

test("the live backend decides, whatever switched it on", () => {
  assert.equal(exportingState({ sharing: "full" }), "full");
  assert.equal(exportingState({ sharing: "feedback-only" }), "feedback-only");
  assert.equal(exportingState({ sharing: "disabled" }), null);
  assert.equal(exportingState(null), null);
  // A backend that reports no sharing status still has a pipeline to read.
  assert.equal(exportingState({ provider: {} }), "unknown");
  assert.equal(exportingState({ provider: undefined }), null);
});

test("an exporting host is turned off before the first turn", async () => {
  const { ctx, record } = hostWithTelemetry("full");
  const warnings = [];
  const control = createTelemetryControl(ctx, { logger: { warn: message => warnings.push(message) } });

  assert.deepEqual(await control.enforce(), { state: "disabled", sharing: "full" });
  assert.equal(record.shutdown, 1, "the pipeline must be drained and quiesced");
  assert.equal(record.disposed, 1, "and the row unmounted, so capture stops too");
  assert.match(warnings[0], /has been turned off/);
  assert.match(warnings[0], /DSH_TELEMETRY_DISABLED=1/, "the operator must be told how to keep it off at the source");
});

test("a host that is already quiet is left alone", async () => {
  const { ctx, record } = hostWithTelemetry("disabled");
  const control = createTelemetryControl(ctx, { logger: { warn() {} } });

  assert.deepEqual(await control.enforce(), { state: "off" });
  assert.equal(record.shutdown, 0);
  assert.equal(record.disposed, 0);
});

test("later turns do not re-run the config scan against an exporter we already removed", async () => {
  const { ctx, record, unmount } = hostWithTelemetry("full");
  const control = createTelemetryControl(ctx, { logger: { warn() {} } });
  await control.enforce();
  unmount();

  // The row is gone, so the environment still says FULL while nothing exports.
  process.env.DSH_TELEMETRY_MODE = "FULL";
  try {
    assert.deepEqual(await control.enforce(), { state: "disabled", sharing: "full" });
    assert.equal(record.shutdown, 1, "and it is not shut down twice");
  } finally {
    delete process.env.DSH_TELEMETRY_MODE;
  }
});

test("refuse mode fails the turn and leaves the host untouched", async () => {
  const { ctx, record } = hostWithTelemetry("full");
  const control = createTelemetryControl(ctx, { mode: "refuse", logger: { warn() {} } });

  await assert.rejects(() => control.enforce(), /telemetry is enabled/);
  assert.equal(record.shutdown, 0, "refuse must not touch host configuration");
  assert.equal(record.disposed, 0);
});

test("ignore mode does nothing at all", async () => {
  const { ctx, record } = hostWithTelemetry("full");
  const control = createTelemetryControl(ctx, { mode: "ignore", logger: { warn() {} } });

  assert.deepEqual(await control.enforce(), { state: "ignored" });
  assert.equal(record.shutdown, 0);
});

test("an unreadable host still refuses on the config scan", async () => {
  const control = createTelemetryControl({ get: () => undefined }, { logger: { warn() {} } });
  process.env.DSH_TELEMETRY_MODE = "FULL";
  try {
    await assert.rejects(() => control.enforce(), /telemetry is enabled/);
  } finally {
    delete process.env.DSH_TELEMETRY_MODE;
  }
});

test("a row that will not unmount refuses rather than claiming success", async () => {
  // shutdown() kills the pipeline but leaves the row reporting "full", and from
  // outside there is no way to confirm the pipe is dead. Refuse instead.
  const { ctx, record } = hostWithTelemetry("full", { fiber: false });
  const control = createTelemetryControl(ctx, { logger: { warn() {} } });

  await assert.rejects(() => control.enforce(), /could not be turned off/);
  assert.equal(record.shutdown, 1, "the attempt is still made");
});

test("the scan-only control never reaches for a host", async () => {
  assert.deepEqual(await scanOnlyTelemetryControl().enforce(), { state: "off" });
});

test("a teardown that fails degrades to refusing, and is never memoized", async () => {
  // Both paths fail and both swallow their errors: the exporter survives.
  const backend = {
    sharing: "full",
    provider: {},
    async shutdown() { throw new Error("socket busy"); },
    ctx: { fiber: { async dispose() { throw new Error("row is pinned"); } } },
  };
  const ctx = { get: name => (name === "sessionTelemetry" ? backend : undefined) };
  const control = createTelemetryControl(ctx, { logger: { warn() {} } });

  await assert.rejects(() => control.enforce(), /could not be turned off/);
  // The failure must not stick: a later turn re-checks rather than assuming.
  await assert.rejects(() => control.enforce(), /could not be turned off/);

  backend.sharing = "disabled";
  backend.provider = undefined;
  assert.deepEqual(await control.enforce(), { state: "off" }, "and it recovers once the host is actually quiet");
});
