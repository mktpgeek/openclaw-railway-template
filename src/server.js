import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

const LOG_FILE = path.join(STATE_DIR, "server.log");
const LOG_RING_BUFFER_MAX = 1000;
const MAX_LOG_FILE_SIZE = 5 * 1024 * 1024;
const logRingBuffer = [];
const sseClients = new Set();

function writeLog(level, category, message) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] [${category}] ${message}`;

  const consoleFn =
    level === "ERROR"
      ? console.error
      : level === "WARN"
        ? console.warn
        : console.log;
  consoleFn(line);

  logRingBuffer.push(line);
  if (logRingBuffer.length > LOG_RING_BUFFER_MAX) {
    logRingBuffer.shift();
  }

  for (const client of sseClients) {
    try {
      client.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }

  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_FILE_SIZE) {
      const content = fs.readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n");
      fs.writeFileSync(LOG_FILE, lines.slice(Math.floor(lines.length / 2)).join("\n"));
    }
  } catch {}
}

const log = {
  info: (category, message) => writeLog("INFO", category, message),
  warn: (category, message) => writeLog("WARN", category, message),
  error: (category, message) => writeLog("ERROR", category, message),
};

function parsePositiveIntegerEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  log.warn("config", `invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

function resolveGatewayToken() {
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    log.warn("gateway-token", `could not read existing token: ${err.code || err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    log.warn("gateway-token", `could not persist token: ${err.code || err.message}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;
async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
    cachedOpenclawVersion = version.output.trim();
  }
  return { version: cachedOpenclawVersion };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;
const GMAIL_WATCHER_PORT = Number.parseInt(
  process.env.GMAIL_WATCHER_PORT ?? "8788",
  10,
);
const GMAIL_WATCHER_HOST = process.env.GMAIL_WATCHER_HOST ?? "127.0.0.1";
const GMAIL_WATCHER_TARGET = `http://${GMAIL_WATCHER_HOST}:${GMAIL_WATCHER_PORT}`;
const GMAIL_WATCHER_PATH = normalizeProxyBasePath(
  process.env.GMAIL_WATCHER_PATH ?? "/gmail-pubsub",
);
const MANAGE_GMAIL_WATCHER =
  process.env.OPENCLAW_MANAGE_GMAIL_WATCHER?.toLowerCase() === "true";

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);
const ACP_DEFAULT_AGENT =
  process.env.OPENCLAW_ACP_DEFAULT_AGENT?.trim() || "codex";
const ACP_PERMISSION_MODE =
  process.env.OPENCLAW_ACP_PERMISSION_MODE?.trim() || "approve-all";
const ACP_NON_INTERACTIVE_PERMISSIONS =
  process.env.OPENCLAW_ACP_NON_INTERACTIVE_PERMISSIONS?.trim() || "deny";
const ACP_PLUGIN_TOOLS_MCP_BRIDGE =
  process.env.OPENCLAW_ACP_PLUGIN_TOOLS_MCP_BRIDGE?.toLowerCase() === "true";
const ACP_MAX_CONCURRENT_SESSIONS = parsePositiveIntegerEnv(
  "OPENCLAW_ACP_MAX_CONCURRENT_SESSIONS",
  2,
);
const ACP_RUNTIME_TTL_MINUTES = parsePositiveIntegerEnv(
  "OPENCLAW_ACP_RUNTIME_TTL_MINUTES",
  60,
);
const DOCTOR_FIX_TIMEOUT_MS = parsePositiveIntegerEnv(
  "OPENCLAW_DOCTOR_FIX_TIMEOUT_MS",
  180_000,
);
const AGENT_MAX_CONCURRENT = parsePositiveIntegerEnv("OPENCLAW_AGENT_MAX_CONCURRENT", 2);
const AGENT_SUBAGENT_MAX_CONCURRENT = parsePositiveIntegerEnv(
  "OPENCLAW_AGENT_SUBAGENT_MAX_CONCURRENT",
  2,
);
const AGENT_THINKING_DEFAULT =
  process.env.OPENCLAW_AGENT_THINKING_DEFAULT?.trim() || "high";
const CODEX_CLI_VERSION =
  process.env.OPENCLAW_CODEX_CLI_VERSION?.trim() || "0.134.0";
const RAILWAY_VOLUME_PATH =
  process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || "/data";
const CODEX_HOME =
  process.env.CODEX_HOME?.trim() || path.join(RAILWAY_VOLUME_PATH, ".codex");
const CODEX_CONFIG_PATH = path.join(CODEX_HOME, "config.toml");
const CODEX_AUTH_PATH = path.join(CODEX_HOME, "auth.json");
const CODEX_LOG_DB_PATH = path.join(CODEX_HOME, "logs_2.sqlite");
const CODEX_LOG_DB_MAX_BYTES = parsePositiveIntegerEnv(
  "OPENCLAW_CODEX_LOG_DB_MAX_BYTES",
  512 * 1024 * 1024,
);
const VOLUME_JANITOR_INTERVAL_MS = parsePositiveIntegerEnv(
  "OPENCLAW_VOLUME_JANITOR_INTERVAL_MS",
  15 * 60 * 1000,
);
const CODEX_SESSIONS_STORE_PATH = path.join(
  STATE_DIR,
  "agents",
  "codex",
  "sessions",
  "sessions.json",
);
const MODEL_AUTH_STORE_PATH = path.join(
  STATE_DIR,
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);
const DEFAULT_OPENAI_CODEX_MODEL = "codex/gpt-5.5";
const STALE_SESSION_TMP_MAX_AGE_MS = Number.parseInt(
  process.env.OPENCLAW_STALE_SESSION_TMP_MAX_AGE_MS ?? "600000",
  10,
);
const RAILWAY_DEFAULT_DISABLED_PLUGINS = [
  "alibaba",
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "arcee",
  "azure-speech",
  "bonjour",
  "browser",
  "byteplus",
  "cerebras",
  "chutes",
  "cloudflare-ai-gateway",
  "comfy",
  "copilot-proxy",
  "deepgram",
  "deepseek",
  "deepinfra",
  "discord",
  "document-extract",
  "elevenlabs",
  "fal",
  "feishu",
  "file-transfer",
  "fireworks",
  "github-copilot",
  "google",
  "groq",
  "huggingface",
  "inworld",
  "kilocode",
  "kimi",
  "litellm",
  "lmstudio",
  "matrix",
  "memory-core",
  "microsoft",
  "microsoft-foundry",
  "minimax",
  "mistral",
  "moonshot",
  "nvidia",
  "ollama",
  "opencode",
  "opencode-go",
  "openrouter",
  "phone-control",
  "qianfan",
  "qqbot",
  "qwen",
  "runway",
  "senseaudio",
  "sglang",
  "slack",
  "stepfun",
  "synthetic",
  "tencent",
  "talk-voice",
  "together",
  "tts-local-cli",
  "venice",
  "vercel-ai-gateway",
  "vllm",
  "volcengine",
  "voyage",
  "vydra",
  "web-readability",
  "whatsapp",
  "xai",
  "xiaomi",
  "zai",
];
const DEFAULT_DISABLED_PLUGINS = parseListEnv(
  "OPENCLAW_DEFAULT_DISABLED_PLUGINS",
  RAILWAY_DEFAULT_DISABLED_PLUGINS,
);
const FORCE_DISABLED_PLUGINS = parseListEnv(
  "OPENCLAW_FORCE_DISABLED_PLUGINS",
  ["memory-core", "slack"],
);
const DISABLE_USER_MCP_SERVERS =
  process.env.OPENCLAW_DISABLE_USER_MCP_SERVERS?.toLowerCase() !== "false";

