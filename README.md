# Visor

Visor is a standalone Electron app that shows how GitHub Copilot, Codex, and Claude Code edits change a Python, JavaScript, TypeScript, C#, or C++ project. The diagram groups functions and members under their module or type. Visor parses saved source with Tree-sitter and stores change history in SQLite outside your project. Steps 1 through 6 of the [build plan](BUILD_PLAN.md) are implemented.

The native app shows actual stored sessions, not the hardcoded sample. Select a change to see its graph from saved snapshots. **Live** follows new changes, and selecting an older entry pauses it. Changed classes glow. The first observed prompt becomes the session title, with the start time as a fallback. An app with no observed sessions starts empty.

**Baseline** is the saved state before the first edit, not Change 1, and does not count toward the change total. The first visible edit is **Change 1**. Later visible edits are numbered consecutively, even when older documentation-only entries are hidden. A post-only recovery remains marked as a late baseline because the pre-edit state was not observed.

Edit diagrams accumulate classes through the selected change. Each edit adds touched classes, project classes explicitly mentioned in the tool call, and direct targets of changed relationships. Earlier classes remain visible even when a later edit does not mention them. Actual code deletions remain visible in red in subsequent changes. Other highlights describe only the selected edit. Each edit's saved snapshot determines its scope, so later code movement does not change earlier visibility.

Referenced but unedited classes remain styled as unchanged. Classes named in replacement text, patch content, or the tool explanation can be included even when they were not edited. An untouched sibling is not included just because its file changed, and references do not recursively pull in the project graph. Text hunks use changed lines to find edited classes. Constants-only edits do not invent class nodes.

Mentioned names resolve in the edited file first, then through known relationships or unique project-wide matches. Ambiguous foreign names remain unresolved. Only resolved class IDs are added to saved events and changes, not another copy of the tool's code. Pre-hook mentions survive a snippet-free post hook. Previously saved changes without mention metadata still retain direct targets of changed relationships. Stored models remain complete. Once Change 1 exists, the baseline shows only pre-existing classes in Change 1's scope. Before any edit is recorded, the baseline previews the project.

Hover or focus a method to see its full stored source. Added lines are green, removed lines are red, and unchanged lines are black. The tooltip uses the selected change's snapshots, not the current file on disk. Classes retained after deletion use their original deletion snapshot for source hover. Long methods scroll. If source snapshots are missing, the tooltip shows the signature and a source-unavailable state.

The browser-only preview uses the sample because it has no preload or database access. Step 7 transition choreography and the dedicated history git repository remain unimplemented.

## Supported languages

| Source | What you can inspect |
| --- | --- |
| JavaScript and TypeScript | Modules, functions, arrow functions, classes, interfaces, type aliases, and fields. Visor links local ES imports and common literal CommonJS `require` and export forms. JSX and TSX component references indicate source usage, not runtime rendering. |
| C# | Namespaces, classes, structs, interfaces, records, methods, properties, and events. Partial types share a node within a project. Overloads have distinct IDs. An ambiguous call does not select an overload by name. |
| C++ | Namespaces, classes, structs, free functions, methods, fields, and local quoted includes. A matching declaration and definition share an ID and keep both source locations. Hover shows the saved implementation when one exists. |
| Python | Classes, module-level functions, methods, fields, and the relationships described below. Existing sessions remain readable. |

The same hook configuration works for mixed-language projects. No compiler or language server is required for basic diagrams. For example, an edit to a TSX component and its JavaScript helper appears in the same timeline; the call links to the helper's module when its export resolves. See the [extension list](packages/protocol/src/languages.ts) for recognized file suffixes.

Native IDs use the nearest captured `.csproj`, `.vcxproj`, or `CMakeLists.txt` for the relevant language. With no marker, Visor uses workspace scope. Multiple competing markers in the same directory keep symbols file-local. Visor does not evaluate MSBuild, CMake targets, preprocessor configurations, or template instantiations. Package aliases, dynamic imports, runtime dispatch, XAML bindings, and browser layout require more than this source analysis. HTML and CSS are not standalone analyzers.

