# Visor

Visor is a standalone Electron app that turns Copilot Python file edits into class diagrams and saved change history. Steps 1 through 6 of the [build plan](BUILD_PLAN.md) are implemented. The app normalizes hooks, extracts Python symbols with Tree-sitter, computes semantic and textual changes, and stores snapshots in SQLite outside your project.

The native app shows actual stored sessions, not the hardcoded sample. Select a change to see its graph from saved snapshots. **Live** follows new changes, and selecting an older entry pauses it. Changed classes glow. The first observed prompt becomes the session title, with the start time as a fallback. An app with no observed sessions starts empty.

Hover or focus a method to see its full stored source. Added lines are green, removed lines are red, and unchanged lines are black. The tooltip uses the selected change's snapshots, not the current file on disk. Long methods scroll. If source snapshots are missing, the tooltip shows the signature and a source-unavailable state.

The browser-only preview still uses the sample because it has no preload or database access. Step 7 layout choreography, other language extractors, and the dedicated history git repository remain unimplemented.

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

The companion VSIX builds and packages locally. The semantic HTTP contract and historical matching have actual Electron coverage. A live VS Code extension-host run with Pylance remains unverified.

## Run the app

Install Node.js 22.12 or newer and pnpm 10.20.0. From the repository root, run these commands.

```powershell
pnpm install
pnpm --filter desktop dev
```

The command opens Visor and starts a browser preview. Use the localhost URL printed by Vite. If port 5173 is occupied, Vite chooses another port.

The install script prepares separate SQLite native bindings for Node and Electron. After changing Electron versions, run `pnpm rebuild:sqlite`. Windows source builds require Python and Visual Studio C++ Build Tools. Node 24.15.0 and Electron 38.8.6 were verified here.

If pnpm is not installed, use these commands instead.

```powershell
npx --yes pnpm@10.20.0 install
npx --yes pnpm@10.20.0 --filter desktop dev
```

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

Replay prints the baseline and computed changes from recorded hooks and supplied source snapshots. Dump prints a session's saved changes and models in ascending order. The default database is `%APPDATA%\Visor\visor.db`. `VISOR_DATA_DIR` selects another data folder.

The NIfTI replay uses real captured hook envelopes and reconstructed, redacted source snapshots. It does not reproduce the original private source bytes. The [normalization manifest](fixtures/normalized/manifest.json) fixes 39 reviewed captures. Review new captures and generated output before updating that set with `pnpm fixtures:update`.

## Connect a Copilot sandbox

Register hooks for a disposable workspace. This command builds both apps, creates the sandbox hook file, and writes the local desktop launch configuration.

```powershell
npx --yes pnpm@10.20.0 setup:hooks --workspace D:\Projects\visor-sandbox
```

The installer writes `.github/hooks/visor.json` inside the sandbox and `%APPDATA%\Visor\config.json` outside your project. It quotes executable paths, preserves other hook files, and refuses to overwrite a differing Visor configuration. Run it again after moving this repository. For a packaged desktop executable, add `--app-path C:\path\to\Visor.exe`.