const ACP_ALLOWED_AGENTS = [
  "claude",
  "codex",
  "copilot",
  "cursor",
  "droid",
  "gemini",
  "iflow",
  "kilocode",
  "kimi",
  "kiro",
  "openclaw",
  "opencode",
  "pi",
  "qwen",
];

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function parseListEnv(name, fallback) {
  if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
    return fallback;
  }

  return process.env[name]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestampForFileName(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 || unit === "B" ? 0 : 1)} ${unit}`;
}

function getPathSize(pathToSize) {
  let stat;
  try {
    stat = fs.statSync(pathToSize);
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }

  if (!stat.isDirectory()) {
    return stat.size;
  }

  let total = 0;
  for (const entry of fs.readdirSync(pathToSize, { withFileTypes: true })) {
    total += getPathSize(path.join(pathToSize, entry.name));
  }
  return total;
}

function rmPath(pathToRemove) {
  let size = 0;
  try {
    size = getPathSize(pathToRemove);
  } catch (err) {
    log.warn("volume-cleanup", `failed to estimate size for ${pathToRemove}: ${err.message}`);
  }

  fs.rmSync(pathToRemove, { recursive: true, force: true });
  return size;
}

function cleanupStaleSessionTempFiles() {
  const sessionsDir = path.join(STATE_DIR, "agents", "main", "sessions");
  const now = Date.now();
  let removed = 0;
  let freedBytes = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return { removed, freedBytes };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !/^sessions\.json\..+\.tmp$/.test(entry.name)) {
      continue;
    }

    const filePath = path.join(sessionsDir, entry.name);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < STALE_SESSION_TMP_MAX_AGE_MS) {
        continue;
      }
      freedBytes += rmPath(filePath);
      removed += 1;
    } catch (err) {
      log.warn("volume-cleanup", `failed to remove stale session temp file ${filePath}: ${err.message}`);
    }
  }

  return { removed, freedBytes };
}

function extractOpenclawVersion(versionOutput) {
  const match = String(versionOutput ?? "").match(/\b\d{4}\.\d+\.\d+(?:[-.a-zA-Z0-9]+)?\b/);
  return match?.[0] || "";
}

function cleanupStalePluginRuntimeDeps(currentVersion) {
  const depsDir = path.join(STATE_DIR, "plugin-runtime-deps");
  let removed = 0;
  let freedBytes = 0;

  if (!currentVersion) {
    return { removed, freedBytes };
  }

  let entries = [];
  try {
    entries = fs.readdirSync(depsDir, { withFileTypes: true });
  } catch {
    return { removed, freedBytes };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("openclaw-")) {
      continue;
    }
    if (entry.name.startsWith(`openclaw-${currentVersion}-`)) {
      continue;
    }

    const dirPath = path.join(depsDir, entry.name);
    try {
      freedBytes += rmPath(dirPath);
      removed += 1;
    } catch (err) {
      log.warn("volume-cleanup", `failed to remove stale plugin runtime cache ${dirPath}: ${err.message}`);
    }
  }

  return { removed, freedBytes };
}

function cleanupPluginRuntimePnpmStores() {
  const depsDir = path.join(STATE_DIR, "plugin-runtime-deps");
  let removed = 0;
  let freedBytes = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(depsDir, { withFileTypes: true });
  } catch {
    return { removed, freedBytes };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("openclaw-")) {
      continue;
    }

    const storePath = path.join(depsDir, entry.name, ".openclaw-pnpm-store");
    if (!fs.existsSync(storePath)) {
      continue;
    }

    try {
      freedBytes += rmPath(storePath);
      removed += 1;
    } catch (err) {
      log.warn("volume-cleanup", `failed to remove plugin runtime pnpm store ${storePath}: ${err.message}`);
    }
  }

  return { removed, freedBytes };
}

function cleanupStatePluginRuntimeDepsForExternalStageDir() {
  const rawStageDir = process.env.OPENCLAW_PLUGIN_STAGE_DIR?.trim();
  if (!rawStageDir) return { removed: 0, freedBytes: 0 };

  const depsDir = path.join(STATE_DIR, "plugin-runtime-deps");
  const stateDepsDir = path.resolve(depsDir);
  const stageDirs = rawStageDir
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry.startsWith("~") ? path.join(os.homedir(), entry.slice(1)) : entry));

  if (stageDirs.some((stageDir) => stageDir === stateDepsDir)) {
    return { removed: 0, freedBytes: 0 };
  }

  if (!fs.existsSync(depsDir)) {
    return { removed: 0, freedBytes: 0 };
  }

  try {
    const freedBytes = rmPath(depsDir);
    return { removed: 1, freedBytes };
  } catch (err) {
    log.warn("volume-cleanup", `failed to remove state plugin runtime deps ${depsDir}: ${err.message}`);
    return { removed: 0, freedBytes: 0 };
  }
}

function cleanupCodexTransientFiles() {
  const transientDirs = [
    path.join(CODEX_HOME, ".tmp"),
    path.join(CODEX_HOME, "tmp"),
  ];
  let removed = 0;
  let freedBytes = 0;

  for (const dirPath of transientDirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      try {
        freedBytes += rmPath(entryPath);
        removed += 1;
      } catch (err) {
        log.warn("volume-cleanup", `failed to remove Codex transient ${entryPath}: ${err.message}`);
      }
    }
  }

  return { removed, freedBytes };
}

function listCodexHomeDirs() {
  const dirs = new Set([path.resolve(CODEX_HOME)]);
  const agentsDir = path.join(STATE_DIR, "agents");

  let entries = [];
  try {
    entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [...dirs];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    dirs.add(path.resolve(path.join(agentsDir, entry.name, "agent", "codex-home")));
  }

  return [...dirs];
}

function listCodexLogDatabasePaths() {
  const databasePaths = new Set([path.resolve(CODEX_LOG_DB_PATH)]);

  for (const homeDir of listCodexHomeDirs()) {
    let entries = [];
    try {
      entries = fs.readdirSync(homeDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !/^logs_\d+\.sqlite$/.test(entry.name)) {
        continue;
      }
      databasePaths.add(path.resolve(path.join(homeDir, entry.name)));
    }
  }

  return [...databasePaths];
}

function getCodexLogDatabaseStats() {
  const stats = [];

  for (const databasePath of listCodexLogDatabasePaths()) {
    try {
      const stat = fs.statSync(databasePath);
      if (stat.isFile()) {
        stats.push({ path: databasePath, size: stat.size });
      }
    } catch (err) {
      if (err?.code !== "ENOENT") {
        log.warn("volume-janitor", `failed to stat Codex log database ${databasePath}: ${err.message}`);
      }
    }
  }

  return stats.sort((a, b) => b.size - a.size);
}

function removeCodexLogDatabase(databasePath) {
  let freedBytes = 0;
  const errors = [];
  const paths = [
    databasePath,
    `${databasePath}-shm`,
    `${databasePath}-wal`,
  ];

  for (const filePath of paths) {
    try {
      freedBytes += getPathSize(filePath);
      fs.rmSync(filePath, { force: true });
    } catch (err) {
      errors.push(`${filePath}: ${err.message}`);
    }
  }

  return { freedBytes, errors };
}

function cleanupOversizedCodexLogDatabases() {
  const stats = getCodexLogDatabaseStats();
  const oversized = stats.filter((stat) => stat.size > CODEX_LOG_DB_MAX_BYTES);
  const errors = [];
  let removed = 0;
  let freedBytes = 0;

  for (const stat of oversized) {
    const result = removeCodexLogDatabase(stat.path);
    freedBytes += result.freedBytes;
    if (result.errors.length > 0) {
      errors.push(...result.errors);
      continue;
    }
    removed += 1;
  }

  return { stats, oversized, removed, freedBytes, errors };
}

function cleanupVolumeTrash() {
  let removed = 0;
  let freedBytes = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(RAILWAY_VOLUME_PATH, { withFileTypes: true });
  } catch {
    return { removed, freedBytes };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".Trash-")) {
      continue;
    }

    const trashDir = path.join(RAILWAY_VOLUME_PATH, entry.name);
    let trashEntries = [];
    try {
      trashEntries = fs.readdirSync(trashDir, { withFileTypes: true });
    } catch (err) {
      log.warn("volume-cleanup", `failed to read trash directory ${trashDir}: ${err.message}`);
      continue;
    }

    for (const trashEntry of trashEntries) {
      const trashPath = path.join(trashDir, trashEntry.name);
      try {
        freedBytes += rmPath(trashPath);
        removed += 1;
      } catch (err) {
        log.warn("volume-cleanup", `failed to empty trash path ${trashPath}: ${err.message}`);
      }
    }
  }

  return { removed, freedBytes };
}

function findFirstUnwritablePluginRuntimeDepsPath() {
  const depsDir = path.join(STATE_DIR, "plugin-runtime-deps");
  let entries = [];

  try {
    fs.accessSync(depsDir, fs.constants.W_OK | fs.constants.X_OK);
    entries = fs.readdirSync(depsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return null;
    return { path: depsDir, error: err.message };
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(depsDir, entry.name));

  while (dirs.length > 0) {
    const dirPath = dirs.pop();
    try {
      fs.accessSync(dirPath, fs.constants.W_OK | fs.constants.X_OK);
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          dirs.push(path.join(dirPath, entry.name));
        }
      }
    } catch (err) {
      return { path: dirPath, error: err.message };
    }
  }

  return null;
}

function exitIfPluginRuntimeDepsUnwritable() {
  const unwritable = findFirstUnwritablePluginRuntimeDepsPath();
  if (!unwritable) return false;

  log.error(
    "volume-cleanup",
    `plugin runtime cache is not writable at ${unwritable.path}: ${unwritable.error}`,
  );
  log.error(
    "volume-cleanup",
    "exiting so Railway restarts the container and entrypoint repairs /data ownership",
  );
  process.exit(1);
  return true;
}

async function cleanupVolumeBeforeBoot() {
  const sessions = cleanupStaleSessionTempFiles();
  const codexLogs = cleanupOversizedCodexLogDatabases();
  const { version } = await getOpenclawInfo();
  const pluginDeps = cleanupStalePluginRuntimeDeps(extractOpenclawVersion(version));
  const pluginStores = cleanupPluginRuntimePnpmStores();
  const externalPluginDeps = cleanupStatePluginRuntimeDepsForExternalStageDir();
  const codexTransient = cleanupCodexTransientFiles();
  const trash = cleanupVolumeTrash();
  const removed =
    sessions.removed +
    codexLogs.removed +
    pluginDeps.removed +
    pluginStores.removed +
    externalPluginDeps.removed +
    codexTransient.removed +
    trash.removed;
  const freedBytes =
    sessions.freedBytes +
    codexLogs.freedBytes +
    pluginDeps.freedBytes +
    pluginStores.freedBytes +
    externalPluginDeps.freedBytes +
    codexTransient.freedBytes +
    trash.freedBytes;

  for (const error of codexLogs.errors) {
    log.warn("volume-cleanup", `failed to remove oversized Codex log database ${error}`);
  }

  if (removed === 0) {
    log.info("volume-cleanup", "no stale OpenClaw volume artifacts found");
    return;
  }

  log.info(
    "volume-cleanup",
    `removed ${removed} stale artifacts, freeing about ${formatBytes(freedBytes)} ` +
      `(sessionTemp=${sessions.removed}, codexLogs=${codexLogs.removed}, ` +
      `pluginRuntimeCaches=${pluginDeps.removed}, ` +
      `pluginRuntimeStores=${pluginStores.removed}, ` +
      `externalPluginRuntimeCaches=${externalPluginDeps.removed}, ` +
      `codexTransient=${codexTransient.removed}, trash=${trash.removed})`,
  );
}

function readConfig() {
  return readJsonFile(configPath());
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

function isDummyCredential(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "dummy" || normalized === "not-needed";
}

function getConfiguredModel() {
  return String(readConfig()?.agents?.defaults?.model?.primary ?? "").trim();
}

function normalizeOpenaiCodexModel(model) {
  const normalized = String(model ?? "").trim();
  if (!normalized) {
    return DEFAULT_OPENAI_CODEX_MODEL;
  }
  if (normalized.startsWith("openai-codex/")) {
    return `codex/${normalized.slice("openai-codex/".length)}`;
  }
  if (normalized.startsWith("openai/")) {
    return `codex/${normalized.slice("openai/".length)}`;
  }
  if (normalized.startsWith("codex/")) {
    return normalized;
  }
  return "";
}

function removeCodexOpenaiRuntime(config) {
  const openaiProvider = config?.models?.providers?.openai;
  if (!openaiProvider || typeof openaiProvider !== "object") {
    return false;
  }
  if (openaiProvider.agentRuntime?.id !== "codex") {
    return false;
  }

  delete openaiProvider.agentRuntime;
  return true;
}

function collectAgentModelOwners(config) {
  const owners = [];
  if (config?.agents?.defaults && typeof config.agents.defaults === "object") {
    owners.push({ id: "agents.defaults", value: config.agents.defaults });
  }
  if (Array.isArray(config?.agents?.list)) {
    for (const agent of config.agents.list) {
      if (agent && typeof agent === "object") {
        owners.push({ id: `agents.list.${agent.id || "unknown"}`, value: agent });
      }
    }
  }

  return owners;
}

function removeStaleCodexModelRuntimePins(config) {
  const owners = collectAgentModelOwners(config);
  const changed = [];
  for (const owner of owners) {
    const models = owner.value.models;
    if (!models || typeof models !== "object") {
      continue;
    }

    for (const [modelRef, entry] of Object.entries(models)) {
      if (
        !modelRef.startsWith("openai/") &&
        !modelRef.startsWith("openai-codex/") &&
        !modelRef.startsWith("codex/")
      ) {
        continue;
      }
      if (!entry || typeof entry !== "object") {
        continue;
      }
      if (entry.agentRuntime?.id !== "codex") {
        continue;
      }

      delete entry.agentRuntime;
      if (Object.keys(entry).length === 0) {
        delete models[modelRef];
      }
      changed.push(`${owner.id}.models.${modelRef}.agentRuntime`);
    }
  }

  return changed;
}

function migrateLegacyCodexModelEntries(config) {
  const changed = [];
  for (const owner of collectAgentModelOwners(config)) {
    const models = owner.value.models;
    if (!models || typeof models !== "object") {
      continue;
    }

    for (const [modelRef, entry] of Object.entries(models)) {
      if (!modelRef.startsWith("openai-codex/") && !modelRef.startsWith("openai/")) {
        continue;
      }

      const migratedRef = normalizeOpenaiCodexModel(modelRef);
      if (!migratedRef) {
        continue;
      }

      const migratedEntry =
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? { ...entry }
          : {};
      if (migratedEntry.agentRuntime?.id === "codex") {
        delete migratedEntry.agentRuntime;
      }

      if (Object.keys(migratedEntry).length > 0) {
        const existingEntry = models[migratedRef];
        models[migratedRef] =
          existingEntry && typeof existingEntry === "object" && !Array.isArray(existingEntry)
            ? { ...migratedEntry, ...existingEntry }
            : migratedEntry;
      }

      delete models[modelRef];
      changed.push({
        ownerId: owner.id,
        from: modelRef,
        to: migratedRef,
        migratedConfig: Object.keys(migratedEntry).length > 0,
      });
    }
  }

  return changed;
}

function toRfc3339(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  return "";
}

function repairCodexAgentModelOverrides(config, targetModel) {
  const agents = config?.agents?.list;
  if (!Array.isArray(agents)) {
    return [];
  }

  const normalizedTarget = normalizeOpenaiCodexModel(targetModel);
  if (!normalizedTarget) {
    return [];
  }

  const changed = [];
  for (const agent of agents) {
    if (!agent || typeof agent !== "object") {
      continue;
    }

    const agentId = String(agent.id ?? "").trim();
    const runtimeId = String(agent.agentRuntime?.id ?? "").trim();
    const model = String(agent.model ?? "").trim();
    if (model === normalizedTarget) {
      continue;
    }
    if (
      !model.startsWith("openai/") &&
      !model.startsWith("openai-codex/") &&
      !model.startsWith("codex/")
    ) {
      continue;
    }

    agent.model = normalizedTarget;
    changed.push({
      agentId: agentId || runtimeId || "codex",
      from: model,
      to: normalizedTarget,
    });
  }

  if (changed.length > 0) {
    if (!config.agents.defaults || typeof config.agents.defaults !== "object") {
      config.agents.defaults = {};
    }
    if (!config.agents.defaults.models || typeof config.agents.defaults.models !== "object") {
      config.agents.defaults.models = {};
    }
    if (!config.agents.defaults.models[normalizedTarget]) {
      config.agents.defaults.models[normalizedTarget] = {};
    }
  }

  return changed;
}

function getCodexCompatibleOauthProfile(authStore) {
  const profiles = authStore?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return null;
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    if (
      (profile?.provider !== "openai-codex" && profile?.provider !== "openai") ||
      profile?.type !== "oauth"
    ) {
      continue;
    }

    const tokens = profile.tokens || {};
    const accessToken =
      String(profile.access ?? "").trim() ||
      String(tokens.access_token ?? "").trim();
    const refreshToken =
      String(profile.refresh ?? "").trim() ||
      String(tokens.refresh_token ?? "").trim();
    const idToken =
      String(profile.id_token ?? "").trim() ||
      String(profile.idToken ?? "").trim() ||
      String(tokens.id_token ?? "").trim() ||
      accessToken;
    if (!accessToken || !refreshToken || !idToken) {
      continue;
    }

    return {
      profileId,
      accessToken,
      refreshToken,
      idToken,
      expiresAt: toRfc3339(
        profile.expiresAt ??
        profile.expires ??
        tokens.expires_at ??
        tokens.expiry,
      ),
    };
  }

  return null;
}

function syncCodexCliAuthFromOpenClawProfile(authStore) {
  const profile = getCodexCompatibleOauthProfile(authStore);
  if (!profile) {
    return { ok: true, changed: false, profileId: "", reason: "no-profile" };
  }

  const current = readJsonFile(CODEX_AUTH_PATH) || {};
  const currentTokens = current.tokens || {};
  const nextTokens = {
    id_token: profile.idToken,
    access_token: profile.accessToken,
    refresh_token: profile.refreshToken,
  };
  if (profile.expiresAt) {
    nextTokens.expires_at = profile.expiresAt;
  }

  const alreadySynced =
    current.auth_mode === "chatgpt" &&
    currentTokens.id_token === nextTokens.id_token &&
    currentTokens.access_token === nextTokens.access_token &&
    currentTokens.refresh_token === nextTokens.refresh_token &&
    (currentTokens.expires_at || "") === (nextTokens.expires_at || "");
  if (alreadySynced) {
    return { ok: true, changed: false, profileId: profile.profileId, reason: "up-to-date" };
  }

  const nextAuth = {
    auth_mode: "chatgpt",
    tokens: nextTokens,
    last_refresh: new Date().toISOString(),
  };

  try {
    writeJsonFile(CODEX_AUTH_PATH, nextAuth);
    fs.chmodSync(CODEX_AUTH_PATH, 0o600);
    return { ok: true, changed: true, profileId: profile.profileId, reason: "synced" };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      profileId: profile.profileId,
      reason: err.message,
    };
  }
}

function getModelAuthStore() {
  return readJsonFile(MODEL_AUTH_STORE_PATH);
}

function hasOauthProfile(authStore, provider) {
  const profiles = authStore?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return false;
  }

  return Object.values(profiles).some((profile) => (
    profile?.provider === provider &&
    profile?.type === "oauth" &&
    (
      String(profile?.access ?? "").trim() ||
      String(profile?.refresh ?? "").trim() ||
      String(profile?.tokens?.access_token ?? "").trim() ||
      String(profile?.tokens?.refresh_token ?? "").trim()
    )
  ));
}

function hasProviderCredential(authStore, provider) {
  const profiles = authStore?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return false;
  }

  return Object.values(profiles).some((profile) => {
    if (profile?.provider !== provider) {
      return false;
    }

    const tokens = profile?.tokens || {};
    return Boolean(
      (
        profile?.type === "api_key" &&
        !isDummyCredential(profile?.key) &&
        String(profile?.key ?? "").trim()
      ) ||
      (
        profile?.type === "token" &&
        !isDummyCredential(profile?.token) &&
        String(profile?.token ?? "").trim()
      ) ||
      (
        profile?.type === "oauth" &&
        (
          String(profile?.access ?? "").trim() ||
          String(profile?.refresh ?? "").trim() ||
          String(tokens.access_token ?? "").trim() ||
          String(tokens.refresh_token ?? "").trim()
        )
      )
    );
  });
}

function removePlaceholderAuthProfiles(authStore) {
  const profiles = authStore?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return [];
  }

  const removed = [];
  for (const [profileId, profile] of Object.entries(profiles)) {
    const placeholderKey =
      profile?.type === "api_key" && isDummyCredential(profile?.key);
    const placeholderToken =
      profile?.type === "token" && isDummyCredential(profile?.token);
    if (!placeholderKey && !placeholderToken) {
      continue;
    }
    delete profiles[profileId];
    removed.push(profileId);
  }
  return removed;
}

function removeConfigAuthProfiles(profileIds) {
  if (!profileIds.length) {
    return { changed: false, removed: [] };
  }

  const config = readConfig();
  const profiles = config?.auth?.profiles;
  if (!profiles || typeof profiles !== "object") {
    return { changed: false, removed: [] };
  }

  const removed = [];
  for (const profileId of profileIds) {
    if (!Object.prototype.hasOwnProperty.call(profiles, profileId)) {
      continue;
    }
    delete profiles[profileId];
    removed.push(profileId);
  }

  if (!removed.length) {
    return { changed: false, removed: [] };
  }

  if (Object.keys(profiles).length === 0) {
    delete config.auth.profiles;
    if (Object.keys(config.auth).length === 0) {
      delete config.auth;
    }
  }

  writeJsonFile(configPath(), config);
  return { changed: true, removed };
}

function ensureCodexWorkspaceTrust(projectPath) {
  const normalizedPath = String(projectPath ?? "").trim();
  const header = `[projects.${JSON.stringify(normalizedPath)}]`;

  try {
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    let current = "";
    try {
      current = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
    } catch {}

    if (current.includes(header)) {
      try {
        fs.chmodSync(CODEX_CONFIG_PATH, 0o600);
      } catch {}
      return { ok: true, changed: false, path: CODEX_CONFIG_PATH };
    }

    const block = `${header}\ntrust_level = "trusted"\n`;
    const next = current.trimEnd()
      ? `${current.trimEnd()}\n\n${block}`
      : block;
    fs.writeFileSync(CODEX_CONFIG_PATH, next, "utf8");
    fs.chmodSync(CODEX_CONFIG_PATH, 0o600);
    return { ok: true, changed: true, path: CODEX_CONFIG_PATH };
  } catch (err) {
    return {
      ok: false,
      changed: false,
      path: CODEX_CONFIG_PATH,
      error: err.message,
    };
  }
}

function isCodexWorkspaceTrusted(projectPath) {
  const normalizedPath = String(projectPath ?? "").trim();
  const header = `[projects.${JSON.stringify(normalizedPath)}]`;
  try {
    const current = fs.readFileSync(CODEX_CONFIG_PATH, "utf8");
    return current.includes(header);
  } catch {
    return false;
  }
}

function getCodexAuthStatus() {
  let fileAuthMode = null;
  let fileKey = "";
  let hasOauthTokens = false;

  try {
    const raw = readJsonFile(CODEX_AUTH_PATH) || {};
    fileAuthMode = raw?.auth_mode ?? null;
    fileKey =
      raw?.CODEX_API_KEY?.trim() || raw?.OPENAI_API_KEY?.trim() || "";
    hasOauthTokens = Boolean(
      raw?.tokens?.id_token &&
      raw?.tokens?.access_token &&
      raw?.tokens?.refresh_token &&
      raw?.auth_mode === "chatgpt"
    );
  } catch {}

  const envOpenAiKey = process.env.OPENAI_API_KEY?.trim() || "";
  const envCodexKey = process.env.CODEX_API_KEY?.trim() || "";
  const effectiveKey =
    (!isDummyCredential(envCodexKey) && envCodexKey) ||
    (!isDummyCredential(envOpenAiKey) && envOpenAiKey) ||
    (!isDummyCredential(fileKey) && fileKey) ||
    "";

  return {
    authPath: CODEX_AUTH_PATH,
    fileAuthMode,
    envOpenAiPlaceholder: isDummyCredential(envOpenAiKey),
    envCodexPlaceholder: isDummyCredential(envCodexKey),
    filePlaceholder: isDummyCredential(fileKey),
    hasOauthTokens,
    hasPlaceholderOnly: !Boolean(effectiveKey || hasOauthTokens) && Boolean(
      isDummyCredential(fileKey) ||
      isDummyCredential(envOpenAiKey) ||
      isDummyCredential(envCodexKey)
    ),
    hasUsableCredential: Boolean(effectiveKey || hasOauthTokens),
  };
}

async function setDefaultModelWithFallback(model) {
  const attempts = [];
  const normalized = String(model ?? "").trim();
  if (normalized) {
    attempts.push(normalized);
  }
  if (!attempts.includes(DEFAULT_OPENAI_CODEX_MODEL)) {
    attempts.push(DEFAULT_OPENAI_CODEX_MODEL);
  }

  let lastResult = null;
  for (const attempt of attempts) {
    const result = await runCmd(OPENCLAW_NODE, clawArgs(["models", "set", attempt]));
    lastResult = { ...result, model: attempt };
    if (result.code === 0) {
      return { ok: true, changed: getConfiguredModel() !== attempt, ...lastResult };
    }
  }

  return { ok: false, changed: false, ...(lastResult || { code: 1, output: "", model: "" }) };
}

async function repairModelAuth(reason = "Repairing model auth") {
  let output = `[model auth repair] ${reason}\n`;

  const sync = await runCmd(OPENCLAW_NODE, clawArgs(["models", "status", "--json"]));
  output += `[models status --json] exit=${sync.code}\n`;
  if (sync.output) {
    output += `${sync.output}\n`;
  }

  const authStore = getModelAuthStore();
  if (!authStore?.profiles || typeof authStore.profiles !== "object") {
    output += `[model auth repair] no auth profile store found at ${MODEL_AUTH_STORE_PATH}\n`;
    return {
      ok: sync.code === 0,
      changed: false,
      output,
    };
  }

  let changed = false;
  const removedProfiles = removePlaceholderAuthProfiles(authStore);
  if (removedProfiles.length > 0) {
    writeJsonFile(MODEL_AUTH_STORE_PATH, authStore);
    changed = true;
    output += `[auth-profiles] removed placeholder profiles: ${removedProfiles.join(", ")}\n`;

    const configCleanup = removeConfigAuthProfiles(removedProfiles);
    if (configCleanup.changed) {
      output += `[config] removed auth profile entries: ${configCleanup.removed.join(", ")}\n`;
    }
  }

  const currentModel = getConfiguredModel();
  const hasOpenaiPlaceholder = removedProfiles.some((profileId) => (
    profileId === "openai:default" || profileId.startsWith("openai:")
  ));
  const hasOpenaiCodexOauth =
    hasOauthProfile(authStore, "openai-codex") ||
    hasOauthProfile(authStore, "openai");
  const hasOpenaiCredential =
    hasProviderCredential(authStore, "openai") ||
    Boolean(
      process.env.OPENAI_API_KEY?.trim() &&
      !isDummyCredential(process.env.OPENAI_API_KEY),
    );
  const codexCliAuth = syncCodexCliAuthFromOpenClawProfile(authStore);
  if (!codexCliAuth.ok) {
    output += `[codex auth] failed to sync Codex CLI auth: ${codexCliAuth.reason}\n`;
  } else if (codexCliAuth.changed) {
    changed = true;
    output += `[codex auth] synced Codex CLI auth from ${codexCliAuth.profileId} to ${CODEX_AUTH_PATH}\n`;
  }

  if (
    hasOpenaiCodexOauth &&
    currentModel &&
    (
      currentModel.startsWith("openai/") ||
      currentModel.startsWith("openai-codex/") ||
      currentModel.startsWith("codex/")
    ) &&
    (
      currentModel.startsWith("openai/") ||
      currentModel.startsWith("openai-codex/") ||
      hasOpenaiPlaceholder ||
      !hasOpenaiCredential
    )
  ) {
    const preferredModel = normalizeOpenaiCodexModel(currentModel);
    const setResult = await setDefaultModelWithFallback(preferredModel);
    output += `[models set ${setResult.model}] exit=${setResult.code}\n`;
    if (setResult.output) {
      output += `${setResult.output}\n`;
    }
    if (setResult.ok) {
      changed = true;
      output += `[model auth repair] switched default model from ${currentModel} to ${setResult.model}\n`;
    } else {
      output += "[model auth repair] unable to switch to an OpenAI model automatically\n";
    }
  } else if (hasOpenaiPlaceholder && !hasOpenaiCodexOauth) {
    output += "[model auth repair] removed placeholder OpenAI auth, but no openai-codex OAuth profile was available for automatic migration\n";
  }

  const latestConfig = readConfig();
  const codexTargetModel = normalizeOpenaiCodexModel(
    getConfiguredModel() || DEFAULT_OPENAI_CODEX_MODEL,
  );
  if (
    latestConfig &&
    typeof latestConfig === "object" &&
    hasOpenaiCodexOauth &&
    codexTargetModel.startsWith("codex/")
  ) {
    const runtimeChanged = removeCodexOpenaiRuntime(latestConfig);
    if (runtimeChanged) {
      changed = true;
      output += "[model auth repair] removed stale models.providers.openai.agentRuntime.id\n";
    }

    const staleRuntimePins = removeStaleCodexModelRuntimePins(latestConfig);
    if (staleRuntimePins.length > 0) {
      changed = true;
      for (const pin of staleRuntimePins) {
        output += `[model auth repair] removed stale ${pin}\n`;
      }
    }

    const legacyModelEntries = migrateLegacyCodexModelEntries(latestConfig);
    if (legacyModelEntries.length > 0) {
      changed = true;
      for (const entry of legacyModelEntries) {
        const action = entry.migratedConfig ? "migrated" : "removed";
        output += `[model auth repair] ${action} stale ${entry.ownerId}.models.${entry.from}`;
        output += ` (canonical model: ${entry.to})\n`;
      }
    }

    const agentModelChanges = repairCodexAgentModelOverrides(
      latestConfig,
      codexTargetModel,
    );
    if (agentModelChanges.length > 0) {
      changed = true;
      for (const change of agentModelChanges) {
        output += `[model auth repair] switched ${change.agentId} agent model from ${change.from} to ${change.to}\n`;
      }
    }

    if (
      runtimeChanged ||
      staleRuntimePins.length > 0 ||
      legacyModelEntries.length > 0 ||
      agentModelChanges.length > 0
    ) {
      writeJsonFile(configPath(), latestConfig);
    }
  }

  return {
    ok: true,
    changed,
    output,
  };
}

async function repairMissingCodexSessionTranscripts(
  reason = "Repairing missing Codex session transcripts",
) {
  let output = `[session repair] ${reason}\n`;
  const store = readJsonFile(CODEX_SESSIONS_STORE_PATH);
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    output += `[session repair] skipped (store missing or unreadable at ${CODEX_SESSIONS_STORE_PATH})\n`;
    return { ok: true, changed: false, output };
  }

  const sessionsDir = path.dirname(CODEX_SESSIONS_STORE_PATH);
  const kept = {};
  const removed = [];

  for (const [sessionKey, entry] of Object.entries(store)) {
    if (!entry || typeof entry !== "object") {
      kept[sessionKey] = entry;
      continue;
    }

    const sessionId = String(entry.sessionId ?? "").trim();
    const sessionFile = String(
      entry.sessionFile ||
        (sessionId ? path.join(sessionsDir, `${sessionId}.jsonl`) : ""),
    ).trim();
    const transcriptMissing = Boolean(
      sessionFile && !fs.existsSync(sessionFile),
    );
    if (!transcriptMissing) {
      kept[sessionKey] = entry;
      continue;
    }

    removed.push({
      sessionKey,
      sessionId,
      sessionFile,
      status: entry.status || "",
    });
  }

  if (removed.length === 0) {
    output += "[session repair] no missing Codex session transcripts found\n";
    return { ok: true, changed: false, output };
  }

  try {
    const backupPath =
      `${CODEX_SESSIONS_STORE_PATH}.missing-transcripts.${timestampForFileName()}.bak`;
    fs.copyFileSync(CODEX_SESSIONS_STORE_PATH, backupPath);
    writeJsonFile(CODEX_SESSIONS_STORE_PATH, kept);
    output += `[session repair] removed ${removed.length} stale Codex session entries with missing transcripts\n`;
    output += `[session repair] backup: ${backupPath}\n`;
    for (const removedEntry of removed.slice(0, 20)) {
      output +=
        `[session repair] removed ${removedEntry.sessionKey} ` +
        `(${removedEntry.sessionId || "no-session-id"})\n`;
    }
    if (removed.length > 20) {
      output += `[session repair] ...and ${removed.length - 20} more\n`;
    }
    return { ok: true, changed: true, output };
  } catch (err) {
    output += `[session repair] write failed: ${err.message}\n`;
    return { ok: false, changed: false, output };
  }
}

async function repairOversizedCodexLogDatabase(
  reason = "Repairing oversized Codex log database",
) {
  let output =
    `[codex log repair] ${reason} ` +
    `(max ${formatBytes(CODEX_LOG_DB_MAX_BYTES)})\n`;

  const cleanup = cleanupOversizedCodexLogDatabases();
  if (cleanup.stats.length === 0) {
    output += "[codex log repair] no Codex log database found\n";
    return { ok: true, changed: false, output };
  }

  if (cleanup.oversized.length === 0) {
    const largest = cleanup.stats[0];
    output +=
      `[codex log repair] largest Codex log database is ${formatBytes(largest.size)} ` +
      `at ${largest.path}; ` +
      "no cleanup needed\n";
    return { ok: true, changed: false, output };
  }

  if (cleanup.removed > 0) {
    output +=
      `[codex log repair] removed ${cleanup.removed} oversized Codex log ` +
      `database${cleanup.removed === 1 ? "" : "s"}, freeing about ` +
      `${formatBytes(cleanup.freedBytes)}\n`;
  }

  for (const stat of cleanup.oversized.slice(0, 10)) {
    output +=
      `[codex log repair] oversized: ${formatBytes(stat.size)} ${stat.path}\n`;
  }
  if (cleanup.oversized.length > 10) {
    output +=
      `[codex log repair] ...and ${cleanup.oversized.length - 10} more\n`;
  }
  for (const error of cleanup.errors) {
    output += `[codex log repair] cleanup failed: ${error}\n`;
  }

  return {
    ok: cleanup.errors.length === 0,
    changed: cleanup.removed > 0,
    output,
  };
}

function buildChildEnv(extra = {}, opts = {}) {
  const quiet = opts.quiet === true;
  const env = {
    ...process.env,
    CODEX_HOME,
    ...extra,
  };

  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY"]) {
    if (isDummyCredential(env[key])) {
      delete env[key];
      if (!quiet) {
        log.warn(
          "env",
          `${key} placeholder removed from child process environment; child runtimes need a real key or CLI login`,
        );
      }
    }
  }

  for (const [key, relatedKeys] of [
    ["ANTHROPIC_API_KEY", ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE"]],
    ["CLAUDEMAX_API_KEY", ["CLAUDEMAX_BASE_URL", "CLAUDEMAX_API"]],
  ]) {
    if (isDummyCredential(env[key])) {
      delete env[key];
      for (const relatedKey of relatedKeys) {
        delete env[relatedKey];
      }
      if (!quiet) {
        log.warn(
          "env",
          `${key} dummy placeholder removed from child process environment; Claude ACP needs a real setup-token or API key`,
        );
      }
    }
  }

  return env;
}

async function ensureCodexCliSupport() {
  let output = "";

  const trust = ensureCodexWorkspaceTrust(WORKSPACE_DIR);
  if (trust.ok) {
    output += `[codex config] workspace trust ${trust.changed ? "updated" : "ok"} (${trust.path})\n`;
  } else {
    output += `[codex config] failed (${trust.path}): ${trust.error}\n`;
  }

  let codexVersion = await runCmd("codex", ["--version"]);
  if (codexVersion.code !== 0 || !codexVersion.output.includes(CODEX_CLI_VERSION)) {
    const install = await runCmd("npm", [
      "install",
      "-g",
      `@openai/codex@${CODEX_CLI_VERSION}`,
    ]);
    output += `[npm install -g @openai/codex@${CODEX_CLI_VERSION}] exit=${install.code}\n${install.output || ""}`;
    codexVersion = await runCmd("codex", ["--version"]);
  }

  output += `[codex --version] exit=${codexVersion.code}\n${codexVersion.output || ""}`;

  const auth = getCodexAuthStatus();
  output += `[codex auth] mode=${auth.fileAuthMode || "none"} usable=${auth.hasUsableCredential} placeholder=${auth.hasPlaceholderOnly}\n`;

  if (!auth.hasUsableCredential) {
    output +=
      "[codex auth] Codex ACP on Railway needs a real OPENAI_API_KEY or CODEX_API_KEY. Placeholder values like 'not-needed' or 'dummy' are not usable.\n";
  }

  return output;
}

async function syncAllowedOrigins() {
  const publicDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!publicDomain) return;

  const origin = `https://${publicDomain}`;

  const current = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "get", "gateway.controlUi.allowedOrigins"]),
  );
  if (current.code === 0 && current.output.includes(origin)) {
    return;
  }

  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowedOrigins",
      JSON.stringify([origin]),
    ]),
  );
  if (result.code === 0) {
    log.info("gateway", `set allowedOrigins to [${origin}]`);
  } else {
    log.warn("gateway", `failed to set allowedOrigins (exit=${result.code})`);
  }
}

