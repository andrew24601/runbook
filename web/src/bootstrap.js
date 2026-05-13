
export const DEFAULT_BOOTSTRAP = {
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
};;

export function getBootstrap() {
  return window.__RUNDOWN_BOOTSTRAP__ || DEFAULT_BOOTSTRAP;
}

export function normalizeRuntimeState(state) {
    return {
      variableNamespaceCount: state && typeof state.variableNamespaceCount === "number" ? state.variableNamespaceCount : 0,
      httpEntryCount: state && typeof state.httpEntryCount === "number" ? state.httpEntryCount : 0,
      variables: state && state.variables ? state.variables : {},
      secretBindings: state && state.secretBindings ? state.secretBindings : {},
      http: state && state.http ? state.http : {},
      javascript: state && state.javascript ? state.javascript : {}
    };
}
