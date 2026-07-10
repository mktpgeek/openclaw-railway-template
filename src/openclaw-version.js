export function extractOpenclawVersion(versionOutput) {
  const match = String(versionOutput ?? "").match(
    /\b\d{4}\.\d+\.\d+(?:[-.a-zA-Z0-9]+)?\b/,
  );
  return match?.[0] || "";
}
