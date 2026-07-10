export function extractOpenclawVersion(versionOutput) {
  const match = String(versionOutput ?? "").match(
    /\b\d{4}\.\d+\.\d+(?:[-.a-zA-Z0-9]+)?\b/,
  );
  return match?.[0] || "";
}

function parseSemanticVersion(value) {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/,
  );
  if (!match) return null;

  return {
    normalized,
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    if (left.length === right.length) return 0;
    return left.length === 0 ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return Number(leftPart) < Number(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareSemanticVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] === right.core[index]) continue;
    return left.core[index] < right.core[index] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function selectVersionAtLeast(requestedVersion, minimumVersion) {
  const requested = parseSemanticVersion(requestedVersion);
  const minimum = parseSemanticVersion(minimumVersion);
  if (!minimum) return String(minimumVersion ?? "").trim();
  if (!requested || compareSemanticVersions(requested, minimum) < 0) {
    return minimum.normalized;
  }
  return requested.normalized;
}
