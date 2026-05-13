
import {
  buildHTTPNodeState,
  buildJavascriptExecutionSnapshot,
  isAutoHTTPNode,
  normalizeSnapshot,
  requestSnapshotsEqual,
  resolveHTTPSnapshot
} from "./runtime-state.js";
import { buildTemplateContext } from "./templates.js";

export function createExecutionController(appState, callbacks) {
function scheduleAutoHTTPExecutionFromIndex(startIndex = 0, options = {}) {
  const normalizedStartIndex = Number.isFinite(startIndex) ? startIndex : 0;
  appState.pendingHTTPStartIndex = Math.min(appState.pendingHTTPStartIndex, normalizedStartIndex);

  if (appState.httpExecutionActive) {
    return;
  }

  if (appState.pendingHTTPTimer !== null) {
    window.clearTimeout(appState.pendingHTTPTimer);
  }

  appState.httpExecutionScheduled = true;
  const delayMs = typeof options.delayMs === "number" ? options.delayMs : 350;
  appState.pendingHTTPTimer = window.setTimeout(() => {
    appState.pendingHTTPTimer = null;
    appState.httpExecutionScheduled = false;
    runScheduledAutoHTTPCells();
  }, Math.max(0, delayMs));
}

async function runScheduledAutoHTTPCells() {
  if (appState.httpExecutionActive) {
    return;
  }

  appState.httpExecutionActive = true;
  let earliestJavascriptStartIndex = Infinity;
  try {
    while (Number.isFinite(appState.pendingHTTPStartIndex)) {
      const startIndex = appState.pendingHTTPStartIndex;
      appState.pendingHTTPStartIndex = Infinity;
      earliestJavascriptStartIndex = Math.min(earliestJavascriptStartIndex, startIndex);
      await runOutdatedAutoHTTPCellsFrom(startIndex);
    }
  } finally {
    appState.httpExecutionActive = false;
  }

  if (Number.isFinite(earliestJavascriptStartIndex)) {
    scheduleJavascriptExecutionFromIndex(earliestJavascriptStartIndex);
  }
}

async function runOutdatedAutoHTTPCellsFrom(startIndex) {
  const httpCells = appState.parsedDocument.nodes.filter((node) => (
    node.kind === "cell" &&
    node.cellType === "http" &&
    isAutoHTTPNode(node) &&
    node.name &&
    node.nodeIndex >= startIndex
  ));

  for (const node of httpCells) {
    if (shouldRunAutoHTTPCell(node)) {
      await runHTTPCell(node, { propagate: false });
    }
  }
}

function shouldRunAutoHTTPCell(node) {
  if (!node.name || appState.inflightRequests.has(node.name)) {
    return false;
  }

  const snapshotResult = resolveHTTPSnapshot(node, appState);
  if (snapshotResult.error) {
    return false;
  }

  const runtimeEntry = appState.runtimeState.http[node.name];
  return !runtimeEntry || !runtimeEntry.request || !requestSnapshotsEqual(runtimeEntry.request, snapshotResult.snapshot);
}

function scheduleJavascriptExecutionFromIndex(startIndex = 0) {
  const normalizedStartIndex = Number.isFinite(startIndex) ? startIndex : 0;
  appState.pendingJavascriptStartIndex = Math.min(appState.pendingJavascriptStartIndex, normalizedStartIndex);
  if (appState.javascriptExecutionActive || appState.javascriptExecutionScheduled) {
    return;
  }

  appState.javascriptExecutionScheduled = true;
  window.setTimeout(() => {
    appState.javascriptExecutionScheduled = false;
    runScheduledJavascriptCells();
  }, 0);
}

async function runScheduledJavascriptCells() {
  if (appState.javascriptExecutionActive) {
    return;
  }

  appState.javascriptExecutionActive = true;
  try {
    while (Number.isFinite(appState.pendingJavascriptStartIndex)) {
      const startIndex = appState.pendingJavascriptStartIndex;
      appState.pendingJavascriptStartIndex = Infinity;
      await runOutdatedJavascriptCellsFrom(startIndex);
    }
  } finally {
    appState.javascriptExecutionActive = false;
  }
}

async function runOutdatedJavascriptCellsFrom(startIndex) {
  const scripts = appState.parsedDocument.nodes.filter((node) => (
    node.kind === "cell" &&
    node.cellType === "javascript" &&
    node.name &&
    node.nodeIndex >= startIndex
  ));

  for (const node of scripts) {
    if (shouldRunJavascriptCell(node)) {
      await runJavascriptCell(node);
    }
  }
}

function shouldRunJavascriptCell(node) {
  if (!node.name || appState.inflightScripts.has(node.name)) {
    return false;
  }

  const snapshot = buildJavascriptExecutionSnapshot(node, appState);
  const runtimeEntry = appState.runtimeState.javascript[node.name];
  return !runtimeEntry || runtimeEntry.inputHash !== snapshot.inputHash;
}

async function runJavascriptCell(node, options = {}) {
  if (!node.name || appState.inflightScripts.has(node.name)) {
    return;
  }

  const snapshot = buildJavascriptExecutionSnapshot(node, appState);
  const runtimeEntry = appState.runtimeState.javascript[node.name];
  if (!options.force && runtimeEntry && runtimeEntry.inputHash === snapshot.inputHash) {
    return;
  }

  appState.inflightScripts.add(node.name);
  callbacks.renderApp();

  try {
    const result = await executeJavascriptInWorker(node.source || "", snapshot.paramNames, snapshot.paramValues, getJavascriptTimeoutMs(node));
    appState.runtimeState.javascript[node.name] = {
      status: "success",
      statusText: "Completed",
      output: result.output,
      outputText: result.outputText,
      inputHash: snapshot.inputHash,
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    appState.runtimeState.javascript[node.name] = {
      status: "failure",
      statusText: `Script failed: ${error instanceof Error ? error.message : String(error)}`,
      output: null,
      outputText: error instanceof Error ? error.message : String(error),
      inputHash: snapshot.inputHash,
      updatedAt: new Date().toISOString()
    };
  } finally {
    appState.inflightScripts.delete(node.name);
    callbacks.persistRuntimeStateToHost();
    callbacks.renderApp();
  }

  if (options.propagate) {
    scheduleJavascriptExecutionFromIndex(node.nodeIndex + 1);
  }

  scheduleAutoHTTPExecutionFromIndex(node.nodeIndex + 1, { delayMs: 0 });
}

function executeJavascriptInWorker(source, paramNames, paramValues, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (typeof Worker !== "function" || typeof Blob !== "function" || typeof URL === "undefined") {
      reject(new Error("JavaScript worker execution is unavailable"));
      return;
    }

    const workerSource = `
      function makeSerializable(value) {
        const seen = new WeakSet();
        function visit(input, depth) {
          if (depth > 20) {
            return "[MaxDepth]";
          }
          if (input === undefined) {
            return null;
          }
          if (input === null || typeof input === "string" || typeof input === "boolean") {
            return input;
          }
          if (typeof input === "number") {
            return Number.isFinite(input) ? input : String(input);
          }
          if (typeof input === "bigint" || typeof input === "symbol") {
            return String(input);
          }
          if (typeof input === "function") {
            return "[Function" + (input.name ? " " + input.name : "") + "]";
          }
          if (input instanceof Error) {
            return { name: input.name, message: input.message, stack: input.stack || "" };
          }
          if (Array.isArray(input)) {
            return input.map((item) => visit(item, depth + 1));
          }
          if (typeof input === "object") {
            if (seen.has(input)) {
              return "[Circular]";
            }
            seen.add(input);
            const output = {};
            Object.entries(input).forEach(([key, item]) => {
              output[key] = visit(item, depth + 1);
            });
            return output;
          }
          return String(input);
        }
        return visit(value, 0);
      }

      function formatOutput(value, serializableValue) {
        if (value === undefined) {
          return "undefined";
        }
        if (typeof value === "string") {
          return value;
        }
        return JSON.stringify(serializableValue, null, 2);
      }

      self.onmessage = async (event) => {
        const payload = event.data || {};
        try {
          const fn = new Function(...payload.paramNames, '"use strict";\\n' + payload.source);
          const value = await fn(...payload.paramValues);
          const output = makeSerializable(value);
          self.postMessage({ ok: true, output, outputText: formatOutput(value, output) });
        } catch (error) {
          self.postMessage({ ok: false, error: error && error.message ? error.message : String(error) });
        }
      };
    `;

    const blob = new Blob([workerSource], { type: "application/javascript" });
    const workerURL = URL.createObjectURL(blob);
    const worker = new Worker(workerURL);
    let settled = false;

    const cleanup = () => {
      worker.terminate();
      URL.revokeObjectURL(workerURL);
    };

    const timer = window.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    worker.onmessage = (event) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      cleanup();
      const message = event.data || {};
      if (message.ok) {
        resolve({ output: message.output, outputText: message.outputText || "" });
      } else {
        reject(new Error(message.error || "Script execution failed"));
      }
    };

    worker.onerror = (event) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timer);
      cleanup();
      reject(new Error(event.message || "Script execution failed"));
    };

    try {
      worker.postMessage({ source, paramNames, paramValues });
    } catch (error) {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        cleanup();
        reject(error);
      }
    }
  });
}

