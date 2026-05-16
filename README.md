# RunBook

RunBook is a native macOS workbook app for API exploration and lightweight automation. It treats Markdown files as runnable notebooks: prose explains the workflow, fenced cells define variables, HTTP requests, and JavaScript transforms, and the app keeps execution output in a separate runtime cache so the workbook itself stays clean and committable.

The current app bundle and binary are still named `RunDown` in the build output.

## What It Does

- Opens Markdown workbooks in a native macOS window.
- Live reloads open workbook windows when their Markdown files change on disk.
- Renders ordinary Markdown alongside runnable workbook cells.
- Supports shared variable cells with typed text, number, checkbox, static select, data-bound select, and secret controls.
- Supports Keychain-backed secret slots with per-workbook bindings.
- Executes HTTP cells manually or automatically when marked with `auto="true"`.
- Runs named JavaScript cells against upstream variables, HTTP responses, and prior script output.
- Renders line, bar, and scatter charts from named workbook outputs with JSONPath selectors.
- Renders dynamic workbook data as tables or cards with JSONPath-backed list cells.
- Caches HTTP responses and runtime state outside the workbook file.
- Lets rendered Markdown and JSON cells reflect cached response and JavaScript output data.

RunBook is intentionally document-first: a workbook should still be readable and useful in any Markdown editor, even before anything has been executed.

## Workbook Format

Workbooks are plain Markdown files. Executable cells are fenced code blocks.

````markdown
# Example API Workbook

```variables name="env"
base_url = "https://jsonplaceholder.typicode.com"
user = "1"
limit = 20
include_archived = false
status = {
  "type": "select",
  "options": ["all", "success", "failed"]
}
```

Fetch a profile using the shared variables above. This request reruns automatically when its rendered inputs change.

```http name="profile" auto="true"
GET {{env.base_url}}/users/{{env.user}}
Accept: application/json
```

```json src="profile.body"
```

```javascript name="summary"
return {
	id: env.user,
	name: profile.body.name,
	city: profile.body.address.city,
	metrics: [
		{ label: "ID", value: Number(profile.body.id || 0) },
		{ label: "Name length", value: profile.body.name.length }
	]
};
```

```chart
type = bar
x = $.summary.metrics[*].label
y = $.summary.metrics[*].value
label = Profile metrics
```

```list
view = table
items = $.summary.metrics[*]
field = Metric | label
field = Value | value
```

- Status: {{profile.status}}
- Name: {{summary.name}}
- City: {{summary.city}}
````

Supported workbook fences in the current shell:

| Fence | Purpose |
| --- | --- |
| `variables` | Defines editable key-value values. |
| `http` | Defines an HTTP request that can be run manually or automatically with `auto="true"`. |
| `javascript` | Runs JavaScript with access to named outputs from earlier cells and caches the returned value. |
| `json` | Renders cached JSON from another cell reference. |
| `chart` | Renders a line, bar, or scatter chart from workbook output data selected with JSONPath. |
| `list` | Renders dynamic workbook output as a table or cards selected with JSONPath. |
| `assert` | Reserved for assertion cells. |

Runtime output is not written back into the Markdown file.

### Variable Cells

Variable cells expose editable values under their cell name, such as `{{env.user}}` in Markdown and HTTP cells, or `env.user` in JavaScript cells. Quoted values stay strings, unquoted numbers become number inputs, and unquoted `true`/`false` values become checkboxes:

````markdown
```variables name="filters"
base_url = "https://jsonplaceholder.typicode.com"
user = "1"
limit = 20
include_archived = false
```
````

Advanced controls can use JSON-style definitions. A static select control accepts `type`, array `options`, and an optional `default`; when `default` is omitted, the first option is selected by default.

````markdown
```variables name="filters"
status = {
  "type": "select",
  "options": ["all", "success", "failed"],
  "default": "success"
}
```
````

Data-bound selects use a JSONPath string for `options`. The path resolves against the same workbook output root used by charts: variables, HTTP outputs, and successful JavaScript outputs are all available by name. For object results, `label` chooses the displayed field, `value` chooses the stored field, and `default` optionally supplies the initial stored value:

````markdown
```variables name="filters"
run_id = {
  "type": "select",
  "options": "$.runs.body.items[*]",
  "label": "name",
  "value": "id",
  "default": "run_123"
}
```
````

For data-bound selects, the field selectors support dotted paths such as `"metadata.name"`. A previously selected value that no longer appears in the bound results stays visible as a missing option instead of being silently discarded.

Variable definitions start at the beginning of a line with `identifier =`, so multi-line JSON definitions continue until the next variable declaration or the end of the cell. Numbers and booleans are preserved as typed values in JavaScript cells and chart contexts; templates stringify them when rendering text.

### Automatic HTTP Cells

