# RunBook

RunBook is a native macOS HTTP workbook app. It treats Markdown files as runnable notebooks for API development: prose explains the workflow, fenced cells define variables and HTTP requests, and the app keeps execution output in a separate runtime cache so the workbook itself stays clean and committable.

The current app bundle and binary are still named `RunDown` in the build output.

## What It Does

- Opens Markdown workbooks in a native macOS window.
- Renders ordinary Markdown alongside runnable workbook cells.
- Supports shared variable cells with `{{variable.name}}` templating.
- Executes HTTP cells deliberately, only when the user runs them.
- Caches HTTP responses and runtime state outside the workbook file.
- Lets rendered Markdown and JSON cells reflect cached response data.

RunBook is intentionally document-first: a workbook should still be readable and useful in any Markdown editor, even before anything has been executed.

## Workbook Format

Workbooks are plain Markdown files. Executable cells are fenced code blocks.

````markdown
# Example API Workbook

```variables name="env"
base_url = "https://jsonplaceholder.typicode.com"
user = "1"
```

Fetch a profile using the shared variables above.

```http name="profile"
GET {{env.base_url}}/users/{{env.user}}
Accept: application/json
```

```json src="profile.body"
```

- Status: {{profile.status}}
- Name: {{profile.body.name}}
````

Supported workbook fences in the current shell:

| Fence | Purpose |
| --- | --- |
| `variables` | Defines editable key-value values. |
| `http` | Defines and runs an HTTP request. |
| `json` | Renders cached JSON from another cell reference. |
| `assert` | Reserved for assertion cells. |

Runtime output is not written back into the Markdown file.

## Project Layout

```text
app/                Native Objective-C++ macOS shell and WKWebView bridge
web/src/app.js      Workbook parsing, rendering, templating, and HTTP execution
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
npm run build
open -n build/RunDown.app
```

Then open or interact with `samples/welcome.md` through the native app.
