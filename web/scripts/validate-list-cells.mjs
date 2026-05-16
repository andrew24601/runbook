import assert from "node:assert/strict";

import { buildListNodeState, renderListCell } from "../src/lists.js";
import { parseWorkbookDocument } from "../src/parser.js";

const parsedDocument = parseWorkbookDocument(`\`\`\`list
view = table
items = $.runs.body.items[*]
field = Run ID | id
field = Owner | metadata.owner.name
\`\`\`

\`\`\`list
view = cards
items = $.summaries.items[*]
title = name
subtitle = status
field = Count | metrics.count
\`\`\``);

const listNodes = parsedDocument.nodes.filter((node) => node.kind === "cell" && node.cellType === "list");
const tableNode = listNodes[0];
const cardNode = listNodes[1];
assert.equal(tableNode.cellType, "list");
assert.deepEqual(tableNode.list, {
  view: "table",
  items: "$.runs.body.items[*]",
  title: "",
  subtitle: "",
  fields: [
    { label: "Run ID", path: "id" },
    { label: "Owner", path: "metadata.owner.name" }
  ]
});
assert.deepEqual(cardNode.list, {
  view: "cards",
  items: "$.summaries.items[*]",
  title: "name",
  subtitle: "status",
  fields: [
    { label: "Count", path: "metrics.count" }
  ]
});

const state = {
  parsedDocument: {
    nodes: [{
      kind: "cell",
      cellType: "variables",
      name: "filters",
      nodeIndex: 0,
      variables: []
    }]
  },
  runtimeState: {
    variables: {},
    secretBindings: {},
    http: {
      runs: {
        responseBody: JSON.stringify({
          items: [
            { id: "run_1", metadata: { owner: { name: "Ari" } } },
            { id: "run_2", metadata: { owner: { name: "Bea" } } }
          ]
        })
      }
    },
    javascript: {
      summaries: {
        status: "success",
        output: {
          items: [
            { name: "Morning", status: "ready", metrics: { count: 3 } },
            { name: "Evening", status: "queued", metrics: { count: 5 } }
          ]
        }
      }
    }
  }
};

const tableState = buildListNodeState(tableNode, state);
assert.equal(tableState.status, "success");
assert.equal(tableState.view, "table");
assert.deepEqual(tableState.items.map((item) => item.values.map((entry) => entry.value)), [
  ["run_1", "Ari"],
  ["run_2", "Bea"]
]);

const cardState = buildListNodeState(cardNode, state);
assert.equal(cardState.status, "success");
assert.deepEqual(cardState.items.map((item) => [item.title, item.subtitle, item.values[0].value]), [
  ["Morning", "ready", "3"],
  ["Evening", "queued", "5"]
]);

const variableBackedListNode = {
  kind: "cell",
  cellType: "list",
  list: {
    view: "table",
    items: "$.filters.items[*]",
    title: "",
    subtitle: "",
    fields: [{ label: "Label", path: "label" }]
  }
};
state.runtimeState.variables.filters = {
  items: [{ label: "first" }]
};
assert.deepEqual(
  buildListNodeState(variableBackedListNode, state).items.map((item) => item.values[0].value),
  ["first"]
);
state.runtimeState.variables.filters.items = [{ label: "second" }];
assert.deepEqual(
  buildListNodeState(variableBackedListNode, state).items.map((item) => item.values[0].value),
  ["second"]
);

assert.equal(buildListNodeState({
  list: { view: "table", items: "$[?(", fields: [{ label: "ID", path: "id" }] }
}, state).status, "failure");
assert.equal(buildListNodeState({
  list: { view: "grid", items: "$.runs.body.items[*]", fields: [{ label: "ID", path: "id" }] }
}, state).error, "Unsupported list view: grid. Use table or cards.");
assert.equal(buildListNodeState({
  list: { view: "table", items: "$.runs.body.items[*]", fields: [] }
}, state).error, "Table lists require at least one field.");
assert.equal(buildListNodeState({
  list: { view: "cards", items: "$.runs.body.items[*]", title: "", fields: [] }
}, state).error, "Card lists require a title path.");
assert.equal(buildListNodeState({
  list: { view: "table", items: "$.filters.items[*]", fields: [{ label: "Label", path: "label" }] }
}, {
  ...state,
  runtimeState: {
    ...state.runtimeState,
    variables: {
      filters: {
        items: []
      }
    }
  }
}).status, "empty");
assert.equal(buildListNodeState({
  list: { view: "table", items: "$.filters.items[*]", fields: [{ label: "Label", path: "label" }] }
}, {
  ...state,
  runtimeState: {
    ...state.runtimeState,
    variables: {
      filters: {
        items: ["not-an-object"]
      }
    }
  }
}).error, "List item at index 0 is not an object.");

function installFakeDocument() {
  globalThis.document = {
    createElement(tagName) {
      return new FakeElement(tagName);
    }
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.className = "";
    this.scope = "";
    this.textContent = "";
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

installFakeDocument();
const renderedTable = renderListCell(tableNode, tableState);
assert.equal(renderedTable.className, "list-cell");
assert.equal(renderedTable.children[0].children[0].children[0].children[0].children[0].textContent, "Run ID");
assert.equal(renderedTable.children[0].children[0].children[1].children[0].children[1].textContent, "Ari");

const renderedCards = renderListCell(cardNode, cardState);
assert.equal(renderedCards.children[0].children[0].children[0].textContent, "Morning");
assert.equal(renderedCards.children[0].children[0].children[1].textContent, "ready");
assert.equal(renderedCards.children[0].children[0].children[2].children[1].textContent, "3");

console.log("list cell validation passed");
