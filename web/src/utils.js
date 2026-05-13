
export function sanitizeClassName(value) {
  return String(value || "node").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

export function isValidJavascriptIdentifier(value) {
  const name = String(value || "");
  const reservedWords = new Set([
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "return",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield"
  ]);
  return /^[A-Za-z_$][0-9A-Za-z_$]*$/.test(name) && !reservedWords.has(name);
}

export function stableStringify(value) {
  return JSON.stringify(value, (_, item) => {
    if (item === undefined) {
      return null;
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      return String(item);
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return item;
    }
    return Object.keys(item).sort().reduce((sorted, key) => {
      sorted[key] = item[key];
      return sorted;
    }, {});
  });
}

export function sanitizePersistedJavascriptOutput(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}
