import assert from "node:assert/strict";
import test from "node:test";

import {
  extractOpenclawVersion,
  selectVersionAtLeast,
} from "../src/openclaw-version.js";

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

test("clamps stale or malformed version overrides to the minimum", () => {
  assert.equal(selectVersionAtLeast(undefined, "0.144.1"), "0.144.1");
  assert.equal(selectVersionAtLeast("0.134.0", "0.144.1"), "0.144.1");
  assert.equal(selectVersionAtLeast("latest", "0.144.1"), "0.144.1");
  assert.equal(selectVersionAtLeast("0.144.1-alpha.2", "0.144.1"), "0.144.1");
});

test("keeps equal and newer valid version overrides", () => {
  assert.equal(selectVersionAtLeast("0.144.1", "0.144.1"), "0.144.1");
  assert.equal(selectVersionAtLeast("0.144.2", "0.144.1"), "0.144.2");
  assert.equal(
    selectVersionAtLeast("0.145.0-alpha.2", "0.144.1"),
    "0.145.0-alpha.2",
  );
});
