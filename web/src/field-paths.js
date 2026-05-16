export function resolveDottedFieldPath(value, path) {
  const segments = String(path || "").split(".").map((segment) => segment.trim()).filter(Boolean);
  let current = value;

  for (const segment of segments) {
    if (current == null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}