let gatewayProc = null;
let gatewayStarting = null;
let shuttingDown = false;
let gatewayRestartCount = 0;
let gatewayLastStartTime = 0;
let intentionalRestart = false;
let gmailWatcherProc = null;
let gmailWatcherStarting = null;
let gmailWatcherRestartCount = 0;
let gmailWatcherLastStartTime = 0;
let intentionalGmailWatcherRestart = false;
let gmailWatcherConfigSignature = null;

function isTcpReachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      finish(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

// Short-lived cache of whether the Gmail watcher is accepting connections on
// its local port. Used by the /gmail-pubsub fast-fail path so Google Pub/Sub
// pushes don't hold sockets open waiting for ECONNREFUSED, which under retry
// amplification can exhaust the container's PID/FD limits and take down the
// wrapper.
const GMAIL_WATCHER_REACHABLE_CACHE_MS = 2_000;
const GMAIL_WATCHER_REACHABLE_PROBE_TIMEOUT_MS = 250;
let gmailWatcherReachableCache = { ok: false, expiresAt: 0 };

async function isGmailWatcherReachable() {
  const now = Date.now();
  if (now < gmailWatcherReachableCache.expiresAt) {
    return gmailWatcherReachableCache.ok;
  }
  const ok = await isTcpReachable(
    GMAIL_WATCHER_HOST,
    GMAIL_WATCHER_PORT,
    GMAIL_WATCHER_REACHABLE_PROBE_TIMEOUT_MS,
  );
  gmailWatcherReachableCache = {
    ok,
    expiresAt: Date.now() + GMAIL_WATCHER_REACHABLE_CACHE_MS,
  };
  return ok;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getGmailWatcherConfig() {
  const config = readConfig();
  if (!config?.hooks?.enabled || !config?.hooks?.gmail) {
    return null;
  }
  return config.hooks.gmail;
}

function getGmailWatcherSignature(gmailConfig) {
  if (!gmailConfig) return null;
  return JSON.stringify({
    account: gmailConfig.account,
    label: gmailConfig.label,
    topic: gmailConfig.topic,
    subscription: gmailConfig.subscription,
    pushToken: gmailConfig.pushToken,
    hookUrl: gmailConfig.hookUrl,
    includeBody: gmailConfig.includeBody,
    maxBytes: gmailConfig.maxBytes,
    renewEveryMinutes: gmailConfig.renewEveryMinutes,
    serve: gmailConfig.serve,
    tailscale: gmailConfig.tailscale,
  });
}

function getGmailWatcherProbeUrl(gmailConfig) {
  const serve = gmailConfig?.serve ?? {};
  const bind = serve.bind || GMAIL_WATCHER_HOST;
  const port = serve.port || GMAIL_WATCHER_PORT;
  const watcherPath = normalizeProxyBasePath(
    serve.path || GMAIL_WATCHER_PATH,
  );
  const url = new URL(`http://${bind}:${port}${watcherPath}`);
  if (gmailConfig?.pushToken) {
    url.searchParams.set("token", gmailConfig.pushToken);
  }
  return url.toString();
}

function normalizeProxyBasePath(rawPath) {
  const value = String(rawPath ?? "").trim();
  if (!value || value === "/") return "/";
  return (value.startsWith("/") ? value : `/${value}`).replace(/\/+$/, "");
}

function matchesProxyBasePath(requestPath, basePath) {
  if (!requestPath || !basePath) return false;
  if (basePath === "/") return true;
  return requestPath === basePath || requestPath.startsWith(`${basePath}/`);
}

async function probeGatewayOnce() {
  const endpoints = ["/openclaw", "/", "/health"];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
        method: "GET",
      });
      if (res) {
        return { ok: true, endpoint };
      }
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
        const msg = err.code || err.message;
        if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
          log.warn("gateway", `health check error: ${msg}`);
        }
      }
    }
  }

  return { ok: false, endpoint: null };
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const probe = await probeGatewayOnce();
    if (probe.ok) {
      log.info("gateway", `ready at ${probe.endpoint}`);
      return true;
    }
    await sleep(250);
  }
  log.error("gateway", `failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  if (exitIfPluginRuntimeDepsUnwritable()) return;
  const codexTrust = ensureCodexWorkspaceTrust(WORKSPACE_DIR);
  if (codexTrust.ok && codexTrust.changed) {
    log.info("gateway", `trusted Codex workspace at ${WORKSPACE_DIR}`);
  } else if (!codexTrust.ok) {
    log.warn("gateway", `failed to prepare Codex config: ${codexTrust.error}`);
  }

  try {
    const authRepair = await repairModelAuth(
      "Gateway start repair for model auth",
    );
    log.info("gateway", authRepair.output.trimEnd());
  } catch (err) {
    log.warn("gateway", `model auth repair before start failed: ${err.message}`);
  }

  const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  log.info("gateway", `stop existing gateway exit=${stopResult.code}`);

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
    "--allow-unconfigured",
  ];

  gatewayLastStartTime = Date.now();
  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: buildChildEnv({
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    }),
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  log.info("gateway", `starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`);
  log.info("gateway", `STATE_DIR: ${STATE_DIR}`);
  log.info("gateway", `WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  log.info("gateway", `config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    log.error("gateway", `spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    log.error("gateway", `exited code=${code} signal=${signal}`);
    const uptime = Date.now() - gatewayLastStartTime;
    gatewayProc = null;
    if (!shuttingDown && !intentionalRestart && isConfigured()) {
      if (uptime > 30_000) {
        gatewayRestartCount = 0;
      } else {
        gatewayRestartCount++;
      }
      const delay = Math.min(2000 * Math.pow(2, gatewayRestartCount), 60_000);
      log.info("gateway", `scheduling auto-restart in ${delay / 1000}s (attempt ${gatewayRestartCount}, uptime ${Math.round(uptime / 1000)}s)...`);
      setTimeout(async () => {
        if (shuttingDown || gatewayProc || !isConfigured()) {
          return;
        }

        const probe = await probeGatewayOnce();
        if (probe.ok) {
          log.info(
            "gateway",
            `gateway still reachable at ${probe.endpoint}; assuming OpenClaw restarted itself`,
          );
          gatewayRestartCount = 0;
          return;
        }

        ensureGatewayRunning().catch((err) => {
          log.error("gateway", `auto-restart failed: ${err.message}`);
        });
      }, delay);
    }
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  const probe = await probeGatewayOnce();
  if (probe.ok) {
    return { ok: true, reason: "reachable" };
  }
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await syncAllowedOrigins();
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function probeGmailWatcherOnce() {
  const gmailConfig = getGmailWatcherConfig();
  if (!gmailConfig) {
    return { ok: false, reason: "not configured" };
  }

  try {
    const res = await fetch(getGmailWatcherProbeUrl(gmailConfig), {
      method: "GET",
    });
    return { ok: true, status: res.status };
  } catch (err) {
    if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
      const msg = err.code || err.message;
      if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
        log.warn("gmail-watcher", `health check error: ${msg}`);
      }
    }
    return { ok: false, reason: "unreachable" };
  }
}

