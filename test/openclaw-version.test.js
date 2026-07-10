import assert from "node:assert/strict";
import test from "node:test";

import { extractOpenclawVersion } from "../src/openclaw-version.js";

test("extracts a bare OpenClaw version", () => {
  assert.equal(extractOpenclawVersion("2026.6.11"), "2026.6.11");
});

test("extracts a version from decorated CLI output", () => {
  assert.equal(
    extractOpenclawVersion("OpenClaw 2026.6.11 (e085fa1)"),
    "2026.6.11",
  );
});

test("preserves prerelease suffixes", () => {
  assert.equal(
    extractOpenclawVersion("OpenClaw 2026.6.12-beta.1 (abc123)"),
    "2026.6.12-beta.1",
  );
});

test("returns an empty string for malformed output", () => {
  assert.equal(extractOpenclawVersion("OpenClaw development build"), "");
});