function getJavascriptTimeoutMs(node) {
  const rawValue = node.attributes.timeoutMs || node.attributes.timeout || "";
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return 2000;
  }
  return Math.min(Math.max(parsed, 100), 30000);
}

async function runHTTPCell(node, options = {}) {
  if (!node.name || appState.inflightRequests.has(node.name)) {
    return;
  }

  const httpState = buildHTTPNodeState(node, appState);
  if (httpState.templateError) {
    callbacks.renderApp();
    return;
  }

  appState.inflightRequests.add(node.name);
  callbacks.renderApp();

  try {
    const secretValuesByReference = await resolveSecretValuesForHTTPNode(node, appState);
    const actualSnapshotResult = resolveHTTPSnapshot(node, appState, {
      secretMode: "actual",
      secretValuesByReference
    });
    if (actualSnapshotResult.error) {
      throw new Error(actualSnapshotResult.error);
    }

    const actualSnapshot = actualSnapshotResult.snapshot;
    const response = await fetch(actualSnapshot.url, {
      method: actualSnapshot.method,
      headers: Object.fromEntries(actualSnapshot.headers.map((header) => [header.name, header.value])),
      body: shouldSendBody(actualSnapshot.method, actualSnapshot.body) ? actualSnapshot.body : undefined
    });

    const responseText = await response.text();
    appState.runtimeState.http[node.name] = {
      request: normalizeSnapshot(httpState.snapshot),
      statusText: `${response.status} ${response.statusText}`.trim(),
      responseBody: formatHTTPResponseBody(responseText, response.headers.get("content-type")),
      statusCode: response.status
    };
    callbacks.persistRuntimeStateToHost();
  } catch (error) {
    appState.runtimeState.http[node.name] = {
      request: normalizeSnapshot(httpState.snapshot),
      statusText: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      responseBody: "",
      statusCode: null
    };
    callbacks.persistRuntimeStateToHost();
  } finally {
    appState.inflightRequests.delete(node.name);
    callbacks.renderApp();
    if (options.propagate !== false) {
      scheduleAutoHTTPExecutionFromIndex(node.nodeIndex + 1, { delayMs: 0 });
    }
  }
}

