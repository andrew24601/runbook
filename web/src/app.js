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
    secretBindings: {},
    http: {},
    javascript: {}
  }
};

const appState = {
  runtimeState: normalizeRuntimeState(bootstrap.runtimeState),
  parsedDocument: parseWorkbookDocument(bootstrap.document && bootstrap.document.source ? bootstrap.document.source : ""),
  inflightRequests: new Set(),
  inflightScripts: new Set(),
  expandedHTTPCells: new Set(),
  secretNames: [],
  secretNamesLoaded: false,
  secretNamesError: "",
  showHiddenRuntimeCells: false,
  httpExecutionActive: false,
  httpExecutionScheduled: false,
  pendingHTTPStartIndex: Infinity,
  pendingHTTPTimer: null,
  javascriptExecutionActive: false,
  javascriptExecutionScheduled: false,
  pendingJavascriptStartIndex: Infinity
};

window.RunDown = {
  ...(window.RunDown || {}),
  areHiddenRuntimeCellsVisible() {
    return appState.showHiddenRuntimeCells;
  },
  setHiddenRuntimeCellsVisible(isVisible) {
    appState.showHiddenRuntimeCells = Boolean(isVisible);
    renderApp();
    return appState.showHiddenRuntimeCells;
  },
  toggleHiddenRuntimeCells() {
    appState.showHiddenRuntimeCells = !appState.showHiddenRuntimeCells;
    renderApp();
    return appState.showHiddenRuntimeCells;
  },
  areHiddenJavascriptCellsVisible() {
    return appState.showHiddenRuntimeCells;
  },
  setHiddenJavascriptCellsVisible(isVisible) {
    appState.showHiddenRuntimeCells = Boolean(isVisible);
    renderApp();
    return appState.showHiddenRuntimeCells;
  },
  toggleHiddenJavascriptCells() {
    appState.showHiddenRuntimeCells = !appState.showHiddenRuntimeCells;
    renderApp();
    return appState.showHiddenRuntimeCells;
  }
};

const app = document.getElementById("app");
if (app) {
  renderApp();
  refreshSecretNamesFromHost();
  scheduleAutoHTTPExecutionFromIndex(0, { delayMs: 0 });
}

window.addEventListener("pagehide", () => {
  persistRuntimeStateToHost();
});

window.addEventListener("beforeunload", () => {
  persistRuntimeStateToHost();
});

window.addEventListener("focus", () => {
  refreshSecretNamesFromHost();
});

function normalizeRuntimeState(state) {
  return {
    variableNamespaceCount: state && typeof state.variableNamespaceCount === "number" ? state.variableNamespaceCount : 0,
    httpEntryCount: state && typeof state.httpEntryCount === "number" ? state.httpEntryCount : 0,
    variables: state && state.variables ? state.variables : {},
    secretBindings: state && state.secretBindings ? state.secretBindings : {},
    http: state && state.http ? state.http : {},
    javascript: state && state.javascript ? state.javascript : {}
  };
}