Named HTTP cells can opt into autorun with `auto="true"`:

````markdown
```http name="profile" auto="true"
GET {{env.base_url}}/users/{{env.user}}
```
````

The app compares the rendered request snapshot against the cached one and reruns the request when upstream variables, templates, or earlier computed values change.

### JavaScript Cells

JavaScript cells run in a worker and receive named outputs from earlier cells as parameters. Variables cells provide namespace objects, HTTP cells provide cached status/body data, and successful JavaScript cells provide their returned value to later cells and Markdown templates.

````markdown
```javascript name="summary"
return {
	status: profile.status,
	city: profile.body.address.city
};
```
````

JavaScript cells rerun automatically when their source or upstream inputs change. Use the optional `timeout` or `timeoutMs` attribute to control the execution limit.

### Chart Cells

Chart cells are rendered in the web app with Chart.js. Their `x` and `y` fields are JSONPath expressions where `$` is the workbook output context: variables, HTTP cells, and successful JavaScript cells are available by name. HTTP cells use the same envelope shape as JavaScript parameters: `status`, `statusText`, `body`, `rawBody`, and `request`.

````markdown
```chart
type = line
x = $.latency_data.body.items[*].timestamp
y = $.latency_data.body.items[*].duration_ms
label = Latency
```
````

Supported chart types are `line`, `bar`, and `scatter`. Line and bar charts keep `x` values as labels; scatter charts require numeric `x` and `y` values.

### List Cells

List cells render dynamic workbook output selected with JSONPath. Like charts and data-bound selects, `$` is the workbook output context, so variables, HTTP cells, and successful JavaScript cells are available by name.

Tables use repeated `field = Label | dotted.path` lines:

````markdown
```list
view = table
items = $.runs.body.items[*]
field = Run ID | id
field = Name | name
field = Owner | metadata.owner.name
```
````

Cards use an explicit `title`, optional `subtitle`, and the same repeated fields for detail rows:

````markdown
```list
view = cards
items = $.runs.body.items[*]
title = name
subtitle = status
field = Run ID | id
field = Owner | metadata.owner.name
```
````

`view` defaults to `table` when omitted. Field, title, and subtitle paths are resolved relative to each matched item; dotted paths are supported, and missing individual values render blank. A valid path with no matches shows an empty state instead of an error.

### Secret Slots

Global secrets are configured from the native app menu with **Secrets…**. Values are stored in macOS Keychain under user-chosen names such as `SECRET_ACCESS_KEY`; the app lists names but never displays stored values.

A variable can opt into a secret binding by using `<secret>` as its value:

```variables name="env"
api_key = <secret>
```

The rendered variable cell shows a dropdown of configured secret names. The selected binding is stored in the workbook runtime cache as a non-secret reference, while the actual Keychain value is fetched only when an HTTP request runs. Templates still use normal variable syntax, for example `Authorization: Bearer {{env.api_key}}`; previews and cached request snapshots are redacted.

## Project Layout

```text
app/                Native Objective-C++ macOS shell and WKWebView bridge
web/src/app.js      Workbook parsing, rendering, templating, and HTTP execution
web/src/charts.js   Chart data extraction and Chart.js rendering
web/src/field-paths.js Shared dotted field-path lookup for bound data renderers
web/src/lists.js    List cell JSONPath extraction, validation, and table/card rendering
web/src/selects.js  Static and data-bound select option resolution
web/src/workbook-output.js Shared workbook output root for JSONPath consumers
web/styles.css      Web UI styles loaded inside the native web view
samples/welcome.md  Bundled starter workbook
build.mjs           Reckon build graph for the app bundle
design.md           Product and architecture notes
```

Generated files live under `build/` and should not be edited by hand.

## Requirements

- macOS
- Xcode command line tools, including `clang`
- Node.js and npm

Install JavaScript dependencies from the repository root if they are not already present:

```sh
npm install
npm install --prefix web
```

## Build

Build the native app bundle:

```sh
npm run build
```

This runs `build.mjs`, builds the web bundle, compiles the Objective-C++ app, and writes the app bundle to:

```text
build/RunDown.app
```

## Run

Open the app bundle:

```sh
open -n build/RunDown.app
```

Or run the binary directly when you want terminal output:

```sh
./build/RunDown.app/Contents/MacOS/RunDown
```

## Development Notes

Most workbook behavior belongs in `web/src/app.js`: Markdown parsing, cell semantics, variable editing, HTTP execution, templating, and rendered document behavior.

The native layer in `app/window*.mm` should stay focused on macOS responsibilities: window creation, menus, document loading, WKWebView setup, app session handling, and runtime-cache persistence.

For a routine validation pass:

```sh
npm run test:variables
npm run test:lists
npm run build
open -n build/RunDown.app
```

Then open or interact with `samples/welcome.md` through the native app.
