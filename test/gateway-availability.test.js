import assert from "node:assert/strict";
import test from "node:test";

import {
  isGatewayProbeStatusReady,
  probeGatewayLiveness,
  probeGatewayReadiness,
  resolveGatewayAvailability,
  resolveGatewayHealth,
  resolveGatewayRequestAction,
} from "../src/gateway-availability.js";

test("only accepts successful readiness responses", () => {
  assert.equal(isGatewayProbeStatusReady(200), true);
  assert.equal(isGatewayProbeStatusReady(204), true);
  assert.equal(isGatewayProbeStatusReady(302), false);
  assert.equal(isGatewayProbeStatusReady(401), false);
  assert.equal(isGatewayProbeStatusReady(403), false);
  assert.equal(isGatewayProbeStatusReady(404), false);
  assert.equal(isGatewayProbeStatusReady(500), false);
});

test("probes OpenClaw's readiness endpoint", async () => {
  let requestedUrl = null;
  let responseConsumed = false;
  const result = await probeGatewayReadiness({
    target: "http://127.0.0.1:18789",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        status: 200,
        arrayBuffer: async () => {
          responseConsumed = true;
          return new ArrayBuffer(0);
        },
      };
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:18789/readyz");
  assert.equal(responseConsumed, true);
  assert.deepEqual(result, { ok: true, endpoint: "/readyz" });
});

test("bounds a hung readiness probe", async () => {
  const startedAt = Date.now();
  const result = await probeGatewayReadiness({
    target: "http://127.0.0.1:18789",
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.endpoint, "/readyz");
  assert.equal(result.error?.name, "TimeoutError");
  assert.ok(Date.now() - startedAt < 500);
});

test("probes OpenClaw's liveness endpoint independently", async () => {
  let requestedUrl = null;
  const result = await probeGatewayLiveness({
    target: "http://127.0.0.1:18789",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return { status: 200 };
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:18789/healthz");
  assert.deepEqual(result, { ok: true, endpoint: "/healthz" });
});

test("accepts a reachable gateway that is no longer the managed child", async () => {
  const availability = await resolveGatewayAvailability({
    managedProcessReady: false,
    gatewayStarting: false,
    probeGateway: async () => ({ ok: true, endpoint: "/health" }),
  });

  assert.deepEqual(availability, {
    ok: true,
    reason: "reachable:/health",
    endpoint: "/health",
  });
});

test("reports an unreachable gateway as unavailable", async () => {
  const availability = await resolveGatewayAvailability({
    managedProcessReady: false,
    gatewayStarting: false,
    probeGateway: async () => ({ ok: false, endpoint: null }),
  });

  assert.deepEqual(availability, {
    ok: false,
    reason: "unreachable",
    endpoint: null,
  });
});

test("health checks can probe an owned child instead of trusting its handle", async () => {
  const availability = await resolveGatewayAvailability({
    managedProcessReady: true,
    gatewayStarting: false,
    requireProbe: true,
    probeGateway: async () => ({ ok: false, endpoint: null }),
  });

  assert.deepEqual(availability, {
    ok: false,
    reason: "unreachable",
    endpoint: null,
  });
});

test("configured health fails when the gateway is unavailable", () => {
  assert.deepEqual(
    resolveGatewayHealth({
      configured: true,
      availability: { ok: false, reason: "unreachable", endpoint: null },
    }),
    { ok: false, gateway: "starting", httpStatus: 503 },
  );
});

test("configured health succeeds when the gateway is available", () => {
  assert.deepEqual(
    resolveGatewayHealth({
      configured: true,
      availability: { ok: true, reason: "reachable:/", endpoint: "/" },
    }),
    { ok: true, gateway: "ready", httpStatus: 200 },
  );
});

test("an unmanaged but reachable gateway request is proxied", () => {
  assert.equal(
    resolveGatewayRequestAction({
      configured: true,
      availability: { ok: true, reason: "reachable:/", endpoint: "/" },
    }),
    "proxy",
  );
});

test("unconfigured health stays available for setup", () => {
  assert.deepEqual(
    resolveGatewayHealth({
      configured: false,
      availability: { ok: false, reason: "not-configured", endpoint: null },
    }),
    { ok: true, gateway: "unconfigured", httpStatus: 200 },
  );
});