async function refreshSecretNamesFromHost() {
  if (!window.rundownHost || typeof window.rundownHost.request !== "function") {
    appState.secretNames = [];
    appState.secretNamesLoaded = true;
    appState.secretNamesError = "";
    renderApp();
    return;
  }

  try {
    const response = await window.rundownHost.request("listSecrets");
    appState.secretNames = Array.isArray(response && response.secretNames)
      ? response.secretNames.filter((name) => typeof name === "string").sort((left, right) => left.localeCompare(right))
      : [];
    appState.secretNamesError = "";
  } catch (error) {
    appState.secretNames = [];
    appState.secretNamesError = error instanceof Error ? error.message : String(error);
  } finally {
    appState.secretNamesLoaded = true;
    renderApp();
  }
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

function isWorkbookFenceLanguage(language) {
  return language === "http" || language === "variables" || language === "assert" || language === "json" || language === "javascript";
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

  nodes.forEach((node) => {
    if (node.cellType === "http" && isAutoHTTPNode(node)) {
      const httpState = buildHTTPNodeState(node, state);
      if (!shouldRenderAutoHTTPCell(httpState, state)) {
        return;
      }
    }

    if (node.cellType === "javascript") {
      const javascriptState = buildJavascriptNodeState(node, state);
      if (!shouldRenderJavascriptCell(javascriptState, state)) {
        return;
      }
    }

    section.appendChild(renderDocumentNode(node, state));
  });
  return section;
}

function shouldRenderAutoHTTPCell(httpState, state) {
  return state.showHiddenRuntimeCells || httpState.bloomState === "failure";
}

function shouldRenderJavascriptCell(javascriptState, state) {
  return state.showHiddenRuntimeCells || javascriptState.bloomState === "failure";
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
  const javascriptState = node.cellType === "javascript" ? buildJavascriptNodeState(node, state) : null;
  if (httpState || javascriptState) {
    const bloomState = httpState ? httpState.bloomState : javascriptState.bloomState;
    article.classList.add("document-node-bloom", `document-node-${bloomState}`);
  }

  const detail = renderNodeDetail(node, state, httpState, javascriptState);
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

function renderNodeDetail(node, state, precomputedHTTPState = null, precomputedJavascriptState = null) {
  if (node.cellType === "http") {
    return renderHTTPCell(node, precomputedHTTPState || buildHTTPNodeState(node, state), state);
  }

  if (node.cellType === "variables") {
    return renderVariablesEditor(node, state);
  }

  if (node.cellType === "json") {
    return renderJSONCodeBlock(resolveJSONNodeText(node, state));
  }

  if (node.cellType === "javascript") {
    return renderJavascriptCell(node, precomputedJavascriptState || buildJavascriptNodeState(node, state), state);
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

function renderJavascriptCell(node, javascriptState, state) {
  const wrap = document.createElement("div");
  wrap.className = "javascript-cell";

  if (javascriptState.outputText) {
    wrap.appendChild(renderRuntimeSection(javascriptState.outputLabel, javascriptState.outputText, javascriptState.bloomState));
  } else if (state.showHiddenRuntimeCells) {
    wrap.appendChild(renderRuntimeSection("Status", javascriptState.statusText, javascriptState.bloomState));
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

    if (entry.isSecretSlot) {
      row.appendChild(renderSecretBindingSelect(node.name, entry, state, node.nodeIndex));
      editor.appendChild(row);
      return;
    }

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
      scheduleAutoHTTPExecutionFromIndex(node.nodeIndex + 1);
    });
    input.addEventListener("change", () => {
      persistRuntimeStateToHost();
    });
    row.appendChild(input);

    editor.appendChild(row);
  });

  return editor;
}

function renderSecretBindingSelect(namespaceName, entry, state, nodeIndex) {
  const select = document.createElement("select");
  select.className = "variable-input variable-secret-select";
  select.value = getSecretBinding(state.runtimeState, namespaceName, entry.key);
  select.disabled = Boolean(state.secretNamesError);

  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = state.secretNamesLoaded ? "Select a secret" : "Loading secrets...";
  select.appendChild(emptyOption);

  const boundSecretName = getSecretBinding(state.runtimeState, namespaceName, entry.key);
  const optionNames = [...state.secretNames];
  if (boundSecretName && !optionNames.includes(boundSecretName)) {
    optionNames.push(boundSecretName);
  }

  optionNames.forEach((secretName) => {
    const option = document.createElement("option");
    option.value = secretName;
    option.textContent = secretName === boundSecretName || state.secretNames.includes(secretName)
      ? secretName
      : `${secretName} (missing)`;
    select.appendChild(option);
  });

  select.value = boundSecretName;
  select.addEventListener("focus", () => {
    refreshSecretNamesFromHost();
  });
  select.addEventListener("change", () => {
    setSecretBinding(state.runtimeState, namespaceName, entry.key, select.value);
    persistRuntimeStateToHost();
    refreshTemplateDrivenNodes();
    scheduleAutoHTTPExecutionFromIndex(nodeIndex + 1);
  });
  return select;
}

function refreshTemplateDrivenNodes() {
  let needsFullRender = false;

  appState.parsedDocument.nodes.forEach((node) => {
    if (node.kind !== "markdown" && (node.kind !== "cell" || (node.cellType !== "http" && node.cellType !== "json" && node.cellType !== "javascript"))) {
      return;
    }

    const article = app ? app.querySelector(`[data-node-index="${node.nodeIndex}"]`) : null;
    if (!article) {
      if (node.cellType === "http" && isAutoHTTPNode(node)) {
        const httpState = buildHTTPNodeState(node, appState);
        if (shouldRenderAutoHTTPCell(httpState, appState)) {
          needsFullRender = true;
        }
      }

      if (node.cellType === "javascript") {
        const javascriptState = buildJavascriptNodeState(node, appState);
        if (shouldRenderJavascriptCell(javascriptState, appState)) {
          needsFullRender = true;
        }
      }
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
      if (isAutoHTTPNode(node) && !shouldRenderAutoHTTPCell(httpState, appState)) {
        article.remove();
        return;
      }
      article.className = `document-node document-node-${sanitizeClassName(node.cellType)}`;
      article.classList.add("document-node-bloom", `document-node-${httpState.bloomState}`);
      article.replaceChildren(renderHTTPCell(node, httpState, appState));
      return;
    }

    if (node.cellType === "javascript") {
      const javascriptState = buildJavascriptNodeState(node, appState);
      if (!shouldRenderJavascriptCell(javascriptState, appState)) {
        article.remove();
        return;
      }
      article.className = `document-node document-node-${sanitizeClassName(node.cellType)}`;
      article.classList.add("document-node-bloom", `document-node-${javascriptState.bloomState}`);
      article.replaceChildren(renderJavascriptCell(node, javascriptState, appState));
      return;
    }

    article.replaceChildren(renderJSONCodeBlock(resolveJSONNodeText(node, appState)));
  });

  if (needsFullRender) {
    renderApp();
  }
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

function getSecretBinding(runtimeState, namespaceName, key) {
  const namespaceBindings = runtimeState.secretBindings && runtimeState.secretBindings[namespaceName] ? runtimeState.secretBindings[namespaceName] : null;
  if (namespaceBindings && Object.prototype.hasOwnProperty.call(namespaceBindings, key)) {
    return namespaceBindings[key];
  }

  return "";
}

function setSecretBinding(runtimeState, namespaceName, key, secretName) {
  if (!namespaceName || !key) {
    return;
  }

  if (!runtimeState.secretBindings) {
    runtimeState.secretBindings = {};
  }

  const namespaceBindings = runtimeState.secretBindings[namespaceName] ? { ...runtimeState.secretBindings[namespaceName] } : {};
  const normalizedSecretName = String(secretName || "").trim();
  if (normalizedSecretName) {
    namespaceBindings[key] = normalizedSecretName;
  } else {
    delete namespaceBindings[key];
  }

  if (Object.keys(namespaceBindings).length === 0) {
    delete runtimeState.secretBindings[namespaceName];
  } else {
    runtimeState.secretBindings[namespaceName] = namespaceBindings;
  }
}

function buildHTTPNodeState(node, state) {
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

function buildJavascriptNodeState(node, state) {
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

function buildJavascriptExecutionSnapshot(node, state) {
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

function buildJavascriptParameterContext(nodes, runtimeState, beforeNodeIndex) {
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

function buildVariablesOutput(node, runtimeState) {
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

function resolveHTTPSnapshot(node, state, options = {}) {
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

function buildTemplateContext(nodes, runtimeState, options = {}) {
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

function isAutoHTTPNode(node) {
  if (!node || node.cellType !== "http") {
    return false;
  }

  const attributes = node.attributes || {};
  return isTruthyAttribute(attributes.auto) ||
    isTruthyAttribute(attributes.autorun) ||
    isTruthyAttribute(attributes.autoRun) ||
    String(attributes.run || "").trim().toLowerCase() === "auto";
}

function isTruthyAttribute(value) {
  return ["true", "1", "yes", "on", "auto"].includes(String(value || "").trim().toLowerCase());
}

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
  renderApp();

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
    persistRuntimeStateToHost();
    renderApp();
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
    renderApp();
    return;
  }

  appState.inflightRequests.add(node.name);
  renderApp();

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

function persistRuntimeStateToHost() {
  if (!window.rundownHost || typeof window.rundownHost.persistRuntimeState !== "function" || !bootstrap.cachePath) {
    return;
  }

  window.rundownHost.persistRuntimeState(buildPersistedRuntimeState(appState.runtimeState, appState.parsedDocument.nodes), bootstrap.cachePath);
}

function buildPersistedRuntimeState(runtimeState, nodes = []) {
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

function buildSecretSlotKeyMap(nodes) {
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

function sanitizePersistedVariables(variables, secretSlotKeys) {
  return Object.fromEntries(Object.entries(variables || {}).map(([namespaceName, values]) => {
    const secretKeys = secretSlotKeys[namespaceName] || new Set();
    return [
      namespaceName,
      Object.fromEntries(Object.entries(values || {}).filter(([key]) => !secretKeys.has(key)))
    ];
  }).filter(([, values]) => Object.keys(values).length > 0));
}

function sanitizePersistedSecretBindings(secretBindings, secretSlotKeys) {
  return Object.fromEntries(Object.entries(secretBindings || {}).map(([namespaceName, values]) => {
    const secretKeys = secretSlotKeys[namespaceName] || new Set();
    return [
      namespaceName,
      Object.fromEntries(Object.entries(values || {}).filter(([key, secretName]) => secretKeys.has(key) && String(secretName || "").trim()))
    ];
  }).filter(([, values]) => Object.keys(values).length > 0));
}

function sanitizeClassName(value) {
  return String(value || "node").replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
}

function isValidJavascriptIdentifier(value) {
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

function stableStringify(value) {
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

function sanitizePersistedJavascriptOutput(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}