The hooks follow the current [VS Code documentation](https://code.visualstudio.com/docs/copilot/customization/hooks) and [Copilot hook reference](https://docs.github.com/en/copilot/reference/hooks-reference), checked on November 12, 2026. The Copilot session target uses these names.

| Build plan event | Registered event |
| --- | --- |
| `SessionStart` | `sessionStart` |
| `UserPromptSubmit` | `userPromptSubmitted` |
| `PreToolUse` | `preToolUse` |
| `PostToolUse` | `postToolUse` |
| `Stop` | `agentStop` |

PascalCase aliases are accepted by the forwarder too. `agentStop` ends a turn, not the session. The adapter recognizes an explicit `sessionEnd`, but the installer does not yet register it. A missing session-end observation remains unknown.

Perform the real-session demo after registration.

1. Close Visor.
2. Open `D:\Projects\visor-sandbox` in VS Code, trust the disposable workspace, and select the **Copilot** session target.
3. Start a new agent session. Ask it to create a Python file with a `Cart` class, then edit that class.
4. Confirm that the first create or edit opens Visor and that each completed edit adds a change. Open **Settings** and enable **Raw hook capture** to inspect raw and normalized events.
5. Select an older change. Confirm that **Live** turns off and the older diagram remains selected while the agent edits. Turn **Live** on to return to the newest change.
6. Close and reopen Visor. Confirm that the session, baseline, and changes survive. Use `pnpm visor dump --session <session-id>` to inspect them.
7. Start another session and request a file edit. The edit brings the existing Visor window to the front rather than opening a second window.

The real Step 2 session has been exercised. Steps 4 through 6 have automated recorded-hook replay and actual Electron workflow coverage. A fresh user-initiated Copilot sandbox run and the manual one-second live-update target remain unverified. Automated payloads must not be described as real captures.

## Raw event capture

The Electron main process binds a free port on `127.0.0.1`, generates a random token, and publishes `{ port, token, pid }` atomically in `%APPDATA%\Visor\runtime.json`. The file is removed on a clean exit. A stale file is checked against authenticated health before use. Do not share this file or its token.

`GET /health` and `POST /hooks/raw`, `/semantic/queries`, and `/semantic` require `Authorization: Bearer <token>` and reject any browser `Origin` header. Semantic requests for unobserved source versions return 409. The renderer receives only a token-free preload API. The browser preview cannot access the hook server or raw debug settings.

The Node `visor-hook` executable accepts an event argument and a JSON object on stdin. It wraps the payload with a UUID, `source: "copilot"`, an event name, and epoch-millisecond `receivedAt`. It checks the runtime, launches the configured desktop app if needed, waits up to three seconds for startup, and posts with a 500 ms timeout. Hook failures emit `{}` and exit zero. A 4.5-second watchdog bounds the invocation, and hook configuration allows five seconds. It never grants or denies tools.

Only pre-tool and post-tool events for explicit file-changing tools launch or focus Visor. These include file creation, replacement, multi-replacement, patches, and notebook edits. Session start, prompts, read/search tools, terminal commands, and unknown tools do not trigger startup or focus. A planning request that actually creates or edits a file does trigger Visor. All event types remain available in the debug feed while Visor is running. Events received while Visor is closed are not buffered.

On Windows, startup is dispatched through the desktop shell. This prevents Electron from retaining PowerShell's hook output pipes after the hook exits. The cold-start Electron test checks that the captured hook command completes while Visor remains alive.

In dev builds, **Raw hook capture** saves envelopes to `fixtures/raw-hooks/<event>-<n>.json`. It is off by default. The recent-event buffer holds 200 events. Enabling capture writes the retained events once, then captures new events. Packaged builds disable this capture mode.

Capture redacts common credential fields, common token patterns, transcript paths, and private absolute paths. Files within the supplied workspace retain relative paths. This is not a guarantee that arbitrary prompts or code contain no secrets. Review and sanitize every real capture before committing it. Step 2 does not commit files automatically.

`VISOR_APP_PATH` can override the configured desktop executable. `VISOR_DATA_DIR` and `VISOR_CAPTURE_DIR` provide isolated locations for tests or a disposable dev instance. The default Windows data folder is `%APPDATA%\Visor`.

## Snapshot boundaries

Touched files are captured during hook acceptance, before the tool can continue. Parsing and SQLite writes run afterward in a serialized queue. Each post-hook retains its own after-state, so fast successive calls remain separate. A failed tool or an unchanged source produces no change.

An observed session start produces baseline 0. If startup missed it, the first pre-hook captures a before-edit baseline. A post-only recovery uses the current after-state and labels the baseline late. Visor does not invent an earlier observation or missing prompt.

Source snapshots respect root and nested `.gitignore` rules, including exceptions. Credential paths such as `.env`, `.ssh`, and private key files are excluded. Standard repository, dependency, environment, and build folders are also excluded. Symbolic links and junctions are not followed. Each UTF-8 file is limited to 2 MiB. A baseline is limited to 500 Python files and 32 directory levels. A tool snapshot is limited to 64 paths and 16 MiB of source text.

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
- [apps/hook/src/install.ts](apps/hook/src/install.ts) owns sandbox hook registration.
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