async function resolveSecretValuesForHTTPNode(node, state) {
  const secretBindingsByReference = collectSecretBindingsForHTTPNode(node, state);
  const secretNames = [...new Set(Object.values(secretBindingsByReference).filter(Boolean))];
  if (!secretNames.length) {
    return {};
  }

  if (!window.rundownHost || typeof window.rundownHost.request !== "function") {
    throw new Error("RunDown host bridge is unavailable");
  }

  const response = await window.rundownHost.request("resolveSecrets", { secretNames });
  const secretsByName = response && response.secrets ? response.secrets : {};
  return Object.fromEntries(Object.entries(secretBindingsByReference).map(([reference, secretName]) => {
    if (!Object.prototype.hasOwnProperty.call(secretsByName, secretName)) {
      throw new Error(`Secret unavailable: ${secretName}`);
    }
    return [reference, secretsByName[secretName]];
  }));
}

function collectSecretBindingsForHTTPNode(node, state) {
  const context = buildTemplateContext(state.parsedDocument.nodes, state.runtimeState);
  const bindings = {};
  const templateSources = [
    node.method || "GET",
    node.url || "",
    ...(node.headers || []).flatMap((header) => [header.name || "", header.value || ""]),
    node.body || ""
  ];

  templateSources.forEach((source) => {
    collectTemplateExpressions(source).forEach((expression) => {
      const secretSlot = getSecretSlotForTemplateExpression(expression, context);
      if (secretSlot && secretSlot.secretName) {
        bindings[`${secretSlot.namespaceName}.${secretSlot.key}`] = secretSlot.secretName;
      }
    });
  });

  return bindings;
}

function collectTemplateExpressions(text) {
  const expressions = [];
  String(text || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    expressions.push(String(expression || "").trim());
    return "";
  });
  return expressions;
}

function getSecretSlotForTemplateExpression(expression, context) {
  const path = String(expression || "").trim();
  if (!path) {
    return null;
  }

  const segments = path.split(".").filter(Boolean);
  const root = segments.shift();
  if (!root || !Object.prototype.hasOwnProperty.call(context.secretSlotsByNamespace, root)) {
    return null;
  }

  const key = segments.join(".");
  const namespaceSlots = context.secretSlotsByNamespace[root] || {};
  return Object.prototype.hasOwnProperty.call(namespaceSlots, key) ? namespaceSlots[key] : null;
}

function shouldSendBody(method, body) {
  return Boolean(body) && !["GET", "HEAD"].includes(String(method || "GET").toUpperCase());
}

function formatHTTPResponseBody(text, contentType) {
  const responseText = String(text || "");
  if (!responseText) {
    return "<empty response body>";
  }

  const loweredType = String(contentType || "").toLowerCase();
  if (loweredType.includes("json") || looksLikeJSON(responseText)) {
    try {
      return JSON.stringify(JSON.parse(responseText), null, 2);
    } catch {
      return responseText;
    }
  }

  return responseText;
}

function looksLikeJSON(text) {
  const trimmed = String(text || "").trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

  return {
    scheduleAutoHTTPExecutionFromIndex,
    scheduleJavascriptExecutionFromIndex,
    runHTTPCell,
    runJavascriptCell
  };
}
