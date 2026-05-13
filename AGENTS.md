# AGENTS.md

## Purpose
This document explains the RunDown project layout, how to safely maintain it, and the validation workflow that works reliably in this repository.

## High-Level Architecture
RunDown is a macOS app built with Objective-C++, a native AppKit bridge, and a Reckon build graph.

- Native app entry (`app/main.mm`) is a thin launcher that hands off to the bridge-owned application runtime.
- Web app (`web/src/app.js`) owns markdown parsing, workbook execution semantics, variable editing, HTTP execution, and document rendering.
- Native bridge (`bridge/window*.mm`) owns Cocoa windowing, WKWebView bootstrapping, document loading, and runtime-cache persistence.

Data flow:
1. `app/main.mm` enters the native application.
2. `app/window_controls.mm` loads markdown source from disk or the bundled welcome document.
3. `app/window.mm` boots the WKWebView with document source and cached runtime JSON.
4. `web/src/app.js` parses markdown, renders the document, executes HTTP cells, edits variables, and persists runtime state back through the native host bridge.

## Boundary Policy
- Default to implementing workbook behavior in the web app. If logic can run in JavaScript without Cocoa types, it should usually live in `web/src/app.js`.
- Keep `bridge/window*.mm` limited to windowing, WKWebView bootstrapping, Cocoa event wiring, file/session integration, and persistence through macOS APIs.
- Do not add markdown interpretation, workbook formatting rules, template resolution, or request execution policy to Objective-C++ when the web app can own it directly.
- When native code starts branching on workbook content or re-deriving values from raw workbook text, treat that as a signal to move the decision into the web app.

## Repository Layout
- `design.md`: Product and architecture design notes.
- `Reckonfile.ts`: Build graph for the native app bundle, icon generation, and web bundle integration.
- `app/main.mm`: Minimal native app entrypoint.
- `app/window.hpp`: Public native bridge API.
- `app/window_internal.h`: Shared internal declarations for bridge implementation files.
- `app/window.mm`: Native window entrypoint, WKWebView bootstrap, and runtime-cache bootstrap helpers.
- `app/window_controls.mm`: App delegate actions, document loading, session handling, and menu wiring.
- `web/src/app.js`: Web app source for markdown parsing, rendering, variable editing, and HTTP execution.
- `web/styles.css`: Web app styling.
- `build.sh`: Root build wrapper that installs local dependencies if needed, then runs the Reckon build graph.
- `samples/welcome.md`: Bundled sample workbook.
- `build/`: Generated artifacts; do not edit manually.

## Build and Run
From repository root:

- Build app:
  - `./build.sh`
- Build steps performed by `build.sh`:
  - `cd reckon && npx tsx ../Reckonfile.ts`
- Run app binary directly:
  - `./build/RunDown.app/Contents/MacOS/RunDown`
- Open as app bundle (Finder-like path):
  - `open -n build/RunDown.app`

## Validation Workflow
Use this sequence for routine maintenance:

1. `./build.sh`
2. Launch app (`open -n build/RunDown.app`) for UI/runtime sanity.

Notes:
- Prefer the Reckon app build plus runtime sanity checks for feature work.

## Maintenance Guidelines
- Keep the `bridge/window*.mm` files focused on rendering and native interactions.
- Keep workbook semantics in the web app rather than the native bridge.
- When adding UI behavior, first ask whether the decision can be expressed in the web app instead of native branching.
- If a new helper does not need AppKit classes or macOS-only APIs, it probably does not belong in the `bridge/window*.mm` bridge layer.
- Do not manually edit generated files under `build/`.
- When changing UI expansion/collapse behavior, ensure document reflow logic is updated too.

## HTTP Cell Runtime Notes
- HTTP execution is handled in the web app.
- Variable templating and JSON/body reflection are handled in the web app from current variable values and cached HTTP responses.
- Native code only persists the runtime cache JSON written by the web app.

## Troubleshooting
- App crashes on startup:
  - Rebuild: `./build.sh`
  - Run binary directly to capture crash stack.
- App behaves differently when run in terminal vs Finder:
  - Validate using `open -n build/RunDown.app`.
- UI compression/squashing after expand/collapse:
  - Verify document reflow logic still updates page height constraints.

## When Adding Features
1. Add or adjust workbook semantics in `web/src/app.js` first.
2. Extend the native bridge only when the feature needs Cocoa windowing, file integration, or persistence behavior.
3. Render and interact in native bridge only for the macOS-specific portion.
4. Update `samples/welcome.md` if feature should be visible by default.
5. Re-run `./build.sh`.
