
import { normalizeSnapshot } from "./runtime-state.js";
import { sanitizePersistedJavascriptOutput } from "./utils.js";

export function persistRuntimeStateToHost(bootstrap, appState) {
  if (!window.rundownHost || typeof window.rundownHost.persistRuntimeState !== "function" || !bootstrap.cachePath) {
    return;
  }

  window.rundownHost.persistRuntimeState(buildPersistedRuntimeState(appState.runtimeState, appState.parsedDocument.nodes), bootstrap.cachePath);
}

export function buildPersistedRuntimeState(runtimeState, nodes = []) {
  const secretSlotKeys = buildSecretSlotKeyMap(nodes);
  return {
    variables: sanitizePersistedVariables(runtimeState.variables || {}, secretSlotKeys),
    secretBindings: sanitizePersistedSecretBindings(runtimeState.secretBindings || {}, secretSlotKeys),
    http: Object.fromEntries(Object.entries(runtimeState.http || {}).map(([cellName, entry]) => [
      cellName,
      {
        statusText: entry.statusText || "",
        responseBody: entry.responseBody || "",
        ...(typeof entry.statusCode === "number" ? { statusCode: entry.statusCode } : {}),
        ...(entry.request ? { request: normalizeSnapshot(entry.request) } : {})
      }
    ])),
    javascript: Object.fromEntries(Object.entries(runtimeState.javascript || {}).map(([cellName, entry]) => [
      cellName,
      {
        status: entry.status === "failure" ? "failure" : "success",
        statusText: entry.statusText || "",
        output: sanitizePersistedJavascriptOutput(entry.output),
        outputText: entry.outputText || "",
        inputHash: entry.inputHash || "",
        updatedAt: entry.updatedAt || ""
      }
    ]))
  };
}

export function buildSecretSlotKeyMap(nodes) {
  const slots = {};
  (nodes || []).forEach((node) => {
    if (node.kind !== "cell" || node.cellType !== "variables" || !node.name) {
      return;
    }

    (node.variables || []).forEach((entry) => {
      if (!entry.isSecretSlot) {
        return;
      }

      if (!slots[node.name]) {
        slots[node.name] = new Set();
      }
      slots[node.name].add(entry.key);
    });
  });
  return slots;
}

export function sanitizePersistedVariables(variables, secretSlotKeys) {
  return Object.fromEntries(Object.entries(variables || {}).map(([namespaceName, values]) => {
    const secretKeys = secretSlotKeys[namespaceName] || new Set();
    return [
      namespaceName,
      Object.fromEntries(Object.entries(values || {}).filter(([key]) => !secretKeys.has(key)))
    ];
  }).filter(([, values]) => Object.keys(values).length > 0));
}

export function sanitizePersistedSecretBindings(secretBindings, secretSlotKeys) {
  return Object.fromEntries(Object.entries(secretBindings || {}).map(([namespaceName, values]) => {
    const secretKeys = secretSlotKeys[namespaceName] || new Set();
    return [
      namespaceName,
      Object.fromEntries(Object.entries(values || {}).filter(([key, secretName]) => secretKeys.has(key) && String(secretName || "").trim()))
    ];
  }).filter(([, values]) => Object.keys(values).length > 0));
}