## Relationship analysis

Hooks identify changed files and provide timing and attribution. Visor parses saved Python source and resolves classes through local declarations and imports. It does not execute the source.

| Relationship | Initial supported evidence | Display |
| --- | --- | --- |
| Inheritance | Declared class bases | Hollow target triangle |
| Composition | Constructed objects retained in fields, including constructor-or-`None` expressions | Filled source diamond, marked inferred |
| Aggregation | Supplied collections of typed references retained in fields | Hollow source diamond, marked inferred |
| Association | Retained typed references without established ownership | Open arrow, marked inferred |
| Dependency | Constructor use without a stronger retained relationship | Dashed arrow |
| Signal or event | Explicit `publisher.signal.connect(receiver.handler)` or `.subscribe(...)` | Dashed arrow with signal and handler names |

Field labels for the same kind and class pair combine, such as `image_a / image_b`. Hover a relationship label for source locations and the inference reason. Added and removed connections use the existing green and red colors. Dagre reserves space for labels and routes connections around classes.

Python references do not establish exclusive object lifetime. Composition and aggregation are inferred. Static subscriptions establish wiring in the source, not runtime delivery. Ambiguous constructor branches, runtime wiring, and unrelated classes with the same name do not justify a guessed ownership edge.

The optional [Visor Companion](apps/companion/README.md) supplies VS Code type-definition and definition locations. Source and target hashes must match versions already saved by Visor. Dirty, outside-workspace, stale, and ambiguous targets do not enrich the graph. Historical views reparse stored source and use matching facts without rewriting saved change documents. Source-less records keep their existing model and source-unavailable state.

The companion VSIX builds and packages locally. Electron tests exercise the semantic HTTP contract and historical matching. Live VS Code extension-host integrations with individual language servers remain unverified.

## Run the app

Install Node.js 22.12 or newer. From the repository root, install the workspace dependencies and open Visor.

```sh
npx --yes pnpm@10.20.0 install
npx --yes pnpm@10.20.0 dev
```

If you already have pnpm 10.20.0, use `pnpm install` and `pnpm dev`. Install dependencies on the Mac so Electron and SQLite use binaries for its architecture. If SQLite needs to compile from source on macOS, install Python 3 and the Xcode command line tools with `xcode-select --install`. Windows source builds require the Visual Studio C++ Build Tools and Python.

The install script prepares separate SQLite native bindings for Node and Electron. After changing Electron versions, run `npx --yes pnpm@10.20.0 rebuild:sqlite`. The dev command also starts a browser preview. Its URL is printed by Vite.

## Verify the implementation

```powershell
pnpm typecheck
pnpm test
```

`pnpm test` builds the hook CLI, runs Vitest, builds the desktop app, and launches the actual Electron app with Playwright. No separate browser download is required. Tests cover normalization goldens, Python extraction and recovery, semantic diffs, SQLite migrations and rollback, exact source blobs, resend deduplication, and restart persistence. Electron tests drive live updates, historical models, keyboard selection, session switching, responsive layouts, security, and edit-only startup and focus. Tests use temporary data and capture folders. They never replace real hook fixtures.

The illustrative [four-change history](fixtures/sessions/four-changes/history.json) seeds visual tests through the real database. `pnpm fixtures:history` regenerates that fixture. Screenshots appear in `test-results/` after the UI tests.

## Replay and inspect history

Run these commands from the repository root.

```powershell
pnpm visor replay fixtures/sessions/nifti-replay
pnpm visor dump --session <session-id>
```

Replay prints the baseline and computed changes from recorded hooks and supplied source snapshots. Dump prints a session's saved changes and models in ascending order. The database is `visor.db` in the [Visor data folder](#raw-event-capture).

