
import { getBootstrap, normalizeRuntimeState } from "./bootstrap.js";
import { createExecutionController } from "./execution.js";
import { parseWorkbookDocument } from "./parser.js";
import { persistRuntimeStateToHost as persistRuntimeState } from "./persistence.js";
import { refreshTemplateDrivenNodes as refreshRenderedTemplateNodes, renderDocumentFlow } from "./rendering.js";

const bootstrap = getBootstrap();

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

  app.innerHTML = "";
  app.appendChild(renderDocumentFlow(appState.parsedDocument.nodes, appState, callbacks));
}

function persistRuntimeStateToHost() {
  persistRuntimeState(bootstrap, appState);
}

function refreshTemplateDrivenNodes() {
  refreshRenderedTemplateNodes(appState, app, callbacks);
}
