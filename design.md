# HTTP Workbook (RunDown) — Design Document

## Vision

A native Mac application for HTTP development built around the notebook metaphor. A workbook is both a living document and a runnable workflow — it can be a collection of completely unrelated HTTP tools, or a chained workflow that can be entered at arbitrary points. HTTP is the founding citizen and primary cell type, but the model is intentionally general. We go wide, not deep.

---

## Core Concepts

### Workbook

The top-level document. An ordered collection of cells, interspersed with prose. A workbook is coherent as a standalone document — readable, committable, shareable — without needing to be executed.

### Cell

The atomic unit of execution. Each cell has:
- A **type** that determines its execution behaviour and output envelope
- A **name/slug** used to reference its output from other cells
- A **definition** — the configuration specific to its type
- A **last output** — the result of the most recent execution, persisted across sessions
- A **staleness state** — whether the current definition and inputs match the snapshot taken at last execution

Cells are independent. There is no dependency graph. Each cell is responsible only for its own staleness.

### Execution Model

Execution is **persistent and deliberate**:
- Cells are never executed automatically
- A cell's last output persists indefinitely across sessions
- Execution is always a conscious user action — run this cell, or run all cells
- "Run all" is available but not the default mode

---

## The Input Manifold

Each cell snapshots its input manifold at execution time. The manifold is the complete set of resolved inputs used to produce the last output — URLs, headers, body, referenced cell outputs.

**Staleness** is detected eagerly: whenever any value in the workbook changes, all cells recheck their manifold snapshot against the current state. A cell whose manifold has diverged from its snapshot is marked stale, with a visual indicator prompting re-execution.

### Manifold Exclusions

The following are explicitly excluded from manifold snapshotting and staleness detection:

- The value of the `Authorization` header (auth is infrastructure, not logic)
- Raw values from secret slots, regardless of where they appear

---

## Templating

Cells can reference other cells' outputs using `{{ }}` expressions:

```
{{ cell_name.body.userId }}
{{ cell_name.status }}
{{ cell_name.headers.content-type }}
{{ my_vars.baseUrl }}
{{ env.api_token }}
```

The root of every expression is a cell name. Each cell type exports a well-known output envelope, so the available keys are predictable.

Templating is resolved at execution time. A reference to a cell that has never been run is an error at execution time, not at definition time. The UI surfaces unresolved references as a warning, not a blocker.

There is no autocomplete in the editor. A **reference panel** adjacent to the editor lists available cells and their output envelope keys, serving as a live reference while writing expressions.

---

## Cell Types

### HTTP Cell

The primary citizen. Executes an HTTP request.

**Definition:**
- Method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS)
- URL (supports template expressions)
- Headers (supports template expressions in values)
- Body (supports template expressions)

**Output envelope:**
```json
{
    "status": 201,
    "headers": { "content-type": "application/json" },
    "body": { ... }
}
```

Body is parsed as JSON if the response content type indicates JSON, otherwise stored as a raw string.

---

### Variable Cell

A named bag of key-value pairs. The foundation for shared configuration and environment values. Variable cells have no execution — they are always live.

**Naming conventions:**
- Plain name → regular variable, fully visible, included in manifold
- `<secret>` value → secret slot bound to a global Keychain item at runtime, displayed as `*****`, raw value excluded from manifold and cache

**Output envelope:**
```json
{
    "my_var": "value",
    "base_url": "https://api.example.com"
}
```

Variable cells export flat — referenced as `{{ my_vars.base_url }}` with no intermediate namespace.

---

### Assert Cell

Pulls in other cells' outputs and makes explicit claims about them. Decouples verification from execution — a request cell does not need to know about its assertions.

**Output envelope:**
```json
{
    "passed": true,
    "assertions": [
        { "label": "status is 200", "passed": true },
        { "label": "body.id exists", "passed": false }
    ]
}
```

---

### Markdown Cell

Pure documentation. Not executable, not referenceable. Produces no output envelope.

In the on-disk format, markdown cells are the prose between code blocks — they are not a distinct tagged block type, they are just the document itself.

---

### Future Cell Types

The cell model is intentionally open. Adding a new cell type requires:
- Defining its output envelope
- Implementing execution in core
- Building the AppKit view

Candidates for future addition, in rough priority order:
- **LLM** — prompt with context from other cells, output available for downstream templating
- **Graphing** — consumes another cell's output, renders a visualisation
- **Script (Doof)** — arbitrary execution, the escape hatch
- **WebSocket** — stateful, streaming; deferred until a concrete use case emerges

---

## On-Disk Format

Workbooks are stored as **Markdown files** with tagged code blocks for executable cells. The markdown between code blocks is the documentation — there is no separate Markdown cell type on disk.

