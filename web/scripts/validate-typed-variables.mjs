import assert from "node:assert/strict";
import { parseVariableEntries } from "../src/parser.js";
import { buildVariablesOutput } from "../src/runtime-state.js";
import { buildTemplateContext, resolveTemplateStringStrict } from "../src/templates.js";
import { setVariableValue } from "../src/variables.js";

const entries = parseVariableEntries(`base_url = "https://jsonplaceholder.typicode.com"
user = "1"
limit = 20
include_archived = false
status = {
  "type": "select",
  "options": ["all", "success", "failed"]
}
api_key = <secret>
next_value = "done"`);

const byKey = Object.fromEntries(entries.map((entry) => [entry.key, entry]));

assert.equal(byKey.limit.valueType, "number");
assert.equal(byKey.limit.value, 20);

assert.equal(byKey.include_archived.valueType, "boolean");
assert.equal(byKey.include_archived.value, false);

assert.equal(byKey.user.valueType, "string");
assert.equal(byKey.user.value, "1");

assert.equal(byKey.status.valueType, "control");
assert.equal(byKey.status.control.type, "select");
assert.deepEqual(byKey.status.control.options, ["all", "success", "failed"]);
assert.equal(byKey.status.value, "all");

assert.equal(byKey.api_key.valueType, "secret");
assert.equal(byKey.api_key.isSecretSlot, true);

assert.equal(byKey.next_value.valueType, "string");
assert.equal(byKey.next_value.value, "done");

const variableNode = {
  kind: "cell",
  cellType: "variables",
  name: "filters",
  nodeIndex: 0,
  variables: entries
};
const runtimeState = {
  variables: {
    filters: {
      limit: "30",
      include_archived: "true",
      status: "failed"
    }
  },
  secretBindings: {},
  http: {},
  javascript: {}
};

assert.deepEqual(buildVariablesOutput(variableNode, runtimeState), {
  base_url: "https://jsonplaceholder.typicode.com",
  user: "1",
  limit: 30,
  include_archived: true,
  status: "failed",
  api_key: "",
  next_value: "done"
});

const context = buildTemplateContext([variableNode], runtimeState);
assert.equal(context.variablesByNamespace.filters.limit, 30);
assert.equal(context.variablesByNamespace.filters.include_archived, true);
assert.equal(resolveTemplateStringStrict("{{filters.limit}}/{{filters.include_archived}}", context), "30/true");

setVariableValue(runtimeState, "filters", "limit", 20, 20);
assert.equal(Object.prototype.hasOwnProperty.call(runtimeState.variables.filters, "limit"), false);

setVariableValue(runtimeState, "filters", "include_archived", true, false);
assert.equal(runtimeState.variables.filters.include_archived, true);

console.log("typed variable validation passed");
