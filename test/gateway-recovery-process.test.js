import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getUnusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("a failed automatic recovery schedules another attempt", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-recovery-"));
  const configPath = path.join(stateDir, "openclaw.json");
  const fakeBinDir = path.join(stateDir, "bin");
  const fakeCodexPath = path.join(fakeBinDir, "codex");
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n", "utf8");
  fs.writeFileSync(
    fakeCodexPath,
    "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.144.1'\n",
    "utf8",
  );
  fs.chmodSync(fakeCodexPath, 0o755);
  const gatewayPort = await getUnusedPort();
  const child = spawn(process.execPath, [path.join(repoRoot, "src", "server.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CODEX_HOME: path.join(stateDir, "codex-home"),
      GATEWAY_RECOVERY_BASE_DELAY_MS: "10",
      HOME: path.join(stateDir, "home"),
      INTERNAL_GATEWAY_PORT: String(gatewayPort),
      NPM_CONFIG_PREFIX: path.join(stateDir, "npm-prefix"),
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_CODEX_CLI_VERSION: "0.144.1",
      OPENCLAW_ENTRY: "/definitely/missing-openclaw-entry.js",
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKSPACE_DIR: path.join(stateDir, "workspace"),
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`,
      PORT: "0",
      RAILWAY_VOLUME_MOUNT_PATH: path.join(stateDir, "volume"),
      XDG_CACHE_HOME: path.join(stateDir, "xdg-cache"),
      XDG_CONFIG_HOME: path.join(stateDir, "xdg-config"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let closed = false;
  const closedPromise = new Promise((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    const deadline = Date.now() + 2_500;
    while (
      Date.now() < deadline &&
      (output.match(/scheduling recovery/g) || []).length < 2 &&
      !closed
    ) {
      await delay(25);
    }

    assert.ok(
      (output.match(/scheduling recovery/g) || []).length >= 2,
      output,
    );
    assert.match(output, /automatic recovery failed/);
    assert.doesNotMatch(output, /npm install -g/);
  } finally {
    if (!closed) child.kill("SIGTERM");
    await Promise.race([closedPromise, delay(1_000)]);
    if (!closed) {
      child.kill("SIGKILL");
      await closedPromise;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
