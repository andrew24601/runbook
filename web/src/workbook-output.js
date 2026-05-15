import { buildTemplateContext } from "./templates.js";

export function buildWorkbookOutputRoot(nodes, runtimeState) {
  const context = buildTemplateContext(nodes || [], runtimeState || {});
  const root = {};

  Object.entries(context.variablesByNamespace || {}).forEach(([name, value]) => {
    root[name] = value;
  });

  Object.entries(context.httpEntriesByCell || {}).forEach(([name, value]) => {
    if (!Object.prototype.hasOwnProperty.call(root, name)) {
      root[name] = value;
    }
  });

  Object.entries(context.javascriptEntriesByCell || {}).forEach(([name, value]) => {
    if (!Object.prototype.hasOwnProperty.call(root, name)) {
      root[name] = value;
    }
  });

  return root;
}
