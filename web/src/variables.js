
export function getHTTPExpansionKey(node) {
  return node.name || `http-${node.nodeIndex}`;
}

export function getVariableValue(runtimeState, namespaceName, key, fallbackValue) {
  const namespaceValues = runtimeState.variables && runtimeState.variables[namespaceName] ? runtimeState.variables[namespaceName] : null;
  if (namespaceValues && Object.prototype.hasOwnProperty.call(namespaceValues, key)) {
    return namespaceValues[key];
  }

  return fallbackValue || "";
}

export function setVariableValue(runtimeState, namespaceName, key, value, defaultValue) {
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