async function waitForGmailWatcherReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const probe = await probeGmailWatcherOnce();
    if (probe.ok) {
      log.info("gmail-watcher", `ready (status=${probe.status})`);
      return true;
    }
    await sleep(500);
  }

  log.error(
    "gmail-watcher",
    `failed to become ready after ${timeoutMs / 1000} seconds`,
  );
  return false;
}

async function startGmailWatcher() {
  if (gmailWatcherProc) return;

  const gmailConfig = getGmailWatcherConfig();
  if (!gmailConfig) {
    throw new Error("Gmail watcher cannot start: not configured");
  }

  gmailWatcherConfigSignature = getGmailWatcherSignature(gmailConfig);
  gmailWatcherLastStartTime = Date.now();
  gmailWatcherProc = childProcess.spawn(
    OPENCLAW_NODE,
    clawArgs(["webhooks", "gmail", "run"]),
    {
      stdio: "inherit",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    },
  );

  log.info(
    "gmail-watcher",
    `starting with command: ${OPENCLAW_NODE} ${clawArgs(["webhooks", "gmail", "run"]).join(" ")}`,
  );

  gmailWatcherProc.on("error", (err) => {
    log.error("gmail-watcher", `spawn error: ${String(err)}`);
    gmailWatcherProc = null;
  });

  gmailWatcherProc.on("exit", (code, signal) => {
    log.error("gmail-watcher", `exited code=${code} signal=${signal}`);
    const uptime = Date.now() - gmailWatcherLastStartTime;
    gmailWatcherProc = null;
    if (!shuttingDown && !intentionalGmailWatcherRestart && getGmailWatcherConfig()) {
      if (uptime > 30_000) {
        gmailWatcherRestartCount = 0;
      } else {
        gmailWatcherRestartCount++;
      }
      const delay = Math.min(2000 * Math.pow(2, gmailWatcherRestartCount), 60_000);
      log.info(
        "gmail-watcher",
        `scheduling auto-restart in ${delay / 1000}s (attempt ${gmailWatcherRestartCount}, uptime ${Math.round(uptime / 1000)}s)...`,
      );
      setTimeout(async () => {
        if (shuttingDown || gmailWatcherProc || !getGmailWatcherConfig()) {
          return;
        }

        const probe = await probeGmailWatcherOnce();
        if (probe.ok) {
          log.info("gmail-watcher", "watcher still reachable; assuming it restarted itself");
          gmailWatcherRestartCount = 0;
          return;
        }

        ensureGmailWatcherRunning().catch((err) => {
          log.error("gmail-watcher", `auto-restart failed: ${err.message}`);
        });
      }, delay);
    }
  });
}

