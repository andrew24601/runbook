
import { marked } from "marked";
import { buildChartNodeState, destroyChartsInElement, renderChartCell } from "./charts.js";
import {
  buildHTTPNodeState,
  buildJavascriptNodeState,
  isAutoHTTPNode,
  resolveJSONNodeText
} from "./runtime-state.js";
import { buildTemplateContext, resolveTemplateStringLenient } from "./templates.js";
import { buildSelectOptionEntries } from "./selects.js";
import { getHTTPExpansionKey, getSecretBinding, getVariableValue, setSecretBinding, setVariableValue } from "./variables.js";
import { sanitizeClassName } from "./utils.js";

export function renderDocumentFlow(nodes, state, callbacks) {
  const section = document.createElement("main");
  section.className = "document-flow";
  const documentNodes = Array.isArray(nodes) ? nodes : [];
  const documentError = state && state.parsedDocument ? state.parsedDocument.error : "";

  if (documentError) {
    section.appendChild(renderNodeRenderError(null, documentError, "Document parse failed"));
  }

  if (!documentNodes.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = documentError
      ? "No workbook nodes could be rendered from the current document."
      : "No workbook nodes were parsed from the current document.";
    section.appendChild(empty);
    return section;
  }

  documentNodes.forEach((node) => {
    try {
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

      section.appendChild(renderDocumentNode(node, state, callbacks));
    } catch (error) {
      console.error("RunDown node render failed", node, error);
      section.appendChild(renderNodeRenderError(node, error, "Node render failed"));
    }
  });
  return section;
}

export function shouldRenderAutoHTTPCell(httpState, state) {
  return state.showHiddenRuntimeCells || httpState.bloomState === "failure";
}

export function shouldRenderJavascriptCell(javascriptState, state) {
  return state.showHiddenRuntimeCells || javascriptState.bloomState === "failure";
}

export function renderDocumentNode(node, state, callbacks) {
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

  const detail = renderNodeDetail(node, state, callbacks, httpState, javascriptState);
  if (detail) {
    article.appendChild(detail);
  }

  return article;
}

export function renderRuntimePill(node, httpState) {
  if (node.cellType !== "http" || !node.name || !httpState) {
    return null;
  }

  const pill = document.createElement("span");
  pill.className = `state state-${httpState.bloomState}`;
  pill.textContent = httpState.statusText;
  return pill;
}

export function renderNodeDetail(node, state, callbacks, precomputedHTTPState = null, precomputedJavascriptState = null) {
  if (node.cellType === "http") {
    return renderHTTPCell(node, precomputedHTTPState || buildHTTPNodeState(node, state), state, callbacks);
  }

  if (node.cellType === "variables") {
    return renderVariablesEditor(node, state, callbacks);
  }

  if (node.cellType === "json") {
    return renderJSONCodeBlock(resolveJSONNodeText(node, state));
  }

  if (node.cellType === "javascript") {
    return renderJavascriptCell(node, precomputedJavascriptState || buildJavascriptNodeState(node, state), state);
  }

  if (node.cellType === "chart") {
    return renderChartCell(node, buildChartNodeState(node, state));
  }

  return renderCodeBlock(node.source || "");
}

export function renderHTTPCell(node, httpState, state, callbacks) {
  const wrap = document.createElement("div");
  wrap.className = "http-cell";

  const row = document.createElement("div");
  row.className = "http-row";

  const button = document.createElement("button");
  button.className = "http-run-button";
  button.textContent = httpState.snapshot.method || "GET";
  button.disabled = state.inflightRequests.has(node.name) || Boolean(httpState.templateError);
  button.addEventListener("click", () => {
    callbacks.runHTTPCell(node);
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
      callbacks.renderApp();
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

export function renderJavascriptCell(node, javascriptState, state) {
  const wrap = document.createElement("div");
  wrap.className = "javascript-cell";

  if (javascriptState.outputText) {
    wrap.appendChild(renderRuntimeSection(javascriptState.outputLabel, javascriptState.outputText, javascriptState.bloomState));
  } else if (state.showHiddenRuntimeCells) {
    wrap.appendChild(renderRuntimeSection("Status", javascriptState.statusText, javascriptState.bloomState));
  }

  return wrap;
}

export function renderVariablesEditor(node, state, callbacks) {
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
      row.appendChild(renderSecretBindingSelect(node.name, entry, state, node.nodeIndex, callbacks));
      editor.appendChild(row);
      return;
    }

    row.appendChild(renderVariableControl(node.name, entry, state, node.nodeIndex, callbacks));

    editor.appendChild(row);
  });

  return editor;
}

