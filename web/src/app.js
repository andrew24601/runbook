import { marked } from "marked";

const bootstrap = window.__RUNDOWN_BOOTSTRAP__ || {
  appName: "RunDown",
  phase: "native-webview-shell",
  representedPath: "",
  cachePath: "",
  document: {
    sourceLabel: "",
    source: ""
  },
  runtimeState: {
    variableNamespaceCount: 0,
    httpEntryCount: 0,
    variables: {},
    http: {}
  }
};

const appState = {
  runtimeState: normalizeRuntimeState(bootstrap.runtimeState),
  parsedDocument: parseWorkbookDocument(bootstrap.document && bootstrap.document.source ? bootstrap.document.source : ""),
  inflightRequests: new Set(),
  expandedHTTPCells: new Set()
};

const app = document.getElementById("app");
if (app) {
  renderApp();
}

window.addEventListener("pagehide", () => {
  persistRuntimeStateToHost();
});

window.addEventListener("beforeunload", () => {
  persistRuntimeStateToHost();
});

function normalizeRuntimeState(state) {
  return {
    variableNamespaceCount: state && typeof state.variableNamespaceCount === "number" ? state.variableNamespaceCount : 0,
    httpEntryCount: state && typeof state.httpEntryCount === "number" ? state.httpEntryCount : 0,
    variables: state && state.variables ? state.variables : {},
    http: state && state.http ? state.http : {}
  };
}

function renderApp() {
  if (!app) {
    return;
  }

  app.innerHTML = "";
  app.appendChild(renderDocumentFlow(appState.parsedDocument.nodes, appState));
}

function parseWorkbookDocument(source) {
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

function parseFenceInfo(infoString) {
  const trimmed = String(infoString || "").trim();
  if (!trimmed) {
    return { language: "", attributes: {} };
  }

  const firstSpace = trimmed.search(/\s/);
  const language = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).trim().toLowerCase();
  const attributeSource = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
  const attributes = {};
  const pattern = /(\w+)="([^"]*)"/g;
  let match = pattern.exec(attributeSource);
  while (match) {
    attributes[match[1]] = match[2];
    match = pattern.exec(attributeSource);
  }

  return { language, attributes };
}

function isWorkbookFenceLanguage(language) {
  return language === "http" || language === "variables" || language === "assert" || language === "json";
}

function parseWorkbookCell(token, fence, nodeIndex) {
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
        return { key: line, value: "" };
      }

      return {
        key: line.slice(0, separatorIndex).trim(),
        value: normalizeVariableValue(line.slice(separatorIndex + 1).trim())
      };
    });
}