async function ensureGmailWatcherRunning() {
  const gmailConfig = getGmailWatcherConfig();
  if (!gmailConfig) {
    return { ok: false, reason: "not configured" };
  }

  const nextSignature = getGmailWatcherSignature(gmailConfig);
  if (gmailWatcherProc && gmailWatcherConfigSignature === nextSignature) {
    return { ok: true };
  }

  const probe = await probeGmailWatcherOnce();
  if (probe.ok && gmailWatcherConfigSignature === nextSignature) {
    return { ok: true, reason: "reachable" };
  }

  if (gmailWatcherProc && gmailWatcherConfigSignature !== nextSignature) {
    intentionalGmailWatcherRestart = true;
    try {
      gmailWatcherProc.kill("SIGTERM");
    } catch (err) {
      log.warn("gmail-watcher", `kill error: ${err.message}`);
    }
    await sleep(750);
    gmailWatcherProc = null;
    intentionalGmailWatcherRestart = false;
  }

  if (!gmailWatcherStarting) {
    gmailWatcherStarting = (async () => {
      await startGmailWatcher();
      const ready = await waitForGmailWatcherReady({ timeoutMs: 30_000 });
      if (!ready) {
        throw new Error("Gmail watcher did not become ready in time");
      }
    })().finally(() => {
      gmailWatcherStarting = null;
    });
  }

  await gmailWatcherStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    intentionalRestart = true;
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      log.warn("gateway", `kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
    intentionalRestart = false;
  }
  await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  gatewayRestartCount = 0;
  return ensureGatewayRunning();
}

let volumeJanitorRunning = false;

function getLargestCodexLogDatabase() {
  return getCodexLogDatabaseStats()[0] || { path: null, size: 0 };
}

async function stopGatewayForMaintenance(reason) {
  log.warn("volume-janitor", `stopping gateway for maintenance: ${reason}`);
  if (gatewayProc) {
    intentionalRestart = true;
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      log.warn("volume-janitor", `gateway kill error: ${err.message}`);
    }
    await sleep(5000);
    gatewayProc = null;
    intentionalRestart = false;
  }

  const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
  log.info("volume-janitor", `gateway stop exit=${stopResult.code}`);
}

async function runVolumeJanitor(reason = "Periodic volume janitor") {
  if (volumeJanitorRunning || shuttingDown || !isConfigured()) {
    return;
  }

  volumeJanitorRunning = true;
  try {
    const largestCodexLog = getLargestCodexLogDatabase();
    const shouldRotateCodexLog = largestCodexLog.size > CODEX_LOG_DB_MAX_BYTES;

    if (shouldRotateCodexLog) {
      await stopGatewayForMaintenance(
        `Codex log database ${largestCodexLog.path} reached ` +
          `${formatBytes(largestCodexLog.size)}`,
      );
    }

    const codexLogRepair = await repairOversizedCodexLogDatabase(reason);
    log.info("volume-janitor", codexLogRepair.output.trimEnd());

    await cleanupVolumeBeforeBoot();

    if (shouldRotateCodexLog) {
      await ensureGatewayRunning();
      log.info("volume-janitor", "gateway restarted after volume cleanup");
    }
  } catch (err) {
    log.warn("volume-janitor", `cleanup failed: ${err.message}`);
    if (!gatewayProc && isConfigured() && !shuttingDown) {
      try {
        await ensureGatewayRunning();
      } catch (restartErr) {
        log.error("volume-janitor", `gateway restart after cleanup failure failed: ${restartErr.message}`);
      }
    }
  } finally {
    volumeJanitorRunning = false;
  }
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

  isRateLimited(ip) {
    const now = Date.now();
    const data = this.attempts.get(ip);
    if (!data || now - data.windowStart > this.windowMs) {
      this.attempts.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    data.count++;
    return data.count > this.maxAttempts;
  },
};

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/healthz", async (_req, res) => {
  let gateway = "unconfigured";
  if (isConfigured()) {
    gateway = isGatewayReady() ? "ready" : "starting";
  }
  let gmailWatcher = "unconfigured";
  if (getGmailWatcherConfig()) {
    if (MANAGE_GMAIL_WATCHER) {
      gmailWatcher = gmailWatcherProc ? "ready" : "starting";
    } else {
      const probe = await probeGmailWatcherOnce();
      gmailWatcher = probe.ok ? "ready" : "starting";
    }
  }
  res.json({ ok: true, gateway, gmailWatcher });
});

app.get("/setup/healthz", async (_req, res) => {
  const configured = isConfigured();
  const gatewayRunning = isGatewayReady();
  const starting = isGatewayStarting();
  let gatewayReachable = false;

  if (gatewayRunning) {
    gatewayReachable = await isTcpReachable(
      INTERNAL_GATEWAY_HOST,
      INTERNAL_GATEWAY_PORT,
      3_000,
    );
  }

  res.json({
    ok: true,
    wrapper: true,
    configured,
    gatewayRunning,
    gatewayStarting: starting,
    gatewayReachable,
  });
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version } = await getOpenclawInfo();
  const codexVersion = await runCmd("codex", ["--version"]);
  const codexAuth = getCodexAuthStatus();
  const codexTrusted = isCodexWorkspaceTrusted(WORKSPACE_DIR);

  const authGroups = [
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "API key",
      options: [
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "openai",
      label: "OpenAI",
      hint: "API key / Codex",
      options: [
        { value: "openai-api-key", label: "OpenAI API key" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "API key / CLI",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-gemini-cli", label: "Google Gemini CLI (OAuth)" },
      ],
    },
    {
      value: "deepseek",
      label: "DeepSeek",
      hint: "API key",
      options: [
        { value: "deepseek-api-key", label: "DeepSeek API key" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "xai",
      label: "xAI (Grok)",
      hint: "API key",
      options: [{ value: "xai-api-key", label: "xAI API key" }],
    },
    {
      value: "mistral",
      label: "Mistral AI",
      hint: "API key",
      options: [{ value: "mistral-api-key", label: "Mistral API key" }],
    },
    {
      value: "together",
      label: "Together AI",
      hint: "API key",
      options: [{ value: "together-api-key", label: "Together AI API key" }],
    },
    {
      value: "huggingface",
      label: "Hugging Face",
      hint: "API key",
      options: [{ value: "huggingface-api-key", label: "Hugging Face API key" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "moonshot-api-key-cn", label: "Moonshot AI API key (CN)" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "API key / OAuth",
      options: [
        { value: "minimax-global-api", label: "MiniMax API key (Global)" },
        { value: "minimax-global-oauth", label: "MiniMax OAuth (Global)" },
        { value: "minimax-cn-api", label: "MiniMax API key (CN)" },
        { value: "minimax-cn-oauth", label: "MiniMax OAuth (CN)" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key / OAuth",
      options: [
        { value: "zai-api-key", label: "Z.AI API key" },
        { value: "zai-coding-global", label: "Z.AI Coding (Global)" },
        { value: "zai-coding-cn", label: "Z.AI Coding (CN)" },
        { value: "zai-global", label: "Z.AI (Global)" },
        { value: "zai-cn", label: "Z.AI (CN)" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "modelstudio",
      label: "Alibaba Model Studio",
      hint: "Qwen via Alibaba Cloud",
      options: [
        { value: "modelstudio-api-key", label: "Coding Plan (Global)" },
        { value: "modelstudio-api-key-cn", label: "Coding Plan (CN)" },
        { value: "modelstudio-standard-api-key", label: "Standard Plan (Global)" },
        { value: "modelstudio-standard-api-key-cn", label: "Standard Plan (CN)" },
      ],
    },
    {
      value: "venice",
      label: "Venice AI",
      hint: "API key",
      options: [{ value: "venice-api-key", label: "Venice AI API key" }],
    },
    {
      value: "chutes",
      label: "Chutes",
      hint: "OAuth / API key",
      options: [
        { value: "chutes", label: "Chutes OAuth" },
        { value: "chutes-api-key", label: "Chutes API key" },
      ],
    },
    {
      value: "kilocode",
      label: "Kilocode",
      hint: "API key",
      options: [{ value: "kilocode-api-key", label: "Kilocode API key" }],
    },
    {
      value: "xiaomi",
      label: "Xiaomi",
      hint: "API key",
      options: [{ value: "xiaomi-api-key", label: "Xiaomi API key" }],
    },
    {
      value: "volcengine",
      label: "Volcano Engine (Doubao)",
      hint: "API key",
      options: [{ value: "volcengine-api-key", label: "Volcano Engine API key" }],
    },
    {
      value: "byteplus",
      label: "BytePlus",
      hint: "API key",
      options: [{ value: "byteplus-api-key", label: "BytePlus API key" }],
    },
    {
      value: "qianfan",
      label: "Qianfan (Baidu)",
      hint: "API key",
      options: [{ value: "qianfan-api-key", label: "Qianfan API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "cloudflare-ai-gateway",
      label: "Cloudflare AI Gateway",
      hint: "API key",
      options: [
        { value: "cloudflare-ai-gateway-api-key", label: "Cloudflare AI Gateway API key" },
      ],
    },
    {
      value: "litellm",
      label: "LiteLLM",
      hint: "Unified gateway",
      options: [{ value: "litellm-api-key", label: "LiteLLM API key" }],
    },
    {
      value: "opencode",
      label: "OpenCode",
      hint: "Zen / Go",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
        { value: "opencode-go", label: "OpenCode Go" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "self-hosted",
      label: "Self-hosted",
      hint: "Ollama / vLLM / SGLang",
      options: [
        { value: "ollama", label: "Ollama (local)" },
        { value: "vllm", label: "vLLM" },
        { value: "sglang", label: "SGLang" },
      ],
    },
    {
      value: "custom",
      label: "Custom endpoint",
      hint: "OpenAI / Anthropic compatible",
      options: [{ value: "custom-api-key", label: "Custom provider" }],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
    acpDefaultAgent: ACP_DEFAULT_AGENT,
    acpPermissionMode: ACP_PERMISSION_MODE,
    acpPluginToolsMcpBridge: ACP_PLUGIN_TOOLS_MCP_BRIDGE,
    codexCliVersion: codexVersion.code === 0 ? codexVersion.output.trim() : "",
    codexAuthMode: codexAuth.fileAuthMode,
    codexAuthReady: codexAuth.hasUsableCredential,
    codexAuthPlaceholder: codexAuth.hasPlaceholderOnly,
    codexWorkspaceTrusted: codexTrusted,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    "quickstart",
  ];

  if (payload.authChoice) {
    const onboardAuthChoice =
      payload.authChoice === "openai-codex" ? "skip" : payload.authChoice;
    args.push("--auth-choice", onboardAuthChoice);

    const secret = (payload.authSecret || "").trim();
    const flag = AUTH_SECRET_FLAGS[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "custom-api-key") {
      const baseUrl = (payload.customBaseUrl || "").trim();
      const modelId = (payload.customModelId || "").trim();
      const compat = (payload.customCompatibility || "").trim();
      if (baseUrl) args.push("--custom-base-url", baseUrl);
      if (modelId) args.push("--custom-model-id", modelId);
      if (compat) args.push("--custom-compatibility", compat);
    }

    if (payload.authChoice === "cloudflare-ai-gateway-api-key") {
      const accountId = (payload.cloudflareAccountId || "").trim();
      const gatewayId = (payload.cloudflareGatewayId || "").trim();
      if (accountId) args.push("--cloudflare-ai-gateway-account-id", accountId);
      if (gatewayId) args.push("--cloudflare-ai-gateway-gateway-id", gatewayId);
    }

  }

  return args;
}

const AUTH_SECRET_FLAGS = {
  apiKey: "--anthropic-api-key",
  "openai-api-key": "--openai-api-key",
  "gemini-api-key": "--gemini-api-key",
  "deepseek-api-key": "--deepseek-api-key",
  "openrouter-api-key": "--openrouter-api-key",
  "xai-api-key": "--xai-api-key",
  "mistral-api-key": "--mistral-api-key",
  "together-api-key": "--together-api-key",
  "huggingface-api-key": "--huggingface-api-key",
  "moonshot-api-key": "--moonshot-api-key",
  "moonshot-api-key-cn": "--moonshot-api-key",
  "kimi-code-api-key": "--kimi-code-api-key",
  "minimax-global-api": "--minimax-api-key",
  "minimax-cn-api": "--minimax-api-key",
  "zai-api-key": "--zai-api-key",
  "modelstudio-api-key": "--modelstudio-api-key",
  "modelstudio-api-key-cn": "--modelstudio-api-key-cn",
  "modelstudio-standard-api-key": "--modelstudio-standard-api-key",
  "modelstudio-standard-api-key-cn": "--modelstudio-standard-api-key-cn",
  "venice-api-key": "--venice-api-key",
  "chutes-api-key": "--chutes-api-key",
  "kilocode-api-key": "--kilocode-api-key",
  "xiaomi-api-key": "--xiaomi-api-key",
  "volcengine-api-key": "--volcengine-api-key",
  "byteplus-api-key": "--byteplus-api-key",
  "qianfan-api-key": "--qianfan-api-key",
  "ai-gateway-api-key": "--ai-gateway-api-key",
  "cloudflare-ai-gateway-api-key": "--cloudflare-ai-gateway-api-key",
  "litellm-api-key": "--litellm-api-key",
  "opencode-zen": "--opencode-zen-api-key",
  "opencode-go": "--opencode-go-api-key",
  "synthetic-api-key": "--synthetic-api-key",
  "custom-api-key": "--custom-api-key",
};

function authChoiceNeedsSecret(authChoice) {
  return Boolean(AUTH_SECRET_FLAGS[authChoice]);
}

function validateProviderSecret(authChoice, rawSecret) {
  if (!authChoiceNeedsSecret(authChoice)) {
    return null;
  }

  const secret = String(rawSecret ?? "").trim();
  if (!isDummyCredential(secret)) {
    return null;
  }

  if (authChoice === "openai-api-key") {
    return "Invalid OpenAI API key: placeholder values like 'not-needed' or 'dummy' are not valid. Use a real OpenAI API key, or choose 'OpenAI Codex (ChatGPT OAuth)' instead.";
  }

  return "Invalid provider credential: placeholder values like 'not-needed' or 'dummy' are not valid setup credentials.";
}

function resolveRequestedModel(payload) {
  const requestedModel = String(payload.model ?? "").trim();
  if (payload.authChoice === "openai-codex") {
    const normalized = normalizeOpenaiCodexModel(requestedModel);
    if (!normalized) {
      return {
        ok: false,
        error:
          "OpenAI Codex auth requires a Codex model. Use a model like codex/gpt-5.5.",
      };
    }
    return { ok: true, model: normalized };
  }

  return { ok: true, model: requestedModel };
}

function runCmd(cmd, args, opts = {}) {
  const { timeoutMs, timeoutCode = 124, ...spawnOpts } = opts;

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    let timeoutTimer = null;
    let out = "";

    function killProcessGroup(signal) {
      if (!proc.pid) return;
      try {
        process.kill(timeoutMs ? -proc.pid : proc.pid, signal);
      } catch (err) {
        if (err.code !== "ESRCH") {
          out += `\n[kill error] ${String(err)}\n`;
        }
      }
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    }

    const proc = childProcess.spawn(cmd, args, {
      ...spawnOpts,
      detached: timeoutMs ? true : spawnOpts.detached,
      env: buildChildEnv({
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        ...(spawnOpts.env || {}),
      }, { quiet: true }),
    });

    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    if (timeoutMs) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        out += `\n[timeout] command exceeded ${timeoutMs}ms; terminating\n`;
        killProcessGroup("SIGTERM");
        killTimer = setTimeout(() => killProcessGroup("SIGKILL"), 5_000);
        killTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();
    }

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      finish({ code: 127, output: out });
    });

    proc.on("close", (code, signal) => {
      if (timedOut && signal) {
        out += `[timeout] terminated by ${signal}\n`;
      }
      finish({ code: timedOut ? timeoutCode : code ?? 0, output: out });
    });
  });
}

async function runDoctorFix(reason = "Repairing config and state") {
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["doctor", "--fix", "--non-interactive", "--yes"]),
    { timeoutMs: DOCTOR_FIX_TIMEOUT_MS },
  );
  let output = `[doctor] ${reason}\n`;
  output += `[doctor --fix --non-interactive --yes] exit=${result.code}\n`;
  if (result.output) {
    output += `${result.output}\n`;
  }
  return {
    ok: result.code === 0,
    code: result.code,
    output,
  };
}

async function repairLegacyTemplateConfig(
  reason = "Repairing legacy template config",
) {
  let output = `[config repair] ${reason}\n`;
  const config = readConfig();
  if (!config || typeof config !== "object") {
    output += "[config repair] skipped (config missing or unreadable)\n";
    return { ok: true, changed: false, output };
  }

  let changed = false;

  const slackChannels = config?.channels?.slack?.channels;
  if (slackChannels && typeof slackChannels === "object") {
    for (const [channelId, channelConfig] of Object.entries(slackChannels)) {
      if (!channelConfig || typeof channelConfig !== "object") {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(channelConfig, "allow")) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(channelConfig, "enabled")) {
        channelConfig.enabled = channelConfig.allow === true;
      }
      delete channelConfig.allow;
      changed = true;
      output += `[config repair] migrated channels.slack.channels.${channelId}.allow -> enabled\n`;
    }
  }

  const telegramStreaming = config?.channels?.telegram?.streaming;
  if (typeof telegramStreaming === "string" && telegramStreaming.trim()) {
    config.channels.telegram.streaming = { mode: telegramStreaming.trim() };
    changed = true;
    output += "[config repair] migrated channels.telegram.streaming string -> object\n";
  }

  const acpxConfig = config?.plugins?.entries?.acpx?.config;
  if (acpxConfig && typeof acpxConfig === "object") {
    const staleKeys = [
      "pluginToolsMcpBridge",
      "command",
      "expectedVersion",
    ];
    for (const key of staleKeys) {
      if (Object.prototype.hasOwnProperty.call(acpxConfig, key)) {
        delete acpxConfig[key];
        changed = true;
        output += `[config repair] removed plugins.entries.acpx.config.${key}\n`;
      }
    }
  }

  const mcpServers = config?.mcp?.servers;
  if (
    DISABLE_USER_MCP_SERVERS &&
    mcpServers &&
    typeof mcpServers === "object" &&
    Object.keys(mcpServers).length > 0
  ) {
    const serverCount = Object.keys(mcpServers).length;
    config.mcp.servers = {};
    changed = true;
    output += `[config repair] disabled ${serverCount} configured MCP server(s) for Railway process limits\n`;
  }

  if (DEFAULT_DISABLED_PLUGINS.length > 0) {
    if (!config.plugins || typeof config.plugins !== "object") {
      config.plugins = {};
    }
    if (!config.plugins.entries || typeof config.plugins.entries !== "object") {
      config.plugins.entries = {};
    }

    for (const pluginId of DEFAULT_DISABLED_PLUGINS) {
      const entry = config.plugins.entries[pluginId];
      if (!entry || typeof entry !== "object") {
        config.plugins.entries[pluginId] = { enabled: false };
        changed = true;
        output += `[config repair] disabled default plugin ${pluginId}\n`;
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(entry, "enabled")) {
        entry.enabled = false;
        changed = true;
        output += `[config repair] disabled default plugin ${pluginId}\n`;
      }
    }
  }

  if (FORCE_DISABLED_PLUGINS.length > 0) {
    if (!config.plugins || typeof config.plugins !== "object") {
      config.plugins = {};
    }
    if (!config.plugins.entries || typeof config.plugins.entries !== "object") {
      config.plugins.entries = {};
    }

    for (const pluginId of FORCE_DISABLED_PLUGINS) {
      const entry = config.plugins.entries[pluginId];
      if (!entry || typeof entry !== "object") {
        config.plugins.entries[pluginId] = { enabled: false };
        changed = true;
        output += `[config repair] force-disabled plugin ${pluginId}\n`;
        continue;
      }

      if (entry.enabled !== false) {
        entry.enabled = false;
        changed = true;
        output += `[config repair] force-disabled plugin ${pluginId}\n`;
      }
    }
  }

  if (!changed) {
    output += "[config repair] no template config changes needed\n";
    return { ok: true, changed: false, output };
  }

  try {
    writeJsonFile(configPath(), config);
    output += `[config repair] wrote ${configPath()}\n`;
    return { ok: true, changed: true, output };
  } catch (err) {
    output += `[config repair] write failed: ${err.message}\n`;
    return { ok: false, changed: false, output };
  }
}

async function configureChannel(name, { addArgs = [], configWrites = [] } = {}) {
  let output = "";

  if (addArgs.length > 0) {
    const addResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["channels", "add", "--channel", name, ...addArgs]),
    );
    output += `\n[channels add ${name}] exit=${addResult.code}\n${addResult.output || "(no output)"}\n`;
    if (addResult.code !== 0) {
      throw new Error(
        `Channel setup failed for ${name}.\n${output}`.trim(),
      );
    }
  }

  for (const write of configWrites) {
    const args = write.json
      ? ["config", "set", "--json", write.path, JSON.stringify(write.value)]
      : ["config", "set", write.path, String(write.value)];
    const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
    output += `[config set ${write.path}] exit=${result.code}\n${result.output || "(no output)"}\n`;
    if (result.code !== 0) {
      throw new Error(
        `Channel config write failed for ${name} at ${write.path}.\n${output}`.trim(),
      );
    }
  }

  const getResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "get", `channels.${name}`]),
  );
  output += `[${name} verify] exit=${getResult.code}\n${getResult.output || "(no output)"}`;
  if (getResult.code !== 0) {
    throw new Error(
      `Channel verification failed for ${name}.\n${output}`.trim(),
    );
  }

  return output;
}

async function listPendingPairingRequests(channel) {
  const result = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "list", "--channel", channel, "--json"]),
  );

  if (result.code !== 0) {
    return {
      ok: false,
      channel,
      requests: [],
      output: result.output || "",
    };
  }

  try {
    const parsed = JSON.parse(result.output || "{}");
    const requests = Array.isArray(parsed?.requests) ? parsed.requests : [];
    return {
      ok: true,
      channel,
      requests,
      output: result.output || "",
    };
  } catch (err) {
    return {
      ok: false,
      channel,
      requests: [],
      output: `${result.output || ""}\n[parse error] ${String(err)}`.trim(),
    };
  }
}

async function applyRequestedModel(resolvedModel) {
  if (!resolvedModel?.model) {
    return "";
  }

  const modelResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["models", "set", resolvedModel.model]),
  );
  return `[setup] Setting model to ${resolvedModel.model}...\n[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
}

async function configureRequestedChannels(payload) {
  let output = "";

  if (payload.telegramToken?.trim()) {
    output += await configureChannel("telegram", {
      addArgs: ["--token", payload.telegramToken.trim()],
      configWrites: [
        { path: "channels.telegram.enabled", value: "true" },
        { path: "channels.telegram.dmPolicy", value: "pairing" },
        { path: "channels.telegram.groupPolicy", value: "allowlist" },
        { path: "channels.telegram.accounts.default.groupPolicy", value: "allowlist" },
        {
          path: "channels.telegram.streaming",
          value: { mode: "partial" },
          json: true,
        },
        {
          path: "channels.telegram.groups",
          value: {},
          json: true,
        },
        {
          path: "channels.telegram.accounts.default.groups",
          value: {},
          json: true,
        },
        {
          path: "channels.telegram.threadBindings",
          value: {
            enabled: true,
            spawnAcpSessions: true,
          },
          json: true,
        },
      ],
    });
  }

  if (payload.discordToken?.trim()) {
    output += await configureChannel("discord", {
      addArgs: ["--token", payload.discordToken.trim()],
      configWrites: [
        { path: "channels.discord.enabled", value: "true" },
        { path: "channels.discord.dmPolicy", value: "pairing" },
        { path: "channels.discord.groupPolicy", value: "allowlist" },
        {
          path: "channels.discord.channels",
          value: {},
          json: true,
        },
        {
          path: "channels.discord.threadBindings",
          value: {
            enabled: true,
            spawnAcpSessions: true,
          },
          json: true,
        },
      ],
    });
  }

  if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
    const addArgs = [];
    if (payload.slackBotToken?.trim()) {
      addArgs.push("--bot-token", payload.slackBotToken.trim());
    }
    if (payload.slackAppToken?.trim()) {
      addArgs.push("--app-token", payload.slackAppToken.trim());
    }
    output += await configureChannel("slack", {
      addArgs,
      configWrites: [
        { path: "channels.slack.enabled", value: "true" },
        { path: "channels.slack.dmPolicy", value: "pairing" },
        { path: "channels.slack.groupPolicy", value: "allowlist" },
        {
          path: "channels.slack.channels",
          value: {},
          json: true,
        },
      ],
    });
  }

  return output;
}

const VALID_AUTH_CHOICES = [
  "apiKey",
  "openai-api-key",
  "openai-codex",
  "gemini-api-key",
  "google-gemini-cli",
  "deepseek-api-key",
  "openrouter-api-key",
  "xai-api-key",
  "mistral-api-key",
  "together-api-key",
  "huggingface-api-key",
  "github-copilot",
  "copilot-proxy",
  "moonshot-api-key",
  "moonshot-api-key-cn",
  "kimi-code-api-key",
  "minimax-global-api",
  "minimax-global-oauth",
  "minimax-cn-api",
  "minimax-cn-oauth",
  "zai-api-key",
  "zai-coding-global",
  "zai-coding-cn",
  "zai-global",
  "zai-cn",
  "qwen-portal",
  "modelstudio-api-key",
  "modelstudio-api-key-cn",
  "modelstudio-standard-api-key",
  "modelstudio-standard-api-key-cn",
  "venice-api-key",
  "chutes",
  "chutes-api-key",
  "kilocode-api-key",
  "xiaomi-api-key",
  "volcengine-api-key",
  "byteplus-api-key",
  "qianfan-api-key",
  "ai-gateway-api-key",
  "cloudflare-ai-gateway-api-key",
  "litellm-api-key",
  "opencode-zen",
  "opencode-go",
  "synthetic-api-key",
  "ollama",
  "vllm",
  "sglang",
  "custom-api-key",
];

function validatePayload(payload) {
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const modelResolution = resolveRequestedModel(payload);
  if (!modelResolution.ok) {
    return modelResolution.error;
  }
  const providerSecretError = validateProviderSecret(
    payload.authChoice,
    payload.authSecret,
  );
  if (providerSecretError) {
    return providerSecretError;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
    "customBaseUrl",
    "customModelId",
    "customCompatibility",
    "cloudflareAccountId",
    "cloudflareGatewayId",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  const slackBotToken = payload.slackBotToken?.trim() || "";
  const slackAppToken = payload.slackAppToken?.trim() || "";
  if (Boolean(slackBotToken) !== Boolean(slackAppToken)) {
    return "Slack setup requires both the bot token and the app token.";
  }
  return null;
}

async function configureAcpSupport() {
  let output = "\n[setup] Configuring ACP agents...\n";
  output += await ensureCodexCliSupport();

  const installResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["plugins", "install", "acpx"]),
  );
  output += `[plugins install acpx] exit=${installResult.code}\n${installResult.output || ""}`;

  const configWrites = [
    ["config", "set", "plugins.entries.acpx.enabled", "true"],
    ["config", "set", "acp.enabled", "true"],
    ["config", "set", "acp.dispatch.enabled", "true"],
    ["config", "set", "acp.backend", "acpx"],
    ["config", "set", "acp.defaultAgent", ACP_DEFAULT_AGENT],
    ["config", "set", "acp.maxConcurrentSessions", String(ACP_MAX_CONCURRENT_SESSIONS)],
    ["config", "set", "acp.runtime.ttlMinutes", String(ACP_RUNTIME_TTL_MINUTES)],
    ["config", "set", "agents.defaults.maxConcurrent", String(AGENT_MAX_CONCURRENT)],
    [
      "config",
      "set",
      "agents.defaults.subagents.maxConcurrent",
      String(AGENT_SUBAGENT_MAX_CONCURRENT),
    ],
    ["config", "set", "agents.defaults.thinkingDefault", AGENT_THINKING_DEFAULT],
    [
      "config",
      "set",
      "--json",
      "acp.allowedAgents",
      JSON.stringify(ACP_ALLOWED_AGENTS),
    ],
    [
      "config",
      "set",
      "--json",
      "acp.stream",
      JSON.stringify({
        coalesceIdleMs: 300,
        maxChunkChars: 1200,
      }),
    ],
    ["config", "set", "session.threadBindings.enabled", "true"],
    ["config", "set", "session.threadBindings.idleHours", "24"],
    ["config", "set", "session.threadBindings.maxAgeHours", "0"],
    ["config", "set", "plugins.entries.acpx.config.permissionMode", ACP_PERMISSION_MODE],
    [
      "config",
      "set",
      "plugins.entries.acpx.config.nonInteractivePermissions",
      ACP_NON_INTERACTIVE_PERMISSIONS,
    ],
  ];

  for (const args of configWrites) {
    const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
    output += `[${args.slice(0, 3).join(" ")} ${args[3]}] exit=${result.code}\n`;
    if (result.output) {
      output += `${result.output}\n`;
    }
  }

  output += "[acpx config] bundled ACPX runtime manages its own schema; skipping legacy template config writes\n";

  const pluginDoctorResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["plugins", "doctor"]),
  );
  output += `[plugins doctor] exit=${pluginDoctorResult.code}\n${pluginDoctorResult.output || ""}`;

  return output;
}

