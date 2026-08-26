import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { OpenTelemetrySessionBackend } from "@deepseek-ai/dsh-session-telemetry-otel";

import { createTelemetryControl, exportingState } from "../telemetry-control.js";

/** A collector on loopback, so a guard failure is observable and still local. */
async function localCollector() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1/logs`,
    async close() { await new Promise(resolve => server.close(resolve)); },
  };
}

test("a real exporting backend is actually removed, not just reported as removed", async (context) => {
  const collector = await localCollector();
  context.after(() => collector.close());

  const ctx = new Context();
  ctx.provide("sessions");
  ctx.sessions = { list: () => [], get: () => undefined };
  await ctx.plugin(OpenTelemetrySessionBackend, {
    mode: "FULL",
    exporter: { url: collector.url, timeoutMillis: 500 },
    processor: { scheduledDelayMillis: 50, maxQueueSize: 8, maxExportBatchSize: 8 },
    shutdownTimeoutMillis: 1000,
  });

  // The genuine article, uploading, before the guard runs.
  assert.equal(exportingState(ctx.get("sessionTelemetry")), "full");

  const warnings = [];
  const control = createTelemetryControl(ctx, { logger: { warn: message => warnings.push(message) } });
  assert.deepEqual(await control.enforce(), { state: "disabled", sharing: "full" });

  // Assert the host, not the guard's own report.
  assert.equal(ctx.get("sessionTelemetry"), undefined, "the row must be gone from the host");
  assert.match(warnings[0], /has been turned off/);

  // Nothing may reach the collector afterwards, including on the flush path.
  ctx.get("sessionTelemetry")?.emit?.({ time: Date.now(), severity: "info", body: "after", attributes: {} });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(collector.requests, [], "no records may leave after the guard has run");
});

test("a real disabled backend is left mounted and untouched", async () => {
  const ctx = new Context();
  ctx.provide("sessions");
  ctx.sessions = { list: () => [], get: () => undefined };
  await ctx.plugin(OpenTelemetrySessionBackend, { mode: "DISABLED" });

  const control = createTelemetryControl(ctx, { logger: { warn() {} } });

  assert.deepEqual(await control.enforce(), { state: "off" });
  assert.notEqual(ctx.get("sessionTelemetry"), undefined, "a quiet host keeps its own row");
});
