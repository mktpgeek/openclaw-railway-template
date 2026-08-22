export const DEFAULT_GATEWAY_MAINTENANCE_STOP_TIMEOUT_MS = 30_000;

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function stopManagedChild(
  child,
  {
    signal = "SIGTERM",
    timeoutMs = DEFAULT_GATEWAY_MAINTENANCE_STOP_TIMEOUT_MS,
  } = {},
) {
  if (!child || hasExited(child)) {
    return { exited: true, signaled: false };
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let signaled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve(result);
    };
    const onExit = () => finish({ exited: true, signaled });
    const timeout = setTimeout(
      () => finish({ exited: false, signaled }),
      timeoutMs,
    );

    child.once("exit", onExit);
    try {
      signaled = true;
      if (child.kill(signal) === false) signaled = false;
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        child.removeListener("exit", onExit);
        reject(error);
      }
    }
  });
}