function normalizeVariableValue(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function renderDocumentFlow(nodes, state) {
  const section = document.createElement("main");
  section.className = "document-flow";

  if (!nodes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No workbook nodes were parsed from the current document.";
    section.appendChild(empty);
    return section;
  }

  nodes.forEach((node) => section.appendChild(renderDocumentNode(node, state)));
  return section;
}

function renderDocumentNode(node, state) {
  const article = document.createElement(node.kind === "markdown" ? "section" : "article");
  article.className = `document-node document-node-${sanitizeClassName(node.cellType || node.kind || "node")}`;
  article.dataset.nodeIndex = String(node.nodeIndex);

  if (node.kind === "markdown") {
    const prose = document.createElement("div");
    prose.className = "markdown-body";
    prose.innerHTML = marked.parse(resolveTemplateStringLenient(node.rawText || "", buildTemplateContext(state.parsedDocument.nodes, state.runtimeState)));
    article.appendChild(prose);
    return article;
  }

  const httpState = node.cellType === "http" ? buildHTTPNodeState(node, state) : null;
  if (httpState) {
    article.classList.add("document-node-bloom", `document-node-${httpState.bloomState}`);
  }

  const detail = renderNodeDetail(node, state, httpState);
  if (detail) {
    article.appendChild(detail);
  }

  return article;
}

function renderRuntimePill(node, httpState) {
  if (node.cellType !== "http" || !node.name || !httpState) {
    return null;
  }

  const pill = document.createElement("span");
  pill.className = `state state-${httpState.bloomState}`;
  pill.textContent = httpState.statusText;
  return pill;
}

function renderNodeDetail(node, state, precomputedHTTPState = null) {
  if (node.cellType === "http") {
    return renderHTTPCell(node, precomputedHTTPState || buildHTTPNodeState(node, state), state);
  }

  if (node.cellType === "variables") {
    return renderVariablesEditor(node, state);
  }

  if (node.cellType === "json") {
    return renderJSONCodeBlock(resolveJSONNodeText(node, state));
  }

  return renderCodeBlock(node.source || "");
}

function renderHTTPCell(node, httpState, state) {
  const wrap = document.createElement("div");
  wrap.className = "http-cell";

  const row = document.createElement("div");
  row.className = "http-row";

  const button = document.createElement("button");
  button.className = "http-run-button";
  button.textContent = httpState.snapshot.method || "GET";
  button.disabled = state.inflightRequests.has(node.name) || Boolean(httpState.templateError);
  button.addEventListener("click", () => {
    runHTTPCell(node);
  });
  row.appendChild(button);

  const url = document.createElement("p");
  url.className = "http-url";
  url.textContent = httpState.templateError || httpState.snapshot.url || "";
  row.appendChild(url);

  if (httpState.responseBody) {
    const key = getHTTPExpansionKey(node);
    const toggle = document.createElement("button");
    const isExpanded = state.expandedHTTPCells.has(key);
    toggle.className = "http-expand-button";
    toggle.classList.toggle("is-expanded", isExpanded);
    toggle.type = "button";
    toggle.textContent = "Response";
    toggle.setAttribute("aria-label", isExpanded ? "Hide cached response" : "Show cached response");
    toggle.setAttribute("aria-expanded", String(isExpanded));
    toggle.addEventListener("click", () => {
      if (state.expandedHTTPCells.has(key)) {
        state.expandedHTTPCells.delete(key);
      } else {
        state.expandedHTTPCells.add(key);
      }
      renderApp();
    });
    row.appendChild(toggle);
  }

  const runtimeLabel = renderRuntimePill(node, httpState);
  if (runtimeLabel) {
    row.appendChild(runtimeLabel);
  }

  wrap.appendChild(row);

  if (httpState.responseBody && state.expandedHTTPCells.has(getHTTPExpansionKey(node))) {
    wrap.appendChild(renderRuntimeSection(httpState.responseLabel, httpState.responseBody, httpState.bloomState));
  }

  return wrap;
}

function renderVariablesEditor(node, state) {
  if (!node.name || !Array.isArray(node.variables) || !node.variables.length) {
    return renderCodeBlock(node.source || "");
  }

  const editor = document.createElement("div");
  editor.className = "variables-editor";

  node.variables.forEach((entry) => {
    const row = document.createElement("label");
    row.className = "variable-row";

    const key = document.createElement("span");
    key.className = "variable-key";
    key.textContent = entry.key;
    row.appendChild(key);

    const input = document.createElement("input");
    input.className = "variable-input";
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = getVariableValue(state.runtimeState, node.name, entry.key, entry.value);
    input.placeholder = entry.value || "";
    input.addEventListener("input", () => {
      setVariableValue(state.runtimeState, node.name, entry.key, input.value, entry.value);
      persistRuntimeStateToHost();
      refreshTemplateDrivenNodes();
    });
    input.addEventListener("change", () => {
      persistRuntimeStateToHost();
    });
    row.appendChild(input);

    editor.appendChild(row);
  });

  return editor;
}

function refreshTemplateDrivenNodes() {
  appState.parsedDocument.nodes.forEach((node) => {
    if (node.kind !== "markdown" && (node.kind !== "cell" || (node.cellType !== "http" && node.cellType !== "json"))) {
      return;
    }

    const article = app ? app.querySelector(`[data-node-index="${node.nodeIndex}"]`) : null;
    if (!article) {
      return;
    }

    if (node.kind === "markdown") {
      const prose = document.createElement("div");
      prose.className = "markdown-body";
      prose.innerHTML = marked.parse(resolveTemplateStringLenient(node.rawText || "", buildTemplateContext(appState.parsedDocument.nodes, appState.runtimeState)));
      article.replaceChildren(prose);
      return;
    }

    if (node.cellType === "http") {
      const httpState = buildHTTPNodeState(node, appState);
      article.className = `document-node document-node-${sanitizeClassName(node.cellType)}`;
      article.classList.add("document-node-bloom", `document-node-${httpState.bloomState}`);
      article.replaceChildren(renderHTTPCell(node, httpState, appState));
      return;
    }

    article.replaceChildren(renderJSONCodeBlock(resolveJSONNodeText(node, appState)));
  });
}

function renderRuntimeSection(label, text, tone = "idle") {
  const wrap = document.createElement("div");
  wrap.className = "runtime-section";

  const title = document.createElement("p");
  title.className = `runtime-title runtime-title-${tone}`;
  title.textContent = label;
  wrap.appendChild(title);
  wrap.appendChild(renderCodeBlock(text));
  return wrap;
}

function renderCodeBlock(text) {
  const pre = document.createElement("pre");
  pre.className = "code-block";
  pre.textContent = text;
  return pre;
}

function renderJSONCodeBlock(text) {
  const pre = document.createElement("pre");
  pre.className = "code-block code-block-json";
  const source = String(text || "");

  try {
    JSON.parse(source);
  } catch {
    pre.textContent = source;
    return pre;
  }

  appendHighlightedJSON(pre, source);
  return pre;
}

function appendHighlightedJSON(parent, source) {
  const pattern = /"(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}\[\],:]/g;
  let cursor = 0;
  let match = pattern.exec(source);

  while (match) {
    if (match.index > cursor) {
      parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    }

    const token = match[0];
    const span = document.createElement("span");
    span.className = `json-token ${getJSONTokenClass(token, source.slice(pattern.lastIndex))}`;
    span.textContent = token;
    parent.appendChild(span);
    cursor = pattern.lastIndex;
    match = pattern.exec(source);
  }

  if (cursor < source.length) {
    parent.appendChild(document.createTextNode(source.slice(cursor)));
  }
}

function getJSONTokenClass(token, trailingSource = "") {
  if (token.startsWith("\"")) {
    return /^\s*:/.test(trailingSource) ? "json-key" : "json-string";
  }

  if (token === "true" || token === "false") {
    return "json-boolean";
  }

  if (token === "null") {
    return "json-null";
  }

  if (/^-?\d/.test(token)) {
    return "json-number";
  }

  return "json-punctuation";
}

function getHTTPExpansionKey(node) {
  return node.name || `http-${node.nodeIndex}`;
}

function getVariableValue(runtimeState, namespaceName, key, fallbackValue) {
  const namespaceValues = runtimeState.variables && runtimeState.variables[namespaceName] ? runtimeState.variables[namespaceName] : null;
  if (namespaceValues && Object.prototype.hasOwnProperty.call(namespaceValues, key)) {
    return namespaceValues[key];
  }

  return fallbackValue || "";
}

function setVariableValue(runtimeState, namespaceName, key, value, defaultValue) {
  if (!namespaceName || !key) {
    return;
  }

  const nextValue = String(value || "");
  const fallbackValue = String(defaultValue || "");
  const namespaceValues = runtimeState.variables[namespaceName] ? { ...runtimeState.variables[namespaceName] } : {};

  if (nextValue === fallbackValue) {
    delete namespaceValues[key];
  } else {
    namespaceValues[key] = nextValue;
  }

  if (Object.keys(namespaceValues).length === 0) {
    delete runtimeState.variables[namespaceName];
  } else {
    runtimeState.variables[namespaceName] = namespaceValues;
  }
}

function buildHTTPNodeState(node, state) {
  const snapshotResult = resolveHTTPSnapshot(node, state);
  const runtimeEntry = node.name ? state.runtimeState.http[node.name] : null;
  const snapshot = snapshotResult.snapshot;
  const templateError = snapshotResult.error;
  const isOutOfDate = runtimeEntry && runtimeEntry.request ? !requestSnapshotsEqual(runtimeEntry.request, snapshot) : false;

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

function resolveHTTPSnapshot(node, state) {
  const context = buildTemplateContext(state.parsedDocument.nodes, state.runtimeState);

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

function buildTemplateContext(nodes, runtimeState) {
  const variablesByNamespace = {};
  const httpEntriesByCell = {};

  nodes.forEach((node) => {
    if (node.kind === "cell" && node.cellType === "variables" && node.name) {
      const namespaceValues = {};
      (node.variables || []).forEach((entry) => {
        namespaceValues[entry.key] = entry.value;
      });
      variablesByNamespace[node.name] = namespaceValues;
    }
  });

  Object.entries(runtimeState.variables || {}).forEach(([namespaceName, values]) => {
    variablesByNamespace[namespaceName] = {
      ...(variablesByNamespace[namespaceName] || {}),
      ...(values || {})
    };
  });

  Object.entries(runtimeState.http || {}).forEach(([cellName, entry]) => {
    httpEntriesByCell[cellName] = buildHTTPRuntimeEnvelope(entry || {});
  });

  return {
    variablesByNamespace,
    httpEntriesByCell
  };
}

function buildHTTPRuntimeEnvelope(entry) {
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

function resolveTemplateStringLenient(text, context) {
  return String(text || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    try {
      const value = resolveTemplateExpression(expression, context);
      return stringifyTemplateValue(value);
    } catch {
      return "";
    }
  });
}

function resolveTemplateStringStrict(text, context) {
  return String(text || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expression) => {
    const value = resolveTemplateExpression(expression, context);
    return stringifyTemplateValue(value);
  });
}

function resolveTemplateExpression(expression, context) {
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
    return resolvePathValue(context.variablesByNamespace[root], segments, true, path);
  }

  if (Object.prototype.hasOwnProperty.call(context.httpEntriesByCell, root)) {
    return resolvePathValue(context.httpEntriesByCell[root], segments, false, path);
  }

  throw new Error(`Unknown template root: ${root}`);
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

function requestSnapshotsEqual(left, right) {
  return JSON.stringify(normalizeSnapshot(left)) === JSON.stringify(normalizeSnapshot(right));
}

function normalizeSnapshot(snapshot) {
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

function resolveJSONNodeText(node, state) {
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

function formatPossiblyJSONText(text) {
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

async function runHTTPCell(node) {
  if (!node.name || appState.inflightRequests.has(node.name)) {
    return;
  }

  const httpState = buildHTTPNodeState(node, appState);
  if (httpState.templateError) {
    renderApp();
    return;
  }

  appState.inflightRequests.add(node.name);
  renderApp();

  try {
    const response = await fetch(httpState.snapshot.url, {
      method: httpState.snapshot.method,
      headers: Object.fromEntries(httpState.snapshot.headers.map((header) => [header.name, header.value])),
      body: shouldSendBody(httpState.snapshot.method, httpState.snapshot.body) ? httpState.snapshot.body : undefined
    });

    const responseText = await response.text();
    appState.runtimeState.http[node.name] = {
      request: normalizeSnapshot(httpState.snapshot),
      statusText: `${response.status} ${response.statusText}`.trim(),
      responseBody: formatHTTPResponseBody(responseText, response.headers.get("content-type")),
      statusCode: response.status
    };
    persistRuntimeStateToHost();
  } catch (error) {
    appState.runtimeState.http[node.name] = {
      request: normalizeSnapshot(httpState.snapshot),
      statusText: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      responseBody: "",
      statusCode: null
    };
    persistRuntimeStateToHost();
  } finally {
    appState.inflightRequests.delete(node.name);
    renderApp();
  }
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

function persistRuntimeStateToHost() {
  if (!window.rundownHost || typeof window.rundownHost.persistRuntimeState !== "function" || !bootstrap.cachePath) {
    return;
  }

  window.rundownHost.persistRuntimeState(buildPersistedRuntimeState(appState.runtimeState), bootstrap.cachePath);
}

function buildPersistedRuntimeState(runtimeState) {
  return {
    variables: runtimeState.variables || {},
    http: Object.fromEntries(Object.entries(runtimeState.http || {}).map(([cellName, entry]) => [
      cellName,
      {
        statusText: entry.statusText || "",
        responseBody: entry.responseBody || "",
        ...(typeof entry.statusCode === "number" ? { statusCode: entry.statusCode } : {}),
        ...(entry.request ? { request: normalizeSnapshot(entry.request) } : {})
      }
    ]))
  };
}

function sanitizeClassName(value) {
  return String(value || "node").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}
