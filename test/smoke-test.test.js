import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeScript = path.join(repoRoot, "scripts", "smoke-test.sh");
const setupPassword = "long-test-password-".repeat(8);

async function withDeploymentFixture({ healthy }, run) {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");

    if (req.url.startsWith("/setup/api/")) {
      const expectedAuthorization = `Basic ${Buffer.from(`*:${setupPassword}`).toString("base64")}`;
      if (req.headers.authorization !== expectedAuthorization) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false }));
        return;
      }
    }

    if (req.url === "/healthz") {
      res.statusCode = healthy ? 200 : 503;
      res.end(
        JSON.stringify({ ok: healthy, gateway: healthy ? "ready" : "starting" }),
      );
      return;
    }

    if (req.url === "/setup/healthz") {
      res.statusCode = healthy ? 200 : 503;
      res.end(
        JSON.stringify({
          ok: healthy,
          configured: true,
          gatewayRunning: healthy,
          gatewayReady: healthy,
          gatewayReachable: healthy,
        }),
      );
      return;
    }

    if (req.url === "/setup/api/debug") {
      res.end(
        JSON.stringify({
          wrapper: {
            node: process.version,
            port: 8080,
            gatewayTokenPersisted: true,
          },
          openclaw: { version: "OpenClaw 2026.6.11 (e085fa1)" },
        }),
      );
      return;
    }

    if (req.url === "/setup/api/status") {
      res.end(
        JSON.stringify({ ok: true, codexCliVersion: "codex-cli 0.144.1" }),
      );
      return;
    }

    if (req.url === "/openclaw") {
      res.statusCode = healthy ? 200 : 503;
      res.end(JSON.stringify({ ok: healthy }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function runSmoke(baseUrl) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bash",
      [smokeScript, baseUrl, setupPassword, "2026.6.11", "0.144.1"],
      { cwd: repoRoot },
    );
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("smoke test reaches its summary for a healthy deployment", async () => {
  const result = await withDeploymentFixture({ healthy: true }, runSmoke);

  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /OpenClaw version matches expected/);
  assert.match(result.output, /Codex CLI version matches expected/);
  assert.match(result.output, /Gateway proxy \/openclaw reachable/);
  assert.match(result.output, /SMOKE TEST PASSED/);
});

test("smoke test rejects a configured deployment with no gateway", async () => {
  const result = await withDeploymentFixture({ healthy: false }, runSmoke);

  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /SMOKE TEST FAILED/);
});