The NIfTI replay uses real captured hook envelopes and reconstructed, redacted source snapshots. It does not reproduce the original private source bytes. The [normalization manifest](fixtures/normalized/manifest.json) fixes 39 reviewed captures. Review new captures and generated output before updating that set with `pnpm fixtures:update`.

## Connect agent hooks

Run the command from the Visor repository. Set `--workspace` to the project you want to observe. Run it once for each provider you use in that project.

```sh
npx --yes pnpm@10.20.0 setup:hooks --workspace "$PWD/../visor-sandbox" --provider codex
npx --yes pnpm@10.20.0 setup:hooks --workspace "$PWD/../visor-sandbox" --provider claude-code
npx --yes pnpm@10.20.0 setup:hooks --workspace "$PWD/../visor-sandbox" --provider copilot
```

| Provider | File in the workspace | File tools Visor tracks |
| --- | --- | --- |
| GitHub Copilot (default) | `.github/hooks/visor.json` | Creation, replacement, patches, and other explicit edits |
| Codex | `.codex/hooks.json` | `apply_patch` |
| Claude Code | `.claude/settings.local.json` | `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` |

The installer builds Visor, writes the local desktop launch configuration, and registers a command for each observed event. Codex and Claude Code registration preserves existing hook groups and settings. A second run with the same paths leaves the generated entry in place. The commands contain absolute paths to Node and the hook script. Keep these machine-specific entries local. After moving Visor, remove the old entries and its launcher `config.json` before registering again. To use a packaged app, pass the executable with `--app-path`. On macOS, use the executable inside the bundle, such as `/Applications/Visor.app/Contents/MacOS/Visor`.

