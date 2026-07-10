export const DEFAULT_GATEWAY_PROBE_TIMEOUT_MS = 1_500;
export const GATEWAY_LIVENESS_ENDPOINT = "/healthz";
export const GATEWAY_READINESS_ENDPOINT = "/readyz";

export function isGatewayProbeStatusReady(status) {
  return status >= 200 && status < 300;
}

async function probeGatewayEndpoint({
  target,
  endpoint,
  timeoutMs = DEFAULT_GATEWAY_PROBE_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(`Gateway probe timed out at ${endpoint}`, "TimeoutError"),
      ),
    timeoutMs,
  );

  try {
    const response = await fetchImpl(`${target}${endpoint}`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    if (typeof response.arrayBuffer === "function") {
      await response.arrayBuffer();
    }
    return {
      ok: isGatewayProbeStatusReady(response.status),
      endpoint,
    };
  } catch (error) {
    return { ok: false, endpoint, error };
  } finally {
    clearTimeout(timeout);
  }
}

export function probeGatewayLiveness(options) {
  return probeGatewayEndpoint({
    ...options,
    endpoint: GATEWAY_LIVENESS_ENDPOINT,
  });
}

export function probeGatewayReadiness(options) {
  return probeGatewayEndpoint({
    ...options,
    endpoint: GATEWAY_READINESS_ENDPOINT,
  });
}

export async function resolveGatewayAvailability({
  managedProcessReady,
  gatewayStarting,
  requireProbe = false,
  probeGateway,
}) {
  if (managedProcessReady && !requireProbe) {
    return { ok: true, reason: "managed-process", endpoint: null };
  }

  const probe = await probeGateway();
  if (probe?.ok) {
    return {
      ok: true,
      reason: `reachable:${probe.endpoint}`,
      endpoint: probe.endpoint,
    };
  }

  return {
    ok: false,
    reason: gatewayStarting ? "starting" : "unreachable",
    endpoint: probe?.endpoint ?? null,
  };
}

export function resolveGatewayHealth({ configured, availability }) {
  if (!configured) {
    return { ok: true, gateway: "unconfigured", httpStatus: 200 };
  }

  if (availability.ok) {
    return { ok: true, gateway: "ready", httpStatus: 200 };
  }

  return { ok: false, gateway: "starting", httpStatus: 503 };
}

export function resolveGatewayRequestAction({ configured, availability }) {
  if (!configured) return "setup";
  return availability.ok ? "proxy" : "loading";
}
