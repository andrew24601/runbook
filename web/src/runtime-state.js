
import {
  buildHTTPRuntimeEnvelope,
  buildTemplateContext,
  resolveTemplateExpression,
  resolveTemplateStringLenient,
  resolveTemplateStringStrict
} from "./templates.js";
import { getSecretBinding } from "./variables.js";
import { isValidJavascriptIdentifier, stableStringify } from "./utils.js";

export function buildHTTPNodeState(node, state) {
  const snapshotResult = resolveHTTPSnapshot(node, state);
  const runtimeEntry = node.name ? state.runtimeState.http[node.name] : null;
  const snapshot = snapshotResult.snapshot;
  const templateError = snapshotResult.error;
  const isOutOfDate = runtimeEntry && runtimeEntry.request ? !requestSnapshotsEqual(runtimeEntry.request, snapshot) : false;

  if (!node.name && isAutoHTTPNode(node)) {
    return {
      snapshot,
      templateError,
      summary: `${snapshot.method} ${snapshot.url}`.trim(),
      statusText: "Name required",
      bloomState: "failure",
      responseBody: "Automatic HTTP cells need a name so their response can be cached.",
      responseLabel: "Request error"
    };
  }

  if (state.inflightRequests.has(node.name)) {
    return {
      snapshot,
      templateError,
      summary: `${snapshot.method} ${snapshot.url}`.trim(),
      statusText: "Running request...",
      bloomState: "running",
      responseBody: "",
      responseLabel: "Last response"
    };
  }

  if (templateError) {
    return {
      snapshot,
      templateError,
      summary: `${snapshot.method} ${snapshot.url}`.trim(),
      statusText: "Template error",
      bloomState: "failure",
      responseBody: "",
      responseLabel: "Last response"
    };
  }

  if (!runtimeEntry) {
    return {
      snapshot,
      templateError: "",
      summary: `${snapshot.method} ${snapshot.url}`.trim(),
      statusText: "Ready to run.",
      bloomState: "idle",
      responseBody: "",
      responseLabel: "Last response"
    };
  }

  let bloomState = "failure";
  if (isOutOfDate) {
    bloomState = "outofdate";
  } else if (typeof runtimeEntry.statusCode === "number") {
    bloomState = runtimeEntry.statusCode >= 200 && runtimeEntry.statusCode < 400 ? "success" : "failure";
  }

  return {
    snapshot,
    templateError: "",
    summary: `${snapshot.method} ${snapshot.url}`.trim(),
    statusText: runtimeEntry.statusText || "Completed",
    bloomState,
    responseBody: runtimeEntry.responseBody || "<empty response body>",
    responseLabel: isOutOfDate ? "Cached response (out of date)" : "Cached response"
  };
}

export function buildJavascriptNodeState(node, state) {
  const snapshot = buildJavascriptExecutionSnapshot(node, state);
  const runtimeEntry = node.name ? state.runtimeState.javascript[node.name] : null;
  const isOutOfDate = runtimeEntry && runtimeEntry.inputHash !== snapshot.inputHash;

  if (!node.name) {
    return {
      snapshot,
      statusText: "Name required",
      bloomState: "failure",
      outputText: "JavaScript cells need a name so later cells can receive their output.",
      outputLabel: "Script error"
    };
  }

  if (state.inflightScripts.has(node.name)) {
    return {
      snapshot,
      statusText: "Running script...",
      bloomState: "running",
      outputText: "",
      outputLabel: "Output"
    };
  }

  if (!runtimeEntry) {
    return {
      snapshot,
      statusText: "Ready to run.",
      bloomState: "idle",
      outputText: "",
      outputLabel: "Output"
    };
  }

  if (isOutOfDate) {
    return {
      snapshot,
      statusText: "Out of date",
      bloomState: "outofdate",
      outputText: runtimeEntry.outputText || "",
      outputLabel: "Cached output (out of date)"
    };
  }

  const failed = runtimeEntry.status === "failure";
  return {
    snapshot,
    statusText: runtimeEntry.statusText || (failed ? "Script failed" : "Completed"),
    bloomState: failed ? "failure" : "success",
    outputText: runtimeEntry.outputText || "",
    outputLabel: failed ? "Script error" : "Output"
  };
}

export function buildJavascriptExecutionSnapshot(node, state) {
  const parameterContext = buildJavascriptParameterContext(state.parsedDocument.nodes, state.runtimeState, node.nodeIndex);
  return {
    source: node.source || "",
    paramNames: parameterContext.paramNames,
    paramValues: parameterContext.paramValues,
    inputHash: stableStringify({
      source: node.source || "",
      params: parameterContext.paramNames.map((name, index) => [name, parameterContext.paramValues[index]])
    })
  };
}