Open the workspace in your agent. For Codex, trust the workspace and review the registered commands with `/hooks`. For Claude Code, start a local session in the workspace and inspect registrations with `/hooks`. For Copilot, open the trusted workspace in VS Code and select the **Copilot** session target. See the [Codex hooks reference](https://learn.chatgpt.com/docs/hooks), [Claude Code hooks reference](https://code.claude.com/docs/en/hooks), and [Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference).

Start Visor before the session if you want it to capture the opening prompt and session start. Ask your agent to create a Python file with a `Cart` class, then edit it with a supported file tool. Visor adds each completed edit to the timeline. With Visor closed, the first supported edit starts it and captures the baseline before the edit.

## Raw event capture

The Electron main process binds a free port on `127.0.0.1`, generates a random token, and publishes `{ port, token, pid }` atomically in `runtime.json` in the Visor data folder. The file is removed on a clean exit. A stale file is checked against authenticated health before use. Do not share this file or its token.

`GET /health` and `POST /hooks/raw`, `/semantic/queries`, and `/semantic` require `Authorization: Bearer <token>` and reject any browser `Origin` header. Semantic requests for unobserved source versions return 409. The renderer receives only a token-free preload API. The browser preview cannot access the hook server or raw debug settings.

The Node `visor-hook` executable accepts an event name, an optional provider argument, and a JSON object on stdin. It wraps the original payload with the provider, event name, UUID, and receipt time. Copilot is the default provider for existing hook commands. It checks the runtime, launches the configured desktop app if needed, waits up to three seconds for startup, and posts with a 500 ms timeout. Hooks exit zero even if Visor is unavailable. Copilot and Codex receive an empty JSON object. Claude Code receives no output. A 4.5-second watchdog bounds the invocation, and hook configuration allows five seconds. It never grants or denies tools.

Only pre-tool and post-tool events for explicit file-changing tools launch or focus Visor. These include file creation, replacement, multi-replacement, patches, and notebook edits. Session start, prompts, read/search tools, terminal commands, and unknown tools do not trigger startup or focus. A planning request that actually creates or edits a file does trigger Visor. All event types remain available in the debug feed while Visor is running. Session, prompt, and read events received while Visor is closed are not buffered.

Before a cold launch, a file-changing hook saves its touched-file snapshot in the data folder's `pending-hooks` directory. A pre-hook also saves the supported source baseline before the tool can edit files. These private, atomic handoffs survive the hook's startup timeout. Visor replays them before publishing its runtime, deduplicates by event ID, and removes each handoff after committing it to SQLite. Cold capture uses the same workspace and source limits, with a combined 16 MiB budget for baseline and touched-file text. Failed captures still fail open.

On Windows, startup is dispatched through the desktop shell. This prevents Electron from retaining PowerShell's hook output pipes after the hook exits. Cold-start Electron tests check hook completion, process liveness, and exact Baseline and Change 1 source, including a startup delay beyond the hook deadline.

In dev builds, **Raw hook capture** saves envelopes to `fixtures/raw-hooks/<event>-<n>.json`. It is off by default. The recent-event buffer holds 200 events. Enabling capture writes the retained events once, then captures new events. Packaged builds disable this capture mode.

Capture redacts common credential fields, common token patterns, transcript paths, and private absolute paths. Files within the supplied workspace retain relative paths. This is not a guarantee that arbitrary prompts or code contain no secrets. Review and sanitize every real capture before committing it. Step 2 does not commit files automatically.

`VISOR_APP_PATH` can override the configured desktop executable. `VISOR_DATA_DIR` and `VISOR_CAPTURE_DIR` provide isolated locations for tests or a disposable dev instance. The default data folder is `~/Library/Application Support/Visor` on macOS and `%APPDATA%\Visor` on Windows. Linux uses `Visor` under `XDG_CONFIG_HOME` or `~/.config`.

## Snapshot boundaries

Touched files are captured during hook acceptance, before the tool can continue. Parsing and SQLite writes run afterward in a serialized queue. Each post-hook retains its own after-state, so fast successive calls remain separate. A failed tool or an unchanged source produces no change.

History entries require a changed file supported by a language extractor. Documentation-only edits create no entry, but mixed source and documentation edits remain one change. Previously saved documentation-only entries are hidden from the sidebar without deleting their history records. New snapshots use the [v2 symbol graph](packages/protocol/README.md). Visor reads v1 Python rows without rewriting them.

An observed session start produces baseline 0. If startup missed it, the first pre-hook captures a before-edit baseline, including across a cold launch. A post-only recovery without a saved pre-hook uses the current after-state and labels the baseline late. Existing late baselines are not reconstructed automatically. Visor does not invent an earlier observation or missing prompt.

Source snapshots respect root and nested `.gitignore` rules, including exceptions. Credential paths such as `.env`, `.ssh`, and private key files are excluded. Standard repository, dependency, environment, and build folders are also excluded. Symbolic links and junctions are not followed. Each UTF-8 file is limited to 2 MiB. A baseline is limited to 500 supported source and project-marker files and 32 directory levels. A tool snapshot is limited to 64 paths and 16 MiB of source text.

Path exclusions do not detect secrets embedded in ordinary source, prompts, or docstrings. Use a disposable workspace and review captured content. Existing saved data is not retroactively redacted. External filesystem edits and Copilot Keep/Undo observations still require later change-capture integration. Companion watchers refresh semantic facts only; they do not create history changes.

## Reuse the palette

[packages/theme/src/tokens.css](packages/theme/src/tokens.css) owns the shared renderer colors.

| Token | Value | Purpose |
| --- | --- | --- |
| `--visor-deleted` | `#C44A3A` | Deleted text |
| `--visor-diagram` | `#D97A2B` | Diagram background |
| `--visor-app` | `#F2D479` | App background |
| `--visor-added` | `#6FAF4F` | Added text |
| `--visor-deleted-background` | `#F5DCD6` | Light deleted-text background |
| `--visor-added-background` | `#E1EED7` | Light added-text background |
| `--visor-ink` | `#000000` | Unchanged text |

Add `@visor/theme` as a workspace dependency in another app and import `@visor/theme/tokens.css` once in its entry point. Use the CSS variables in styles. For diagram APIs that accept a color string, import `themeVariables` from `@visor/theme`. Future changes and code views can use the same tokens.

## Step 1 boundaries

- [apps/desktop/src/renderer/diagram/types.ts](apps/desktop/src/renderer/diagram/types.ts) defines `DiagramView` and `DiagramSource`.
- [apps/desktop/src/renderer/diagram/fixture-source.ts](apps/desktop/src/renderer/diagram/fixture-source.ts) is the only module that imports the JSON fixture. The app receives a source through its props.
- [apps/desktop/src/renderer/diagram/layout.ts](apps/desktop/src/renderer/diagram/layout.ts) owns Dagre positions, edge routes, and label reservations. Step 7 transition choreography remains separate.
- The Electron renderer has no Node access. The main process enables `contextIsolation` and `sandbox`, disables `nodeIntegration`, and rejects new windows and navigation.

## Step 2 boundaries

- [packages/bridge/src/index.ts](packages/bridge/src/index.ts) owns raw envelopes, runtime-file schemas, and token-free renderer snapshots. These are transport types, not the normalized Step 3 protocol.
- [apps/hook/src/forward.ts](apps/hook/src/forward.ts) owns stdin validation, runtime discovery, launch recovery, and posting. The executable wrapper still exits zero if the CLI has not been built.
- [apps/hook/src/install.ts](apps/hook/src/install.ts) owns workspace hook registration. [packages/bridge/src/hook-providers.ts](packages/bridge/src/hook-providers.ts) defines provider events and edit tools, and [packages/core/src/hooks.ts](packages/core/src/hooks.ts) adapts their payloads to the shared event contract.
- [apps/desktop/src/main/hook-server.ts](apps/desktop/src/main/hook-server.ts) owns authenticated HTTP ingestion.
- [apps/desktop/src/main/hook-monitor.ts](apps/desktop/src/main/hook-monitor.ts) owns recent events and dev capture. The renderer gets snapshots through the sandboxed preload, not filesystem or HTTP access.

The optional semantic bridge lives in [apps/companion](apps/companion). It neither launches nor focuses Visor, and it does not replace hook change capture.

## Step 3 boundaries

- [packages/protocol/src/index.ts](packages/protocol/src/index.ts) owns v1 schemas and schema-derived types, with no UI, network, or storage dependency.
- [packages/protocol/README.md](packages/protocol/README.md) records all normalization decisions, field sources, unknown outcomes, and missing lifecycle observations.
- [packages/protocol/examples/documents.json](packages/protocol/examples/documents.json) supplies valid and invalid examples for every public schema family.
- [apps/desktop/src/renderer/diagram/protocol-adapter.ts](apps/desktop/src/renderer/diagram/protocol-adapter.ts) implements the pure `toDiagramView(model, change)` projection. The fixture source combines it with session and history summaries.
- This package remains independent of the normalizer, database, and renderer.

## Steps 4 through 6 boundaries

- [packages/core/src/index.ts](packages/core/src/index.ts) exports the pure normalizer, extractor, model assembly, differ, and replay functions. The app supplies source text and an initialized parser.
- [apps/desktop/src/main/change-pipeline.ts](apps/desktop/src/main/change-pipeline.ts) owns filesystem observations, per-session ordering, baseline recovery, persistence, and notifications.
- [packages/store/src/store.ts](packages/store/src/store.ts) owns SQLite behind `ChangeStore` and `SnapshotStore`. Numbered migrations live in [packages/store/migrations](packages/store/migrations).
- [apps/cli/src/index.ts](apps/cli/src/index.ts) owns replay and dump commands.
- [apps/desktop/src/renderer/diagram/history-source.ts](apps/desktop/src/renderer/diagram/history-source.ts) loads actual stored snapshots through the narrow preload API. The renderer has no filesystem, SQLite, or runtime-token access.