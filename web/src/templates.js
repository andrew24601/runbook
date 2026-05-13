
import { getSecretBinding } from "./variables.js";

export function buildTemplateContext(nodes, runtimeState, options = {}) {
  const variablesByNamespace = {};
  const httpEntriesByCell = {};
  const javascriptEntriesByCell = {};
  const secretSlotsByNamespace = {};

  nodes.forEach((node) => {
    if (node.kind === "cell" && node.cellType === "variables" && node.name) {
      const namespaceValues = {};
      (node.variables || []).forEach((entry) => {
        if (entry.isSecretSlot) {
          const secretName = getSecretBinding(runtimeState, node.name, entry.key);
          namespaceValues[entry.key] = buildSecretSlotTemplateValue(node.name, entry.key, secretName, options);
          if (!secretSlotsByNamespace[node.name]) {
            secretSlotsByNamespace[node.name] = {};
          }
          secretSlotsByNamespace[node.name][entry.key] = {
            namespaceName: node.name,
            key: entry.key,
            secretName
          };
          return;
        }
        namespaceValues[entry.key] = entry.value;
      });
      variablesByNamespace[node.name] = namespaceValues;
    }
  });

  Object.entries(runtimeState.variables || {}).forEach(([namespaceName, values]) => {
    const secretSlots = secretSlotsByNamespace[namespaceName] || {};
    variablesByNamespace[namespaceName] = {
      ...(variablesByNamespace[namespaceName] || {}),
      ...Object.fromEntries(Object.entries(values || {}).filter(([key]) => !Object.prototype.hasOwnProperty.call(secretSlots, key)))
    };
  });

  Object.entries(runtimeState.http || {}).forEach(([cellName, entry]) => {
    httpEntriesByCell[cellName] = buildHTTPRuntimeEnvelope(entry || {});
  });

  Object.entries(runtimeState.javascript || {}).forEach(([cellName, entry]) => {
    if (entry && entry.status === "success") {
      javascriptEntriesByCell[cellName] = entry.output;
    }
  });

  return {
    variablesByNamespace,
    httpEntriesByCell,
    javascriptEntriesByCell,
    secretSlotsByNamespace
  };
}

function buildSecretSlotTemplateValue(namespaceName, key, secretName, options = {}) {
  return {
    __rundownSecretSlot: true,
    namespaceName,
    key,
    secretName: secretName || "",
    mode: options.secretMode || "redacted",
    secretValuesByReference: options.secretValuesByReference || {}
  };
}

export function buildHTTPRuntimeEnvelope(entry) {
  return {
    status: typeof entry.statusCode === "number" ? entry.statusCode : null,
    statusText: entry.statusText || "",
    body: parseResponseBodyForContext(entry.responseBody || ""),
    rawBody: entry.responseBody || "",
    request: entry.request || null
  };
}

function parseResponseBodyForContext(responseBody) {
  const trimmed = String(responseBody || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return responseBody;
  }
}

export function resolveTemplateStringLenient(text, context) {
  return String(text || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    try {
      const value = resolveTemplateExpression(expression, context);
      return stringifyTemplateValue(value);
    } catch {
      return "";
    }
  });
}

export function resolveTemplateStringStrict(text, context) {
  return String(text || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    const value = resolveTemplateExpression(expression, context);
    return stringifyTemplateValue(value);
  });
}

export function resolveTemplateExpression(expression, context) {
  const path = String(expression || "").trim();
  if (!path) {
    throw new Error("Empty template expression");
  }

  const segments = path.split(".").filter(Boolean);
  const root = segments.shift();
  if (!root) {
    throw new Error(`Could not resolve template: ${path}`);
  }

  if (Object.prototype.hasOwnProperty.call(context.variablesByNamespace, root)) {
    return unwrapTemplateValue(resolvePathValue(context.variablesByNamespace[root], segments, true, path), path);
  }

  if (Object.prototype.hasOwnProperty.call(context.httpEntriesByCell, root)) {
    return unwrapTemplateValue(resolvePathValue(context.httpEntriesByCell[root], segments, false, path), path);
  }

  if (Object.prototype.hasOwnProperty.call(context.javascriptEntriesByCell, root)) {
    return unwrapTemplateValue(resolvePathValue(context.javascriptEntriesByCell[root], segments, false, path), path);
  }

  throw new Error(`Unknown template root: ${root}`);
}

function unwrapTemplateValue(value, originalPath) {
  if (!value || typeof value !== "object" || value.__rundownSecretSlot !== true) {
    return value;
  }

  if (!value.secretName) {
    throw new Error(`Secret not bound: ${value.namespaceName}.${value.key}`);
  }

  if (value.mode === "actual") {
    const reference = `${value.namespaceName}.${value.key}`;
    if (Object.prototype.hasOwnProperty.call(value.secretValuesByReference || {}, reference)) {
      return value.secretValuesByReference[reference];
    }
    throw new Error(`Secret unavailable: ${value.secretName}`);
  }

  return "*****";
}

function resolvePathValue(value, segments, allowFlatKeyLookup, originalPath) {
  if (!segments.length) {
    return value;
  }

  if (allowFlatKeyLookup && value && typeof value === "object") {
    const flatKey = segments.join(".");
    if (Object.prototype.hasOwnProperty.call(value, flatKey)) {
      return value[flatKey];
    }
  }

  let current = value;
  for (const segment of segments) {
    if (current == null) {
      throw new Error(`Missing template value: ${originalPath}`);
    }

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new Error(`Missing template value: ${originalPath}`);
      }
      current = current[index];
      continue;
    }

    if (typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
      continue;
    }

    throw new Error(`Missing template value: ${originalPath}`);
  }

  return current;
}

function stringifyTemplateValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}
