
import { marked } from "marked";

export function parseWorkbookDocument(source) {
  const tokens = marked.lexer(source || "", { gfm: true });
  const nodes = [];
  let proseTokens = [];
  let nextNodeIndex = 0;

  const flushProse = () => {
    if (!proseTokens.length) {
      return;
    }

    nodes.push({
      kind: "markdown",
      nodeIndex: nextNodeIndex++,
      rawText: proseTokens.map((token) => token.raw || "").join("")
    });
    proseTokens = [];
  };

  tokens.forEach((token) => {
    if (token.type === "code") {
      const fence = parseFenceInfo(token.lang || "");
      if (isWorkbookFenceLanguage(fence.language)) {
        flushProse();
        nodes.push(parseWorkbookCell(token, fence, nextNodeIndex++));
        return;
      }
    }

    proseTokens.push(token);
  });

  flushProse();

  return { nodes };
}

export function parseFenceInfo(infoString) {
  const trimmed = String(infoString || "").trim();
  if (!trimmed) {
    return { language: "", attributes: {} };
  }

  const firstSpace = trimmed.search(/\s/);
  const language = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).trim().toLowerCase();
  const attributeSource = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  const attributes = {};
  const pattern = /(\w+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g;
  let match = pattern.exec(attributeSource);
  while (match) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4] ?? "true";
    attributes[key] = value;
    const normalizedKey = key.toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(attributes, normalizedKey)) {
      attributes[normalizedKey] = value;
    }
    match = pattern.exec(attributeSource);
  }

  return { language, attributes };
}

export function isWorkbookFenceLanguage(language) {
  return language === "http" || language === "variables" || language === "assert" || language === "json" || language === "javascript" || language === "chart" || language === "list";
}

export function parseWorkbookCell(token, fence, nodeIndex) {
  const source = token.text || "";
  const baseNode = {
    kind: "cell",
    nodeIndex,
    cellType: fence.language,
    name: fence.attributes.name || "",
    attributes: fence.attributes,
    source
  };

  if (fence.language === "http") {
    return {
      ...baseNode,
      ...parseHTTPCell(source)
    };
  }

  if (fence.language === "variables") {
    return {
      ...baseNode,
      variables: parseVariableEntries(source)
    };
  }

  if (fence.language === "json") {
    return {
      ...baseNode,
      sourceReference: fence.attributes.src || ""
    };
  }

  if (fence.language === "chart") {
    return {
      ...baseNode,
      chart: parseChartSpec(source)
    };
  }

  if (fence.language === "list") {
    return {
      ...baseNode,
      list: parseListSpec(source)
    };
  }

  return baseNode;
}

function parseHTTPCell(source) {
  const lines = String(source || "").split("\n");
  const firstLine = lines.find((line) => line.trim().length > 0) || "";
  const requestMatch = firstLine.trim().match(/^([A-Za-z]+)\s+(.*)$/);
  const method = requestMatch ? requestMatch[1].toUpperCase() : "GET";
  const url = requestMatch ? requestMatch[2].trim() : "";

  const headers = [];
  const bodyLines = [];
  let inBody = false;

  lines.slice(firstLine ? lines.indexOf(firstLine) + 1 : 0).forEach((line) => {
    if (!inBody && line.trim() === "") {
      inBody = true;
      return;
    }

    if (!inBody) {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex !== -1) {
        headers.push({
          name: line.slice(0, separatorIndex).trim(),
          value: line.slice(separatorIndex + 1).trim()
        });
        return;
      }
    }

    inBody = true;
    bodyLines.push(line);
  });

  return {
    method,
    url,
    headers,
    body: bodyLines.join("\n").trim()
  };
}

const VARIABLE_DECLARATION_PATTERN = /^([A-Za-z_$][0-9A-Za-z_$]*)\s*=\s*/;

export function parseVariableEntries(source) {
  const entries = [];
  let currentEntry = null;

  const flushEntry = () => {
    if (!currentEntry) {
      return;
    }

    entries.push(parseVariableEntry(currentEntry.key, currentEntry.valueLines.join("\n")));
    currentEntry = null;
  };

  String(source || "").replace(/\r\n/g, "\n").split("\n").forEach((line) => {
    const match = line.match(VARIABLE_DECLARATION_PATTERN);
    if (match) {
      flushEntry();
      currentEntry = {
        key: match[1],
        valueLines: [line.slice(match[0].length)]
      };
      return;
    }

    if (currentEntry) {
      currentEntry.valueLines.push(line);
    }
  });

  flushEntry();
  return entries;
}