async function repairAcpRuntimeConfig(reason = "Repairing ACP runtime config") {
  let output = `[acp runtime repair] ${reason}\n`;
  let changed = false;

  const legacyConfigRepair = await repairLegacyTemplateConfig(
    "Removing stale ACPX/template config keys before ACP runtime repair",
  );
  output += `${legacyConfigRepair.output}`;
  if (!legacyConfigRepair.ok) {
    return {
      ok: false,
      changed,
      output,
    };
  }
  if (legacyConfigRepair.changed) {
    changed = true;
  }

  output += "[acp runtime repair] applying ACPX runtime permission defaults\n";

  const configWrites = [
    ["config", "set", "acp.maxConcurrentSessions", String(ACP_MAX_CONCURRENT_SESSIONS)],
    ["config", "set", "acp.runtime.ttlMinutes", String(ACP_RUNTIME_TTL_MINUTES)],
    ["config", "set", "agents.defaults.maxConcurrent", String(AGENT_MAX_CONCURRENT)],
    [
      "config",
      "set",
      "agents.defaults.subagents.maxConcurrent",
      String(AGENT_SUBAGENT_MAX_CONCURRENT),
    ],
    ["config", "set", "agents.defaults.thinkingDefault", AGENT_THINKING_DEFAULT],
    ["config", "set", "plugins.entries.acpx.config.permissionMode", ACP_PERMISSION_MODE],
    [
      "config",
      "set",
      "plugins.entries.acpx.config.nonInteractivePermissions",
      ACP_NON_INTERACTIVE_PERMISSIONS,
    ],
  ];

  for (const args of configWrites) {
    const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
    output += `[${args.slice(0, 3).join(" ")} ${args[3]}] exit=${result.code}\n`;
    if (result.output) {
      output += `${result.output}\n`;
    }
    if (result.code === 0) {
      changed = true;
    }
  }

  return {
    ok: true,
    changed,
    output,
  };
}

