
import { getBootstrap, normalizeRuntimeState } from "./bootstrap.js";
import { destroyChartsInElement } from "./charts.js";
import { createExecutionController } from "./execution.js";
import { parseWorkbookDocument } from "./parser.js";
import { persistRuntimeStateToHost as persistRuntimeState } from "./persistence.js";
import { refreshTemplateDrivenNodes as refreshRenderedTemplateNodes, renderDocumentFlow } from "./rendering.js";

const bootstrap = getBootstrap();

const appState = {
  runtimeState: normalizeRuntimeState(bootstrap.runtimeState),
  parsedDocument: parseDocumentSourceSafely(bootstrap.document && bootstrap.document.source ? bootstrap.document.source : ""),
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

const app = document.getElementById("app");
const callbacks = {};
const execution = createExecutionController(appState, callbacks);

Object.assign(callbacks, {
  renderApp,
  refreshSecretNamesFromHost,
  persistRuntimeStateToHost,
  refreshTemplateDrivenNodes,
  scheduleAutoHTTPExecutionFromIndex: execution.scheduleAutoHTTPExecutionFromIndex,
  scheduleJavascriptExecutionFromIndex: execution.scheduleJavascriptExecutionFromIndex,
  runHTTPCell: execution.runHTTPCell,
  runJavascriptCell: execution.runJavascriptCell
});

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
  },
  reloadDocumentSource(source) {
    const nextSource = typeof source === "string" ? source : "";
    if (!bootstrap.document) {
      bootstrap.document = { sourceLabel: "", source: "" };
    }
    bootstrap.document.source = nextSource;
    appState.parsedDocument = parseDocumentSourceSafely(nextSource);
    appState.pendingHTTPStartIndex = Infinity;
    appState.pendingJavascriptStartIndex = Infinity;
    renderApp();
    execution.scheduleAutoHTTPExecutionFromIndex(0, { delayMs: 0 });
    execution.scheduleJavascriptExecutionFromIndex(0);
    return true;
  }
};

if (app) {
  renderApp();
  refreshSecretNamesFromHost();
  execution.scheduleAutoHTTPExecutionFromIndex(0, { delayMs: 0 });
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

  const focusSnapshot = captureVariableControlFocus(app);
  try {
    const nextRender = renderDocumentFlow(appState.parsedDocument.nodes, appState, callbacks);
    destroyChartsInElement(app);
    app.replaceChildren(nextRender);
    restoreVariableControlFocus(app, focusSnapshot);
  } catch (error) {
    console.error("RunDown render failed", error);
    destroyChartsInElement(app);
    app.replaceChildren(renderApplicationError(error));
  }
}

function persistRuntimeStateToHost() {
  persistRuntimeState(bootstrap, appState);
}

function refreshTemplateDrivenNodes() {
  refreshRenderedTemplateNodes(appState, app, callbacks);
}

function captureVariableControlFocus(appElement) {
  const activeElement = document.activeElement;
  if (!activeElement || !appElement.contains(activeElement) || !activeElement.dataset) {
    return null;
  }

  const { variableNamespace, variableKey, variableControl } = activeElement.dataset;
  if (!variableNamespace || !variableKey || !variableControl) {
    return null;
  }

  const snapshot = {
    variableNamespace,
    variableKey,
    variableControl,
    selectionStart: null,
    selectionEnd: null,
    selectionDirection: "none"
  };

  if (canRestoreTextSelection(activeElement)) {
    snapshot.selectionStart = activeElement.selectionStart;
    snapshot.selectionEnd = activeElement.selectionEnd;
    snapshot.selectionDirection = activeElement.selectionDirection || "none";
  }

  return snapshot;
}

function restoreVariableControlFocus(appElement, snapshot) {
  if (!snapshot) {
    return;
  }

  const control = Array.from(appElement.querySelectorAll("[data-variable-namespace][data-variable-key][data-variable-control]")).find((candidate) => (
    candidate.dataset.variableNamespace === snapshot.variableNamespace &&
    candidate.dataset.variableKey === snapshot.variableKey &&
    candidate.dataset.variableControl === snapshot.variableControl
  ));
  if (!control) {
    return;
  }

  try {
    control.focus({ preventScroll: true });
  } catch {
    control.focus();
  }

  if (snapshot.selectionStart === null || !canRestoreTextSelection(control)) {
    return;
  }

  const valueLength = control.value.length;
  const selectionStart = Math.min(snapshot.selectionStart, valueLength);
  const selectionEnd = Math.min(snapshot.selectionEnd ?? selectionStart, valueLength);
  control.setSelectionRange(selectionStart, selectionEnd, snapshot.selectionDirection);
}

function canRestoreTextSelection(element) {
  return element instanceof HTMLInputElement && element.type === "text";
}

function parseDocumentSourceSafely(source) {
  try {
    return parseWorkbookDocument(source);
  } catch (error) {
    console.error("RunDown document parse failed", error);
    return {
      nodes: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function renderApplicationError(error) {
  const wrap = document.createElement("main");
  wrap.className = "document-flow";

  const article = document.createElement("article");
  article.className = "document-node render-error";

  const title = document.createElement("p");
  title.className = "render-error-title";
  title.textContent = "RunDown could not render this workbook.";
  article.appendChild(title);

  const detail = document.createElement("pre");
  detail.className = "render-error-detail";
  detail.textContent = formatErrorForDisplay(error);
  article.appendChild(detail);

  wrap.appendChild(article);
  return wrap;
}

function formatErrorForDisplay(error) {
  if (error instanceof Error) {
    return error.stack || error.message;
  }
  return String(error);
}
