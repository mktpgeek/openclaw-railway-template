export const DEFAULT_ACTIVE_START_TIMEOUT_MS = 90_000;

function waitForActiveStart(activeStart, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(completed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);

    Promise.resolve(activeStart).then(
      () => finish(true),
      () => finish(true),
    );
  });
}

export async function runGatewayRecoveryAttempt({
  activeStartTimeoutMs = DEFAULT_ACTIVE_START_TIMEOUT_MS,
  getActiveStart,
  shouldAbort,
  probeGateway,
  recoverGateway,
}) {
  if (shouldAbort()) return { status: "cancelled" };

  const activeStart = getActiveStart();
  if (activeStart) {
    const completed = await waitForActiveStart(
      activeStart,
      activeStartTimeoutMs,
    );
    if (!completed) return { status: "start-timeout" };
  }

  if (shouldAbort()) return { status: "cancelled" };

  const probe = await probeGateway();
  if (probe.ok) return { status: "reachable", probe };

  try {
    await recoverGateway();
    return { status: "restarted" };
  } catch (error) {
    return { status: "failed", error };
  }
}
