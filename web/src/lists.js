import { JSONPath } from "jsonpath-plus";

import { resolveDottedFieldPath } from "./field-paths.js";
import { buildWorkbookOutputRoot } from "./workbook-output.js";

const SUPPORTED_LIST_VIEWS = new Set(["table", "cards"]);

export function buildListNodeState(node, state) {
  const spec = node && node.list ? node.list : {};
  const view = String(spec.view || "table").trim().toLowerCase() || "table";
  const itemsPath = String(spec.items || "").trim();
  const fields = normalizeListFields(spec.fields);
  const titlePath = String(spec.title || "").trim();
  const subtitlePath = String(spec.subtitle || "").trim();

  if (!SUPPORTED_LIST_VIEWS.has(view)) {
    return buildListError(`Unsupported list view: ${view}. Use table or cards.`);
  }

  if (!itemsPath) {
    return buildListError("List items path is required.");
  }

  if (view === "table" && !fields.length) {
    return buildListError("Table lists require at least one field.");
  }

  if (view === "cards" && !titlePath) {
    return buildListError("Card lists require a title path.");
  }

  const root = buildWorkbookOutputRoot(state.parsedDocument.nodes, state.runtimeState);
  const itemsResult = resolveListItems(itemsPath, root);
  if (itemsResult.error) {
    return buildListError(itemsResult.error);
  }

  if (!itemsResult.items.length) {
    return {
      status: "empty",
      view,
      fields,
      itemsPath,
      titlePath,
      subtitlePath,
      items: []
    };
  }

  const invalidItemIndex = itemsResult.items.findIndex((item) => !isListItem(item));
  if (invalidItemIndex !== -1) {
    return buildListError(`List item at index ${invalidItemIndex} is not an object.`);
  }

  return {
    status: "success",
    view,
    fields,
    itemsPath,
    titlePath,
    subtitlePath,
    items: itemsResult.items.map((item) => ({
      source: item,
      title: titlePath ? formatListValue(resolveDottedFieldPath(item, titlePath)) : "",
      subtitle: subtitlePath ? formatListValue(resolveDottedFieldPath(item, subtitlePath)) : "",
      values: fields.map((field) => ({
        ...field,
        value: formatListValue(resolveDottedFieldPath(item, field.path))
      }))
    }))
  };
}

export function renderListCell(node, listState) {
  const wrap = document.createElement("div");
  wrap.className = "list-cell";

  if (!listState || listState.status === "failure") {
    wrap.appendChild(renderListMessage(
      "list-error",
      listState && listState.error ? listState.error : "List could not be rendered."
    ));
    return wrap;
  }

  if (listState.status === "empty") {
    wrap.appendChild(renderListMessage("list-empty", "No items matched this list."));
    return wrap;
  }

  if (listState.view === "cards") {
    wrap.appendChild(renderCardList(listState));
    return wrap;
  }

  wrap.appendChild(renderTableList(listState));
  return wrap;
}

function normalizeListFields(fields) {
  return Array.isArray(fields)
    ? fields
      .map((field) => ({
        label: String(field && field.label ? field.label : "").trim(),
        path: String(field && field.path ? field.path : "").trim()
      }))
      .filter((field) => field.label && field.path)
    : [];
}

function resolveListItems(path, root) {
  try {
    return {
      items: JSONPath({
        path,
        json: root,
        wrap: true,
        eval: false
      }),
      error: ""
    };
  } catch (error) {
    return {
      items: [],
      error: `Invalid items JSONPath: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

function isListItem(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function formatListValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildListError(error) {
  return {
    status: "failure",
    error
  };
}

function renderTableList(listState) {
  const scrollWrap = document.createElement("div");
  scrollWrap.className = "list-table-wrap";

  const table = document.createElement("table");
  table.className = "list-table";

  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  listState.fields.forEach((field) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = field.label;
    headRow.appendChild(cell);
  });
  head.appendChild(headRow);
  table.appendChild(head);

  const body = document.createElement("tbody");
  listState.items.forEach((item) => {
    const row = document.createElement("tr");
    item.values.forEach((entry) => {
      const cell = document.createElement("td");
      cell.textContent = entry.value;
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  table.appendChild(body);

  scrollWrap.appendChild(table);
  return scrollWrap;
}

function renderCardList(listState) {
  const grid = document.createElement("div");
  grid.className = "list-card-grid";

  listState.items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "list-card";

    const title = document.createElement("h3");
    title.className = "list-card-title";
    title.textContent = item.title;
    card.appendChild(title);

    if (item.subtitle) {
      const subtitle = document.createElement("p");
      subtitle.className = "list-card-subtitle";
      subtitle.textContent = item.subtitle;
      card.appendChild(subtitle);
    }

    if (item.values.length) {
      const details = document.createElement("dl");
      details.className = "list-card-details";
      item.values.forEach((entry) => {
        const term = document.createElement("dt");
        term.textContent = entry.label;
        details.appendChild(term);

        const description = document.createElement("dd");
        description.textContent = entry.value;
        details.appendChild(description);
      });
      card.appendChild(details);
    }

    grid.appendChild(card);
  });

  return grid;
}

function renderListMessage(className, text) {
  const message = document.createElement("div");
  message.className = className;
  message.textContent = text;
  return message;
}
