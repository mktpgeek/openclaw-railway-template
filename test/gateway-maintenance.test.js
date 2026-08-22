import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stopManagedChild } from "../src/gateway-maintenance.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    return true;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

test("waits for the managed child to actually exit", async () => {
  const child = new FakeChild();
  let settled = false;
  const stopping = stopManagedChild(child, { timeoutMs: 100 }).then((result) => {
    settled = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);

  child.exit();
  assert.deepEqual(await stopping, { exited: true, signaled: true });
});

test("reports a child that does not exit before the timeout", async () => {
  const child = new FakeChild();

  assert.deepEqual(await stopManagedChild(child, { timeoutMs: 20 }), {
    exited: false,
    signaled: true,
  });
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.listenerCount("exit"), 0);
});

test("does not signal a child that has already exited", async () => {
  const child = new FakeChild();
  child.exitCode = 0;

  assert.deepEqual(await stopManagedChild(child, { timeoutMs: 20 }), {
    exited: true,
    signaled: false,
  });
  assert.deepEqual(child.signals, []);
});

test("volume maintenance waits for process exit instead of a fixed delay", () => {
  const serverSource = fs.readFileSync(
    path.join(repoRoot, "src", "server.js"),
    "utf8",
  );
  const maintenanceSource = serverSource.match(
    /async function stopGatewayForMaintenance[\s\S]+?\n}\n\nasync function runVolumeJanitor/,
  )?.[0];

  assert.ok(maintenanceSource, "stopGatewayForMaintenance was not found");
  assert.match(maintenanceSource, /await stopManagedChild\(/);
  assert.doesNotMatch(maintenanceSource, /await sleep\(5000\)/);
});
