import { JSONPath } from "jsonpath-plus";

import { resolveDottedFieldPath } from "./field-paths.js";
import { buildWorkbookOutputRoot } from "./workbook-output.js";

export function buildSelectOptionEntries(entry, nodes, runtimeState) {
  const control = entry && entry.control ? entry.control : null;
  if (!control || control.type !== "select") {
    return {
      entries: [],
      error: "",
      isDataBound: false
    };
  }

  if (Array.isArray(control.options)) {
    return {
      entries: control.options.map((value) => ({
        label: value == null ? "" : String(value),
        value
      })),
      error: "",
      isDataBound: false
    };
  }

  if (!control.optionsPath) {
    return {
      entries: [],
      error: "",
      isDataBound: false
    };
  }

  try {
    const root = buildWorkbookOutputRoot(nodes || [], runtimeState || {});
    const matches = JSONPath({
      path: control.optionsPath,
      json: root,
      wrap: true,
      eval: false
    });

    return {
      entries: matches.map((match) => buildBoundSelectOptionEntry(match, control)).filter(Boolean),
      error: "",
      isDataBound: true
    };
  } catch (error) {
    return {
      entries: [],
      error: `Invalid options JSONPath: ${error instanceof Error ? error.message : String(error)}`,
      isDataBound: true
    };
  }
}

function buildBoundSelectOptionEntry(match, control) {
  const value = control.valuePath ? resolveDottedFieldPath(match, control.valuePath) : match;
  if (!isSelectOptionValue(value)) {
    return null;
  }

  const labelValue = control.labelPath ? resolveDottedFieldPath(match, control.labelPath) : value;
  return {
    label: labelValue == null ? "" : String(labelValue),
    value
  };
}

function isSelectOptionValue(value) {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
