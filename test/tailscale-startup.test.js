import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const startupScript = path.join(repoRoot, "scripts", "start-tailscale.sh");

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("starts userspace Tailscale with persistent state and exports its socket", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tailscale-"));
  const fakeTailscaled = path.join(tempDir, "tailscaled");
  const argsPath = path.join(tempDir, "args.json");
  const stateDir = path.join(tempDir, "state");
  const socketPath = path.join(stateDir, "tailscaled.sock");

  fs.writeFileSync(
    fakeTailscaled,
    `#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const socketArg = process.argv.find((arg) => arg.startsWith("--socket="));
const socketPath = socketArg.slice("--socket=".length);
fs.writeFileSync(process.env.FAKE_TAILSCALED_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const server = net.createServer();
server.listen(socketPath);
const close = () => server.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
`,
    "utf8",
  );
  fs.chmodSync(fakeTailscaled, 0o755);

  try {
    const result = await run(
      "bash",
      [
        "-c",
        'source "$1"; printf "%s\\n" "$OPENCLAW_TAILSCALE_SOCKET"; kill "$OPENCLAW_TAILSCALED_PID"; wait "$OPENCLAW_TAILSCALED_PID" || true',
        "--",
        startupScript,
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          FAKE_TAILSCALED_ARGS_PATH: argsPath,
          OPENCLAW_TAILSCALE_ENABLED: "true",
          OPENCLAW_TAILSCALE_LOG: path.join(tempDir, "tailscaled.log"),
          OPENCLAW_TAILSCALE_RUN_AS_CURRENT_USER: "true",
          OPENCLAW_TAILSCALE_SOCKET: path.join(tempDir, "stale.sock"),
          OPENCLAW_TAILSCALE_STATE_DIR: stateDir,
          OPENCLAW_TAILSCALE_WAIT_STEPS: "50",
          OPENCLAW_TAILSCALED_BIN: fakeTailscaled,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), socketPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, "utf8")), [
      "--tun=userspace-networking",
      `--state=${path.join(stateDir, "tailscaled.state")}`,
      `--socket=${socketPath}`,
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
