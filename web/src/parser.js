
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
  return language === "http" || language === "variables" || language === "assert" || language === "json" || language === "javascript" || language === "chart";
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

function parseVariableEntries(source) {
  return String(source || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return { key: line, value: "", isSecretSlot: false };
      }

      const value = normalizeVariableValue(line.slice(separatorIndex + 1).trim());
      return {
        key: line.slice(0, separatorIndex).trim(),
        value,
        isSecretSlot: isSecretSentinelValue(value)
      };
    });
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