function renderVariableControl(namespaceName, entry, state, nodeIndex, callbacks) {
  if (entry.valueType === "boolean") {
    return renderBooleanVariableInput(namespaceName, entry, state, nodeIndex, callbacks);
  }

  if (entry.valueType === "number") {
    return renderNumberVariableInput(namespaceName, entry, state, nodeIndex, callbacks);
  }

  if (entry.valueType === "control" && entry.control && entry.control.type === "select") {
    return renderSelectVariableInput(namespaceName, entry, state, nodeIndex, callbacks);
  }

  return renderTextVariableInput(namespaceName, entry, state, nodeIndex, callbacks);
}

function renderTextVariableInput(namespaceName, entry, state, nodeIndex, callbacks) {
  const input = document.createElement("input");
  input.className = "variable-input";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  identifyVariableControl(input, namespaceName, entry, "text");
  input.value = getVariableValue(state.runtimeState, namespaceName, entry.key, entry.value, entry);
  input.placeholder = entry.value || "";
  input.addEventListener("input", () => {
    commitVariableValue(state, namespaceName, entry, input.value, nodeIndex, callbacks);
  });
  input.addEventListener("change", () => {
    callbacks.persistRuntimeStateToHost();
  });
  return input;
}

function renderNumberVariableInput(namespaceName, entry, state, nodeIndex, callbacks) {
  const input = document.createElement("input");
  input.className = "variable-input";
  input.type = "number";
  input.autocomplete = "off";
  input.spellcheck = false;
  identifyVariableControl(input, namespaceName, entry, "number");
  input.value = String(getVariableValue(state.runtimeState, namespaceName, entry.key, entry.value, entry));
  input.placeholder = String(entry.value ?? "");
  input.addEventListener("input", () => {
    const nextValue = input.value === "" ? "" : Number(input.value);
    commitVariableValue(state, namespaceName, entry, Number.isFinite(nextValue) || nextValue === "" ? nextValue : entry.value, nodeIndex, callbacks);
  });
  input.addEventListener("change", () => {
    callbacks.persistRuntimeStateToHost();
  });
  return input;
}

function renderBooleanVariableInput(namespaceName, entry, state, nodeIndex, callbacks) {
  const input = document.createElement("input");
  input.className = "variable-checkbox";
  input.type = "checkbox";
  identifyVariableControl(input, namespaceName, entry, "boolean");
  input.checked = Boolean(getVariableValue(state.runtimeState, namespaceName, entry.key, entry.value, entry));
  input.addEventListener("change", () => {
    commitVariableValue(state, namespaceName, entry, input.checked, nodeIndex, callbacks);
  });
  return input;
}

function renderSelectVariableInput(namespaceName, entry, state, nodeIndex, callbacks) {
  const select = document.createElement("select");
  select.className = "variable-input";
  identifyVariableControl(select, namespaceName, entry, "select");
  const optionState = buildSelectOptionEntries(entry, state.parsedDocument.nodes, state.runtimeState);
  const options = optionState.entries;
  const currentValue = getVariableValue(state.runtimeState, namespaceName, entry.key, entry.value, entry);
  let selectedIndex = options.findIndex((option) => Object.is(option.value, currentValue));
  if (selectedIndex === -1) {
    selectedIndex = options.findIndex((option) => String(option.value) === String(currentValue));
  }

  const optionValues = [...options];
  if (selectedIndex === -1 && currentValue !== "") {
    selectedIndex = optionValues.length;
    optionValues.push({
      label: String(currentValue),
      value: currentValue,
      isMissing: true
    });
  }

  if (!optionValues.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = optionState.error || (optionState.isDataBound ? "No options available" : "No options");
    select.appendChild(option);
    select.value = "";
    select.disabled = true;
    if (optionState.error) {
      select.title = optionState.error;
    }
    return select;
  }

  optionValues.forEach((optionValue, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = optionValue.label;
    if (optionValue.isMissing) {
      option.textContent = `${option.textContent} (missing)`;
    }
    select.appendChild(option);
  });

  if (optionState.error) {
    select.title = optionState.error;
  }
  select.disabled = Boolean(optionState.error) || options.length === 0;
  select.value = selectedIndex === -1 ? "" : String(selectedIndex);
  select.addEventListener("change", () => {
    const index = Number.parseInt(select.value, 10);
    const nextValue = index >= 0 && index < optionValues.length ? optionValues[index].value : entry.value;
    commitVariableValue(state, namespaceName, entry, nextValue, nodeIndex, callbacks);
  });
  return select;
}

