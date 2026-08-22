import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACTIVE_START_TIMEOUT_MS,
  DEFAULT_GATEWAY_START_TIMEOUT_MS,
  runGatewayRecoveryAttempt,
} from "../src/gateway-recovery.js";

test("allows startup migrations to outlive their five-minute lease", () => {
  assert.ok(DEFAULT_GATEWAY_START_TIMEOUT_MS > 5 * 60_000);
  assert.ok(DEFAULT_ACTIVE_START_TIMEOUT_MS > DEFAULT_GATEWAY_START_TIMEOUT_MS);
});

test("waits for an active start attempt before recovering", async () => {
  let rejectStart;
  const activeStart = new Promise((_resolve, reject) => {
    rejectStart = reject;
  });
  let probes = 0;
  let recoveries = 0;

  const attempt = runGatewayRecoveryAttempt({
    getActiveStart: () => activeStart,
    shouldAbort: () => false,
    probeGateway: async () => {
      probes += 1;
      return { ok: false, endpoint: "/healthz" };
    },
    recoverGateway: async () => {
      recoveries += 1;
    },
  });

  await Promise.resolve();
  assert.equal(probes, 0);
  assert.equal(recoveries, 0);

  rejectStart(new Error("original start failed"));
  assert.deepEqual(await attempt, { status: "restarted" });
  assert.equal(probes, 1);
  assert.equal(recoveries, 1);
});

test("does not restart a gateway that remains live", async () => {
  let recoveries = 0;
  const result = await runGatewayRecoveryAttempt({
    getActiveStart: () => null,
    shouldAbort: () => false,
    probeGateway: async () => ({ ok: true, endpoint: "/healthz" }),
    recoverGateway: async () => {
      recoveries += 1;
    },
  });

  assert.deepEqual(result, {
    status: "reachable",
    probe: { ok: true, endpoint: "/healthz" },
  });
  assert.equal(recoveries, 0);
});

test("rechecks whether recovery should abort after a start settles", async () => {
  let resolveStart;
  const activeStart = new Promise((resolve) => {
    resolveStart = resolve;
  });
  let abort = false;
  let probed = false;

  const attempt = runGatewayRecoveryAttempt({
    getActiveStart: () => activeStart,
    shouldAbort: () => abort,
    probeGateway: async () => {
      probed = true;
      return { ok: false, endpoint: "/healthz" };
    },
    recoverGateway: async () => {},
  });

  abort = true;
  resolveStart();
  assert.deepEqual(await attempt, { status: "cancelled" });
  assert.equal(probed, false);
});

test("reports a failed recovery so the scheduler can retry", async () => {
  const error = new Error("replacement failed");
  const result = await runGatewayRecoveryAttempt({
    getActiveStart: () => null,
    shouldAbort: () => false,
    probeGateway: async () => ({ ok: false, endpoint: "/healthz" }),
    recoverGateway: async () => {
      throw error;
    },
  });

  assert.deepEqual(result, { status: "failed", error });
});

test("bounds how long recovery waits for a stuck start", async () => {
  let probed = false;
  const result = await runGatewayRecoveryAttempt({
    activeStartTimeoutMs: 20,
    getActiveStart: () => new Promise(() => {}),
    shouldAbort: () => false,
    probeGateway: async () => {
      probed = true;
      return { ok: false, endpoint: "/healthz" };
    },
    recoverGateway: async () => {},
  });

  assert.deepEqual(result, { status: "start-timeout" });
  assert.equal(probed, false);
});