```markdown
# My Workbook

Some introductory prose about what this workbook does.

## Authentication

```http name="login"
POST {{my_vars.base_url}}/auth
Content-Type: application/json
Authorization: Bearer {{my_vars.api_token}}

{"username": "{{my_vars.user}}"}
```

The login response gives us a token we can use downstream.

## Fetch Profile

```http name="profile"
GET {{my_vars.base_url}}/users/{{login.body.userId}}
Authorization: Bearer {{login.body.token}}
```

### Code Block Tags

| Cell type | Tag |
|---|---|
| HTTP | ` ```http ` |
| Variable | ` ```variables ` |
| Assert | ` ```assert ` |

All executable blocks take a `name` attribute which becomes the cell's slug for template references.

### What the file does and does not contain

**Contains:** Cell definitions, prose documentation, template expressions (unresolved)

**Does not contain:** Execution outputs, manifold snapshots, secrets, run history

The workbook file is always clean and committable. It never becomes dirty due to execution.

---

## Runtime Cache

Cell outputs, manifold snapshots, and run metadata are stored separately from the workbook file in the macOS application cache directory:

```
~/Library/Caches/com.yourapp/workbooks/
```

Keyed by a stable identifier derived from the workbook file path. Cache entries are gitignored by convention — losing the cache is not a disaster, it just means cells appear as never-run.

If a workbook is moved or renamed, the app detects the stale cache path on open and offers to relink, or silently cold-starts.

**Cache stores:**
- Last output per named cell
- Manifold snapshot per cell (excluding Authorization header values and raw secret slot values)
- Secret slot bindings by workbook namespace and variable key
- Run timestamps
- Run history (small ring buffer, TBD depth)

**Cache never stores:**
- Resolved secret values
- Raw Authorization header values

---

## Secrets — Keychain Integration

Secrets are managed globally by the native wrapper and stored as macOS Keychain generic password items. The Keychain service is `dev.doof.rundown.secrets`; the account is the user-visible secret name, such as `SECRET_ACCESS_KEY`.

Workbook variables opt into secret binding with a sentinel value:

```
api_token = <secret>
```

The rendered variable cell presents that entry as a dropdown of configured secret names. The dropdown selection is stored per workbook in the runtime cache as a non-secret binding:

```json
{
  "secretBindings": {
    "env": {
      "api_token": "SECRET_ACCESS_KEY"
    }
  }
}
```

Templates keep using normal variable syntax, such as `{{env.api_token}}`.

**Behaviour:**
- Values are added, updated, and deleted through a native Secrets panel; stored values are hidden
- Bound secret slots render as `*****` in prose, HTTP previews, and cached request snapshots
- Unbound secret slots disable HTTP execution until a configured secret is selected
- Actual secret values are requested from native only when an HTTP request runs
- Raw secret values are excluded from workbook Markdown, runtime cache, and request snapshots
- Secret values are not redacted from HTTP response bodies if a service echoes them back

---

## Staleness Visual Design

Staleness is communicated visually, augmented by colour. The specific treatment is TBD for visual design phase, but the principles are:

- Stale cells are clearly distinguishable from fresh cells at a glance
- The indicator is informative, not alarming — stale is a normal state, not an error
- A timestamp ("last run 3 hours ago") accompanies the staleness indicator
- Staleness is checked eagerly — the user never scrolls down to discover unexpected stale cells

---

## Architecture

### Layering

```
┌─────────────────────────────────┐
│         AppKit Frontend         │
│  Views, editors, layout, OS     │
└────────────────┬────────────────┘
                 │ Objective-C++ bridge
┌────────────────┴────────────────┐
│           Doof Core             │
│  Model, execution, templating,  │
│  manifold, HTTP, serialisation  │
└─────────────────────────────────┘
```

### Doof Core Owns
- `Workbook` and `Cell` model
- Execution engine per cell type
- Template expression parsing and resolution
- Manifold snapshotting and staleness detection
- HTTP client logic
- Assert evaluation
- Workbook serialisation/deserialisation (markdown format)
- Cache read/write

### AppKit Owns
- Window and view hierarchy
- Cell rendering and layout
- Editor fields (`NSTextView`)
- Staleness visual treatment
- Run controls and status indicators
- Drag to reorder cells
- Reference panel

### Objective-C++ Bridge
A thin translation layer. No logic lives here — it is purely a surface for AppKit to call into Doof core and receive results.

---

## Out of Scope (v1)

- Script / exec cells
- WebSocket cells
- GraphQL (dropped — not missed)
- Autocomplete in template editors
- Automatic execution or reactive re-execution
- Output diffing to suppress staleness propagation
- Multi-user or collaborative features