async function enableAcpOnConfiguredInstance(payload = {}, resolvedModel = null) {
  let output = "";
  output += "\n[setup] Re-applying gateway settings for existing instance...\n";

  const legacyConfigRepair = await repairLegacyTemplateConfig(
    "Repairing existing instance before applying runtime fixes",
  );
  output += `${legacyConfigRepair.output}`;

  const allowInsecureResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "gateway.controlUi.allowInsecureAuth",
      "false",
    ]),
  );
  output += `[config] gateway.controlUi.allowInsecureAuth=false exit=${allowInsecureResult.code}\n`;

  const tokenResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "gateway.auth.token",
      OPENCLAW_GATEWAY_TOKEN,
    ]),
  );
  output += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

  const proxiesResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.trustedProxies",
      '["127.0.0.1"]',
    ]),
  );
  output += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

  output += await configureAcpSupport();
  const modelUpdate = await applyRequestedModel(resolvedModel);
  if (modelUpdate) {
    output += `\n${modelUpdate}\n`;
  }
  const channelUpdates = await configureRequestedChannels(payload);
  if (channelUpdates) {
    output += `\n[setup] Applying requested channel updates...\n${channelUpdates}\n`;
  }
  const authRepair = await repairModelAuth(
    "Repairing placeholder provider auth before ACP restart",
  );
  output += `\n${authRepair.output}`;
  const doctor = await runDoctorFix(
    "Normalizing config and cron storage before ACP restart",
  );
  output += `\n${doctor.output}`;
  output += "\n[setup] Restarting gateway for ACP changes...\n";
  await restartGateway();
  output += "[setup] Gateway restarted.\n";
  return output;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const resolvedModel = resolveRequestedModel(payload);

    if (isConfigured()) {
      return res.json({
        ok: true,
        output:
          "Already configured.\nApplying container-side ACP/runtime fixes and requested updates to the existing instance...\n\n" +
          (await enableAcpOnConfiguredInstance(payload, resolvedModel)),
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "false",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=false exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      const hookSessionKeyResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "hooks.defaultSessionKey", "hook:ingress"]),
      );
      extra += `[config] hooks.defaultSessionKey exit=${hookSessionKeyResult.code}\n`;

      const hookAgentsResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "hooks.allowedAgentIds",
          '["main"]',
        ]),
      );
      extra += `[config] hooks.allowedAgentIds exit=${hookAgentsResult.code}\n`;

      extra += await configureAcpSupport();

      extra += await applyRequestedModel(resolvedModel);
      extra += await configureRequestedChannels(payload);

      const doctor = await runDoctorFix(
        "Normalizing fresh setup before first gateway start",
      );
      extra += `\n${doctor.output}`;
      const authRepair = await repairModelAuth(
        "Repairing placeholder provider auth after setup",
      );
      extra += `\n${authRepair.output}`;

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    log.error("setup", `run error: ${String(err)}`);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.get("/setup/api/pairings", requireSetupAuth, async (_req, res) => {
  const channels = ["telegram", "discord", "slack"];
  const results = await Promise.all(
    channels.map((channel) => listPendingPairingRequests(channel)),
  );

  const requests = results
    .flatMap((result) =>
      result.requests.map((request) => ({
        channel: result.channel,
        code: request?.code ?? "",
        id: request?.id ?? "",
        meta: request?.meta ?? null,
        createdAt: request?.createdAt ?? "",
      })),
    )
    .sort((a, b) => {
      const aTime = Date.parse(a.createdAt || "") || 0;
      const bTime = Date.parse(b.createdAt || "") || 0;
      return bTime - aTime;
    });

  const errors = results
    .filter((result) => !result.ok)
    .map((result) => ({
      channel: result.channel,
      output: result.output,
    }));

  return res.status(errors.length === 0 ? 200 : 207).json({
    ok: errors.length === 0,
    requests,
    errors,
  });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    if (gatewayProc) {
      intentionalRestart = true;
      gatewayProc.kill("SIGTERM");
      await sleep(750);
      gatewayProc = null;
      intentionalRestart = false;
    }
    if (gmailWatcherProc) {
      intentionalGmailWatcherRestart = true;
      gmailWatcherProc.kill("SIGTERM");
      await sleep(750);
      gmailWatcherProc = null;
      intentionalGmailWatcherRestart = false;
    }
    await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - stopped gateway and deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const legacyRepair = await repairLegacyTemplateConfig(
    "Pre-doctor repair for legacy template config",
  );
  const result = await runDoctorFix("Manual repair from setup UI");
  const acpRepair = await repairAcpRuntimeConfig(
    "Repairing ACP runtime config from setup UI",
  );
  const authRepair = await repairModelAuth(
    "Repairing placeholder provider auth from setup UI",
  );
  const codexLogRepair = await repairOversizedCodexLogDatabase(
    "Repairing oversized Codex log database from setup UI",
  );
  let codexLogRestartOk = true;
  let codexLogRestartOutput = "";
  if (codexLogRepair.changed && isGatewayReady()) {
    try {
      await restartGateway();
      codexLogRestartOutput =
        "\n[codex log repair] gateway restarted after log database cleanup";
    } catch (err) {
      codexLogRestartOk = false;
      codexLogRestartOutput =
        `\n[codex log repair] gateway restart failed: ${err.message}`;
    }
  }
  const sessionRepair = await repairMissingCodexSessionTranscripts(
    "Repairing missing Codex session transcripts from setup UI",
  );
  const allOk =
    result.ok &&
    acpRepair.ok &&
    authRepair.ok &&
    codexLogRepair.ok &&
    codexLogRestartOk &&
    sessionRepair.ok;
  return res.status(allOk ? 200 : 500).json({
    ok: allOk,
    output:
      `${legacyRepair.output}\n${result.output}\n${acpRepair.output}\n` +
      `${authRepair.output}\n${codexLogRepair.output}` +
      `${codexLogRestartOutput}\n${sessionRepair.output}`,
  });
});