export function buildJavascriptParameterContext(nodes, runtimeState, beforeNodeIndex) {
  const outputsByName = {};

  (nodes || []).forEach((node) => {
    if (node.kind !== "cell" || !node.name || node.nodeIndex >= beforeNodeIndex || !isValidJavascriptIdentifier(node.name)) {
      return;
    }

    if (node.cellType === "variables") {
      outputsByName[node.name] = buildVariablesOutput(node, runtimeState);
      return;
    }

    if (node.cellType === "http" && runtimeState.http && Object.prototype.hasOwnProperty.call(runtimeState.http, node.name)) {
      outputsByName[node.name] = buildHTTPRuntimeEnvelope(runtimeState.http[node.name] || {});
      return;
    }

    if (node.cellType === "javascript" && runtimeState.javascript && Object.prototype.hasOwnProperty.call(runtimeState.javascript, node.name)) {
      const entry = runtimeState.javascript[node.name] || {};
      if (entry.status === "success") {
        outputsByName[node.name] = entry.output;
      }
    }
  });

  const paramNames = Object.keys(outputsByName);
  return {
    paramNames,
    paramValues: paramNames.map((name) => outputsByName[name])
  };
}

export function buildVariablesOutput(node, runtimeState) {
  const namespaceValues = {};
  (node.variables || []).forEach((entry) => {
    if (entry.isSecretSlot) {
      namespaceValues[entry.key] = getSecretBinding(runtimeState, node.name, entry.key) ? "*****" : "";
      return;
    }
    namespaceValues[entry.key] = entry.value;
  });

  Object.entries(runtimeState.variables && runtimeState.variables[node.name] ? runtimeState.variables[node.name] : {}).forEach(([key, value]) => {
    const entry = (node.variables || []).find((candidate) => candidate.key === key);
    if (!entry || !entry.isSecretSlot) {
      namespaceValues[key] = value;
    }
  });

  return namespaceValues;
}

export function resolveHTTPSnapshot(node, state, options = {}) {
  const context = buildTemplateContext(state.parsedDocument.nodes, state.runtimeState, options);

  try {
    return {
      snapshot: {
        method: resolveTemplateStringStrict(node.method || "GET", context).trim() || "GET",
        url: resolveTemplateStringStrict(node.url || "", context).trim(),
        headers: (node.headers || []).map((header) => ({
          name: resolveTemplateStringStrict(header.name || "", context).trim(),
          value: resolveTemplateStringStrict(header.value || "", context).trim()
        })).filter((header) => header.name),
        body: resolveTemplateStringStrict(node.body || "", context)
      },
      error: ""
    };
  } catch (error) {
    return {
      snapshot: {
        method: (node.method || "GET").trim() || "GET",
        url: (node.url || "").trim(),
        headers: (node.headers || []).map((header) => ({ name: header.name || "", value: header.value || "" })),
        body: node.body || ""
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }
}


export function normalizeSnapshot(snapshot) {
  return {
    method: snapshot && snapshot.method ? snapshot.method : "GET",
    url: snapshot && snapshot.url ? snapshot.url : "",
    headers: Array.isArray(snapshot && snapshot.headers) ? snapshot.headers.map((header) => ({
      name: header.name || "",
      value: header.value || ""
    })) : [],
    body: snapshot && snapshot.body ? snapshot.body : ""
  };
}

export function requestSnapshotsEqual(left, right) {
  return JSON.stringify(normalizeSnapshot(left)) === JSON.stringify(normalizeSnapshot(right));
}

export function resolveJSONNodeText(node, state) {
  const context = buildTemplateContext(state.parsedDocument.nodes, state.runtimeState);
  if (node.sourceReference) {
    try {
      const value = resolveTemplateExpression(node.sourceReference, context);
      return typeof value === "string" ? formatPossiblyJSONText(value) : JSON.stringify(value, null, 2);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  return formatPossiblyJSONText(resolveTemplateStringLenient(node.source || "", context));
}

export function formatPossiblyJSONText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

export function isAutoHTTPNode(node) {
  if (!node || node.cellType !== "http") {
    return false;
  }

  const attributes = node.attributes || {};
  return isTruthyAttribute(attributes.auto) ||
    isTruthyAttribute(attributes.autorun) ||
    isTruthyAttribute(attributes.autoRun) ||
    String(attributes.run || "").trim().toLowerCase() === "auto";
}

export function isTruthyAttribute(value) {
  return ["true", "1", "yes", "on", "auto"].includes(String(value || "").trim().toLowerCase());
}
