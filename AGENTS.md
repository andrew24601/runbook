# AGENTS.md

## Purpose
This document explains the RunDown project layout, how to safely maintain it, and the validation workflow that works reliably in this repository.

## High-Level Architecture
RunDown is a macOS app built with Objective-C++, a native AppKit bridge, and a Reckon build graph.

- Native app entry (`app/main.mm`) is a thin launcher that hands off to the bridge-owned application runtime.
- Web app modules (`web/src/*.js`) own markdown parsing, workbook execution semantics, variable editing, HTTP execution, JavaScript execution, template resolution, runtime persistence payloads, and document rendering.
- Native bridge (`app/window*.mm`) owns Cocoa windowing, WKWebView bootstrapping, document loading, and runtime-cache persistence.

Data flow:
1. `app/main.mm` enters the native application.
2. `app/window_controls.mm` loads markdown source from disk or the bundled welcome document.
3. `app/window.mm` boots the WKWebView with document source and cached runtime JSON.
4. `web/src/app.js` initializes the web runtime, delegates workbook behavior to focused modules, and persists runtime state back through the native host bridge.

## Boundary Policy
- Default to implementing workbook behavior in the web app. If logic can run in JavaScript without Cocoa types, it should usually live in the focused `web/src/*.js` module that matches the behavior.
- Keep `app/window*.mm` limited to windowing, WKWebView bootstrapping, Cocoa event wiring, file/session integration, and persistence through macOS APIs.
- Do not add markdown interpretation, workbook formatting rules, template resolution, or request execution policy to Objective-C++ when the web app can own it directly.
- When native code starts branching on workbook content or re-deriving values from raw workbook text, treat that as a signal to move the decision into the web app.

## Repository Layout
- `design.md`: Product and architecture design notes.
- `build.mjs`: Reckon build graph for the native app bundle, icon generation, and web bundle integration.
- `app/main.mm`: Minimal native app entrypoint.
- `app/window.hpp`: Public native bridge API.
- `app/window_internal.h`: Shared internal declarations for bridge implementation files.
- `app/window.mm`: Native window entrypoint, WKWebView bootstrap, and runtime-cache bootstrap helpers.
- `app/window_controls.mm`: App delegate actions, document loading, session handling, and menu wiring.
- `web/src/app.js`: Thin web runtime entrypoint and host integration wiring.
- `web/src/bootstrap.js`: Bootstrap defaults and runtime-state normalization.
- `web/src/parser.js`: Markdown tokenization and workbook cell parsing.
- `web/src/rendering.js`: DOM rendering for workbook nodes, runtime sections, variable controls, and JSON highlighting.
- `web/src/runtime-state.js`: Derived HTTP/JavaScript/JSON node state and snapshot helpers.
- `web/src/charts.js`: Chart cell JSONPath extraction, validation, Chart.js rendering, and chart instance cleanup.
- `web/src/field-paths.js`: Shared dotted field-path lookup for bound data renderers.
- `web/src/lists.js`: List cell JSONPath extraction, validation, and table/card rendering.
- `web/src/selects.js`: Static and data-bound select option resolution.
- `web/src/workbook-output.js`: Shared workbook output root for JSONPath consumers.
- `web/src/execution.js`: HTTP autorun/manual execution, JavaScript cell execution, and propagation scheduling.
- `web/src/templates.js`: Template context construction and expression resolution.
- `web/src/variables.js`: Variable and secret-binding runtime mutations.
- `web/src/persistence.js`: Runtime cache payload construction and sanitization.
- `web/src/utils.js`: Shared small pure helpers.
- `web/scripts/validate-typed-variables.mjs`: Lightweight parser validation for typed variable cells.
- `web/scripts/validate-list-cells.mjs`: Lightweight parser/state/render validation for list cells.
- `web/styles.css`: Web app styling.
- `package.json`: Root npm scripts; `npm run build` runs `build.mjs`.
- `samples/welcome.md`: Bundled sample workbook.
- `build/`: Generated artifacts; do not edit manually.

## Build and Run
From repository root:

- Build app:
  - `npm run build`
- Build step performed by the root npm script:
  - `node build.mjs`
- Run app binary directly:
  - `./build/RunDown.app/Contents/MacOS/RunDown`
- Open as app bundle (Finder-like path):
  - `open -n build/RunDown.app`

## Validation Workflow
Use this sequence for routine maintenance:

1. `npm run test:variables`
2. `npm run test:lists`
3. `npm run build`
4. Launch app (`open -n build/RunDown.app`) for UI/runtime sanity.

Notes:
- Prefer the Reckon app build plus runtime sanity checks for feature work.

## Maintenance Guidelines
- Keep the `app/window*.mm` files focused on rendering and native interactions.
- Keep workbook semantics in the web app rather than the native bridge.
- When adding UI behavior, first ask whether the decision can be expressed in the web app instead of native branching.
- If a new helper does not need AppKit classes or macOS-only APIs, it probably does not belong in the `app/window*.mm` bridge layer.
- Do not manually edit generated files under `build/`.
- When changing UI expansion/collapse behavior, ensure document reflow logic is updated too.
- Keep this AGENTS.md file in sync with structural changes. When adding, removing, renaming, or meaningfully changing the role of a source file, update the Repository Layout and any affected boundary or validation guidance in the same change.
- Keep `README.md` in sync with shipped, user-visible behavior. When feature work adds or materially changes workbook capabilities, update the README examples, feature list, and usage notes in the same change.
- `build.mjs` discovers `web/src/*.js` for the web bundle dependencies; preserve that behavior if the web source layout changes.

## HTTP Cell Runtime Notes
- HTTP execution is handled in the web app.
- Variable templating and JSON/body reflection are handled in the web app from current variable values and cached HTTP responses.
- Native code only persists the runtime cache JSON written by the web app.

## Troubleshooting
- App crashes on startup:
  - Rebuild: `npm run build`
  - Run binary directly to capture crash stack.
- App behaves differently when run in terminal vs Finder:
  - Validate using `open -n build/RunDown.app`.
- UI compression/squashing after expand/collapse:
  - Verify document reflow logic still updates page height constraints.

## When Adding Features
1. Add or adjust workbook semantics in the appropriate focused `web/src/*.js` module first.
2. Extend the native bridge only when the feature needs Cocoa windowing, file integration, or persistence behavior.
3. Render and interact in native bridge only for the macOS-specific portion.
4. Update `samples/welcome.md` if feature should be visible by default.
5. Re-run `npm run build`.