function commitVariableValue(state, namespaceName, entry, value, nodeIndex, callbacks) {
  setVariableValue(state.runtimeState, namespaceName, entry.key, value, entry.value);
  callbacks.persistRuntimeStateToHost();
  callbacks.refreshTemplateDrivenNodes();
  callbacks.scheduleAutoHTTPExecutionFromIndex(nodeIndex + 1);
}

export function renderSecretBindingSelect(namespaceName, entry, state, nodeIndex, callbacks) {
  const select = document.createElement("select");
  select.className = "variable-input variable-secret-select";
  identifyVariableControl(select, namespaceName, entry, "secret");
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
    callbacks.refreshSecretNamesFromHost();
  });
  select.addEventListener("change", () => {
    setSecretBinding(state.runtimeState, namespaceName, entry.key, select.value);
    callbacks.persistRuntimeStateToHost();
    callbacks.refreshTemplateDrivenNodes();
    callbacks.scheduleAutoHTTPExecutionFromIndex(nodeIndex + 1);
  });
  return select;
}

function identifyVariableControl(control, namespaceName, entry, controlType) {
  control.dataset.variableNamespace = namespaceName;
  control.dataset.variableKey = entry.key;
  control.dataset.variableControl = controlType;
}

export function refreshTemplateDrivenNodes(appState, app, callbacks) {
  let needsFullRender = false;
  const documentNodes = Array.isArray(appState.parsedDocument.nodes) ? appState.parsedDocument.nodes : [];

  documentNodes.forEach((node) => {
    try {
      if (node.kind !== "markdown" && (node.kind !== "cell" || (node.cellType !== "http" && node.cellType !== "json" && node.cellType !== "javascript" && node.cellType !== "chart"))) {
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
        destroyChartsInElement(article);
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
        destroyChartsInElement(article);
        article.replaceChildren(renderHTTPCell(node, httpState, appState, callbacks));
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
        destroyChartsInElement(article);
        article.replaceChildren(renderJavascriptCell(node, javascriptState, appState));
        return;
      }

      destroyChartsInElement(article);
      if (node.cellType === "chart") {
        article.replaceChildren(renderChartCell(node, buildChartNodeState(node, appState)));
        return;
      }

      article.replaceChildren(renderJSONCodeBlock(resolveJSONNodeText(node, appState)));
    } catch (error) {
      console.error("RunDown node refresh failed", node, error);
      const article = app ? app.querySelector(`[data-node-index="${node.nodeIndex}"]`) : null;
      if (article) {
        destroyChartsInElement(article);
        article.replaceWith(renderNodeRenderError(node, error, "Node refresh failed"));
      } else {
        needsFullRender = true;
      }
    }
  });

  if (needsFullRender) {
    callbacks.renderApp();
  }
}

export function renderRuntimeSection(label, text, tone = "idle") {
  const wrap = document.createElement("div");
  wrap.className = "runtime-section";

  const title = document.createElement("p");
  title.className = `runtime-title runtime-title-${tone}`;
  title.textContent = label;
  wrap.appendChild(title);
  wrap.appendChild(renderCodeBlock(text));
  return wrap;
}

export function renderCodeBlock(text) {
  const pre = document.createElement("pre");
  pre.className = "code-block";
  pre.textContent = text;
  return pre;
}

export function renderJSONCodeBlock(text) {
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

export function appendHighlightedJSON(parent, source) {
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

export function getJSONTokenClass(token, trailingSource = "") {
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

function renderNodeRenderError(node, error, titleText) {
  const article = document.createElement(node && node.kind === "markdown" ? "section" : "article");
  article.className = "document-node render-error";
  if (node && Number.isFinite(node.nodeIndex)) {
    article.dataset.nodeIndex = String(node.nodeIndex);
  }

  const title = document.createElement("p");
  title.className = "render-error-title";
  title.textContent = titleText || "Render failed";
  article.appendChild(title);

  if (node) {
    const meta = document.createElement("p");
    meta.className = "render-error-meta";
    meta.textContent = describeNode(node);
    article.appendChild(meta);
  }

  const detail = document.createElement("pre");
  detail.className = "render-error-detail";
  detail.textContent = formatErrorForDisplay(error);
  article.appendChild(detail);

  if (node && node.source) {
    const source = document.createElement("details");
    source.className = "render-error-source";
    const summary = document.createElement("summary");
    summary.textContent = "Source";
    source.appendChild(summary);
    source.appendChild(renderCodeBlock(node.source));
    article.appendChild(source);
  }

  return article;
}

function describeNode(node) {
  const type = node.cellType || node.kind || "node";
  const name = node.name ? ` "${node.name}"` : "";
  return `${type}${name} at index ${node.nodeIndex}`;
}

function formatErrorForDisplay(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}
