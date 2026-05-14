
export function getHTTPExpansionKey(node) {
  return node.name || `http-${node.nodeIndex}`;
}

export function getVariableValue(runtimeState, namespaceName, key, fallbackValue, entry = null) {
  const namespaceValues = runtimeState.variables && runtimeState.variables[namespaceName] ? runtimeState.variables[namespaceName] : null;
  if (namespaceValues && Object.prototype.hasOwnProperty.call(namespaceValues, key)) {
    return coerceVariableValueForEntry(entry, namespaceValues[key]);
  }

  return coerceVariableValueForEntry(entry, fallbackValue);
}

export function setVariableValue(runtimeState, namespaceName, key, value, defaultValue) {
  if (!namespaceName || !key) {
    return;
  }

  if (!runtimeState.variables) {
    runtimeState.variables = {};
  }

  const nextValue = normalizePersistedVariableValue(value);
  const fallbackValue = normalizePersistedVariableValue(defaultValue);
  const namespaceValues = runtimeState.variables[namespaceName] ? { ...runtimeState.variables[namespaceName] } : {};

  if (variableValuesEqual(nextValue, fallbackValue)) {
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

export function coerceVariableValueForEntry(entry, value) {
  if (!entry) {
    return value ?? "";
  }

  if (entry.valueType === "number") {
    if (value === "") {
      return "";
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue)) {
        return numberValue;
      }
    }
    return entry.value;
  }

  if (entry.valueType === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      if (value === "true") {
        return true;
      }
      if (value === "false") {
        return false;
      }
    }
    return entry.value;
  }

  if (entry.valueType === "control" && entry.control && entry.control.type === "select") {
    return normalizeSelectValue(entry, value);
  }

  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function normalizeSelectValue(entry, value) {
  const options = Array.isArray(entry.control && entry.control.options) ? entry.control.options : [];
  const exactMatch = options.find((option) => Object.is(option, value));
  if (exactMatch !== undefined) {
    return exactMatch;
  }

  const stringMatch = options.find((option) => String(option) === String(value));
  if (stringMatch !== undefined) {
    return stringMatch;
  }

  if (value != null) {
    return value;
  }
  if (entry.value != null) {
    return entry.value;
  }
  return options.length ? options[0] : "";
}

function normalizePersistedVariableValue(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : "";
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  return String(value);
}

function variableValuesEqual(left, right) {
  return Object.is(left, right);
}

export function getSecretBinding(runtimeState, namespaceName, key) {
  const namespaceBindings = runtimeState.secretBindings && runtimeState.secretBindings[namespaceName] ? runtimeState.secretBindings[namespaceName] : null;
  if (namespaceBindings && Object.prototype.hasOwnProperty.call(namespaceBindings, key)) {
    return namespaceBindings[key];
  }

  return "";
}

export function setSecretBinding(runtimeState, namespaceName, key, secretName) {
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