app.post("/setup/api/acp/doctor", requireSetupAuth, async (_req, res) => {
  const [pluginDoctor, inspect, acpEnabled, acpBackend, acpDefaultAgent, codexVersion] =
    await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["plugins", "doctor"])),
      runCmd(OPENCLAW_NODE, clawArgs(["plugins", "inspect", "acpx"])),
      runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "acp.enabled"])),
      runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "acp.backend"])),
      runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "acp.defaultAgent"])),
      runCmd("codex", ["--version"]),
    ]);

  const codexAuth = getCodexAuthStatus();
  const codexTrusted = isCodexWorkspaceTrusted(WORKSPACE_DIR);
  const defaultAgent = acpDefaultAgent.output.trim();
  const codexReady =
    codexVersion.code === 0 &&
    codexAuth.hasUsableCredential &&
    codexTrusted;

  const ok =
    pluginDoctor.code === 0 &&
    acpEnabled.output.trim() === "true" &&
    acpBackend.output.trim() === "acpx" &&
    (defaultAgent !== "codex" || codexReady);

  const output = [
    `[config] acp.enabled => ${acpEnabled.output.trim() || "(empty)"}`,
    `[config] acp.backend => ${acpBackend.output.trim() || "(empty)"}`,
    `[config] acp.defaultAgent => ${defaultAgent || "(empty)"}`,
    `[codex --version] exit=${codexVersion.code}`,
    codexVersion.output || "",
    `[codex auth] mode=${codexAuth.fileAuthMode || "none"} usable=${codexAuth.hasUsableCredential} placeholder=${codexAuth.hasPlaceholderOnly}`,
    `[codex config] workspace trusted=${codexTrusted} path=${WORKSPACE_DIR}`,
    `[plugins inspect acpx] exit=${inspect.code}`,
    inspect.output || "",
    `[plugins doctor] exit=${pluginDoctor.code}`,
    pluginDoctor.output || "",
  ].join("\n");

  return res.status(ok ? 200 : 500).json({
    ok,
    output,
  });
});

app.post("/setup/api/acp/enable", requireSetupAuth, async (_req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(400).json({
        ok: false,
        output: "OpenClaw is not configured yet. Run setup first.",
      });
    }

    await ensureGatewayRunning();
    const output = await enableAcpOnConfiguredInstance();
    return res.json({ ok: true, output });
  } catch (err) {
    log.error("setup", `acp enable error: ${String(err)}`);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/devices", requireSetupAuth, async (_req, res) => {
  const args = ["devices", "list", "--json", "--token", OPENCLAW_GATEWAY_TOKEN];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  log.info("devices", `list exit=${result.code} output=${result.output}`);
  try {
    const jsonMatch = result.output.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (!jsonMatch) {
      log.warn("devices", "no JSON found in output");
      return res.json({ ok: result.code === 0, raw: result.output });
    }
    const data = JSON.parse(jsonMatch[1]);
    log.info("devices", `parsed keys=${Object.keys(data)} pending=${JSON.stringify(data.pending)} paired=${JSON.stringify(data.paired)}`);
    return res.json({ ok: true, data, raw: result.output });
  } catch (parseErr) {
    log.warn("devices", `JSON parse failed: ${parseErr.message}`);
    return res.json({ ok: result.code === 0, raw: result.output });
  }
});

app.post("/setup/api/devices/approve", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  const args = ["devices", "approve"];
  if (requestId) {
    args.push(String(requestId));
  } else {
    args.push("--latest");
  }
  args.push("--token", OPENCLAW_GATEWAY_TOKEN);
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.post("/setup/api/devices/reject", requireSetupAuth, async (req, res) => {
  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ ok: false, error: "Missing requestId" });
  }
  const args = [
    "devices", "reject", String(requestId),
    "--token", OPENCLAW_GATEWAY_TOKEN,
  ];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res
    .status(result.code === 0 ? 200 : 500)
    .json({ ok: result.code === 0, output: result.output });
});

app.get("/setup/api/export", requireSetupAuth, async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const zipName = `openclaw-export-${timestamp}.zip`;
  const tmpZip = path.join(os.tmpdir(), zipName);

  try {
    const dirsToExport = [];
    if (fs.existsSync(STATE_DIR)) dirsToExport.push(STATE_DIR);
    if (fs.existsSync(WORKSPACE_DIR)) dirsToExport.push(WORKSPACE_DIR);

    if (dirsToExport.length === 0) {
      return res.status(404).json({ ok: false, error: "No data directories found to export." });
    }

    const zipArgs = ["-r", "-P", SETUP_PASSWORD, tmpZip, ...dirsToExport];
    const result = await runCmd("zip", zipArgs);

    if (result.code !== 0 || !fs.existsSync(tmpZip)) {
      return res.status(500).json({ ok: false, error: "Failed to create export archive.", output: result.output });
    }

    const stat = fs.statSync(tmpZip);
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipName}"`,
      "Content-Length": String(stat.size),
    });

    const stream = fs.createReadStream(tmpZip);
    stream.pipe(res);
    stream.on("end", () => {
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
    });
    stream.on("error", (err) => {
      log.error("export", `stream error: ${err.message}`);
      try { fs.rmSync(tmpZip, { force: true }); } catch {}
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "Stream error during export." });
      }
    });
  } catch (err) {
    try { fs.rmSync(tmpZip, { force: true }); } catch {}
    log.error("export", `error: ${err.message}`);
    return res.status(500).json({ ok: false, error: `Export failed: ${err.message}` });
  }
});

app.get("/logs", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "logs.html"));
});

app.get("/setup/api/logs", requireSetupAuth, async (_req, res) => {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const limit = Math.min(Number.parseInt(_req.query.lines ?? "500", 10), 5000);
    return res.json({ ok: true, lines: lines.slice(-limit) });
  } catch (err) {
    if (err.code === "ENOENT") {
      return res.json({ ok: true, lines: [] });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/setup/api/logs/stream", requireSetupAuth, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  for (const line of logRingBuffer) {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

function verifyTuiAuth(req) {
  if (!SETUP_PASSWORD) return false;
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  return crypto.timingSafeEqual(passwordHash, expectedHash);
}

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    log.info("tui", `session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      log.info("tui", `spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        log.info("tui", "session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        log.info("tui", "max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        log.info("tui", `PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        log.warn("tui", `invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      log.info("tui", "session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      log.error("tui", `WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
  changeOrigin: true,
  proxyTimeout: 120_000,
  timeout: 120_000,
});

proxy.on("error", (err, _req, res) => {
  log.error("proxy", String(err));
  if (res && typeof res.headersSent !== "undefined" && !res.headersSent) {
    res.writeHead(503, { "Content-Type": "text/html" });
    try {
      const html = fs.readFileSync(
        path.join(process.cwd(), "src", "public", "loading.html"),
        "utf8",
      );
      res.end(html);
    } catch {
      res.end("Gateway unavailable. Retrying...");
    }
  }
});

const PROXY_ORIGIN = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : GATEWAY_TARGET;

proxy.on("proxyReq", (proxyReq, req, res) => {
  if (
    !matchesProxyBasePath(req.path, "/hooks") &&
    !matchesProxyBasePath(req.path, GMAIL_WATCHER_PATH)
  ) {
    proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  }
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", PROXY_ORIGIN);
});

app.use(async (req, res) => {
  if (req.path === "/") {
    return res.sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
  }

  if (matchesProxyBasePath(req.path, GMAIL_WATCHER_PATH)) {
    // Google Pub/Sub retries pushes aggressively on any non-2xx response. If
    // the watcher isn't listening, proxying to 127.0.0.1:8788 produces
    // ECONNREFUSED per push, and the retry backlog (up to 7 days of events)
    // hammers the wrapper — exhausting container PIDs/FDs and killing the
    // whole service. To stay resilient, short-circuit before touching the
    // proxy when the watcher isn't configured or isn't currently reachable.
    if (!getGmailWatcherConfig()) {
      // Gmail hook intentionally not configured. 204-ack so Pub/Sub drops
      // the message instead of building an unbounded retry queue.
      return res.status(204).end();
    }
    if (!(await isGmailWatcherReachable())) {
      // Gmail hook IS configured but the watcher isn't up yet (gateway
      // starting / restart / transient). Fail fast with 503 so Pub/Sub
      // backs off and retries later, without holding a socket open.
      return res.status(503).end();
    }
    try {
      if (MANAGE_GMAIL_WATCHER) {
        await ensureGmailWatcherRunning();
      } else {
        await ensureGatewayRunning();
      }
    } catch {
      return res
        .status(503)
        .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
    }
    return proxy.web(req, res, { target: GMAIL_WATCHER_TARGET });
  }

  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (!isGatewayReady()) {
      try {
        await ensureGatewayRunning();
      } catch {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }

      if (!isGatewayReady()) {
        return res
          .status(503)
          .sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
    }
  }

  if (req.path === "/openclaw" && !req.query.token) {
    return res.redirect(`/openclaw?token=${OPENCLAW_GATEWAY_TOKEN}`);
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, () => {
  log.info("wrapper", `listening on port ${PORT}`);
  log.info("wrapper", `setup wizard: http://localhost:${PORT}/setup`);
  log.info("wrapper", `web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  log.info("wrapper", `configured: ${isConfigured()}`);

  if (isConfigured()) {
    (async () => {
      try {
        await cleanupVolumeBeforeBoot();
        log.info(
          "wrapper",
          "repairing legacy template config before gateway boot...",
        );
        const legacyRepair = await repairLegacyTemplateConfig(
          "Startup repair for legacy template config",
        );
        log.info("wrapper", legacyRepair.output.trimEnd());
        log.info(
          "wrapper",
          "running openclaw doctor --fix --non-interactive --yes...",
        );
        const dr = await runDoctorFix("Startup repair before gateway boot");
        log.info("wrapper", dr.output.trimEnd());
        const acpRepair = await repairAcpRuntimeConfig(
          "Startup repair for ACP runtime config",
        );
        log.info("wrapper", acpRepair.output.trimEnd());
        const authRepair = await repairModelAuth(
          "Startup repair for placeholder provider auth",
        );
        log.info("wrapper", authRepair.output.trimEnd());
        const codexLogRepair = await repairOversizedCodexLogDatabase(
          "Startup repair for oversized Codex log database",
        );
        log.info("wrapper", codexLogRepair.output.trimEnd());
        const sessionRepair = await repairMissingCodexSessionTranscripts(
          "Startup repair for missing Codex session transcripts",
        );
        log.info("wrapper", sessionRepair.output.trimEnd());
      } catch (err) {
        log.warn("wrapper", `doctor --fix failed: ${err.message}`);
      }
      await ensureGatewayRunning();
      if (MANAGE_GMAIL_WATCHER) {
        await ensureGmailWatcherRunning();
      } else if (getGmailWatcherConfig()) {
        log.info(
          "gmail-watcher",
          "wrapper watcher disabled; relying on OpenClaw-managed Gmail hook listener",
        );
      }
    })().catch((err) => {
      log.error("wrapper", `failed to start services at boot: ${err.message}`);
    });
  }
});

const volumeJanitorInterval = setInterval(() => {
  runVolumeJanitor("Periodic Railway volume janitor").catch((err) => {
    log.warn("volume-janitor", `periodic cleanup failed: ${err.message}`);
  });
}, VOLUME_JANITOR_INTERVAL_MS);
volumeJanitorInterval.unref?.();

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    log.warn("websocket", `gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  log.info("wrapper", `received ${signal}, shutting down`);
  shuttingDown = true;

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }
  if (volumeJanitorInterval) {
    clearInterval(volumeJanitorInterval);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      log.warn("wrapper", `error killing gateway: ${err.message}`);
    }
  }

  if (gmailWatcherProc) {
    try {
      gmailWatcherProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gmailWatcherProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gmailWatcherProc && !gmailWatcherProc.killed) {
        gmailWatcherProc.kill("SIGKILL");
      }
    } catch (err) {
      log.warn("wrapper", `error killing gmail watcher: ${err.message}`);
    }
  }

  try {
    const stopResult = await runCmd(OPENCLAW_NODE, clawArgs(["gateway", "stop"]));
    log.info("wrapper", `gateway stop during shutdown exit=${stopResult.code}`);
  } catch (err) {
    log.warn("wrapper", `gateway stop during shutdown failed: ${err.message}`);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