function parseVariableEntry(key, rawValue) {
  const value = parseVariableValue(rawValue);
  return {
    key,
    value: value.value,
    valueType: value.valueType,
    ...(value.control ? { control: value.control } : {}),
    isSecretSlot: value.valueType === "secret"
  };
}

function parseVariableValue(rawValue) {
  const trimmed = String(rawValue || "").trim();

  if (isSecretSentinelValue(trimmed)) {
    return { value: "<secret>", valueType: "secret" };
  }

  if (isQuotedVariableValue(trimmed)) {
    return { value: trimmed.slice(1, -1), valueType: "string" };
  }

  if (/^(?:true|false)$/.test(trimmed)) {
    return { value: trimmed === "true", valueType: "boolean" };
  }

  if (isNumberLiteral(trimmed)) {
    return { value: Number(trimmed), valueType: "number" };
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const definition = JSON.parse(trimmed);
      const controlValue = parseVariableControlDefinition(definition);
      if (controlValue) {
        return controlValue;
      }
    } catch {
      // Invalid JSON definitions fall through to a plain string value.
    }
  }

  return { value: trimmed, valueType: "string" };
}

function parseVariableControlDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return null;
  }

  if (String(definition.type || "").toLowerCase() !== "select") {
    return null;
  }

  if (Array.isArray(definition.options)) {
    const options = definition.options.filter((option) => isSelectOptionValue(option));
    const value = Object.prototype.hasOwnProperty.call(definition, "default") && isSelectOptionValue(definition.default)
      ? definition.default
      : options.length ? options[0] : "";

    return {
      value,
      valueType: "control",
      control: {
        type: "select",
        options
      }
    };
  }

  if (typeof definition.options === "string" && definition.options.trim()) {
    const labelPath = typeof definition.label === "string" ? definition.label.trim() : "";
    const valuePath = typeof definition.value === "string" ? definition.value.trim() : "";
    const defaultValue = Object.prototype.hasOwnProperty.call(definition, "default") && isSelectOptionValue(definition.default)
      ? definition.default
      : "";
    return {
      value: defaultValue,
      valueType: "control",
      control: {
        type: "select",
        optionsPath: definition.options.trim(),
        ...(labelPath ? { labelPath } : {}),
        ...(valuePath ? { valuePath } : {})
      }
    };
  }

  return null;
}

function isQuotedVariableValue(value) {
  return value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
}

function isNumberLiteral(value) {
  return /^[+-]?(?:(?:\d+\.\d*)|(?:\d+)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
}

function isSelectOptionValue(value) {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function parseChartSpec(source) {
  const spec = {};
  String(source || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = normalizeVariableValue(line.slice(separatorIndex + 1).trim());
      if (key) {
        spec[key] = value;
      }
    });

  return {
    type: String(spec.type || "").trim().toLowerCase(),
    x: String(spec.x || "").trim(),
    y: String(spec.y || "").trim(),
    label: String(spec.label || "").trim()
  };
}

function parseListSpec(source) {
  const spec = {
    fields: []
  };

  String(source || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return;
      }

      const key = line.slice(0, separatorIndex).trim().toLowerCase();
      const value = normalizeVariableValue(line.slice(separatorIndex + 1).trim());
      if (!key) {
        return;
      }

      if (key === "field") {
        spec.fields.push(parseListField(value));
        return;
      }

      spec[key] = value;
    });

  return {
    view: String(spec.view || "table").trim().toLowerCase() || "table",
    items: String(spec.items || "").trim(),
    title: String(spec.title || "").trim(),
    subtitle: String(spec.subtitle || "").trim(),
    fields: spec.fields
  };
}

function parseListField(value) {
  const separatorIndex = String(value || "").indexOf("|");
  if (separatorIndex === -1) {
    return {
      label: String(value || "").trim(),
      path: ""
    };
  }

  return {
    label: String(value || "").slice(0, separatorIndex).trim(),
    path: String(value || "").slice(separatorIndex + 1).trim()
  };
}

function normalizeVariableValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isSecretSentinelValue(value) {
  return String(value || "").trim() === "<secret>";
}
