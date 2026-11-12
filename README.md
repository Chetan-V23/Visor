# Visor

Visor is a standalone Electron window with a sample Python class diagram and a local Copilot hook bridge. Step 1 of the [build plan](BUILD_PLAN.md) provides three classes, two arrow relationships, four change entries, method signature and docstring tooltips, and a Settings panel. Step 2 adds authenticated raw event ingestion, session identity, single-instance focusing, and opt-in dev fixture capture.

The diagram and changes list still use the sample fixture. Hook events update the session header and debug list only. Normalization, Python parsing, persistent changes, and live diagrams belong to later steps.

## Run the app

Install Node.js 22.12 or newer and pnpm 10.20.0. From the repository root, run these commands.

```powershell
pnpm install
pnpm --filter desktop dev
```

The command opens Visor and starts a browser preview. Use the localhost URL printed by Vite. If port 5173 is occupied, Vite chooses another port.

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

`pnpm test` builds the hook CLI, runs Vitest, builds the desktop app, and launches the actual Electron app with Playwright. No separate browser download is required. Tests cover the diagram, tooltips, palette, renderer isolation, controls, responsive sizes, server authorization, browser rejection, CLI forwarding and failures, configured launch recovery, redaction, capture ordering, second-instance focusing, and session restoration. Screenshots are in `test-results/` after the UI tests. Tests use temporary data and capture folders and do not create real hook fixtures.

For the visual demo, compare the running window with the Step 1 sketch. Hover over `Cart.add_item` to see its Python signature and docstring. Check that added methods are green, removed methods are red and struck through, and unchanged methods are black without a text background.

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

PascalCase aliases are accepted by the forwarder too. `agentStop` ends a turn, not the session. A future session-lifecycle adapter must use the documented `sessionEnd` event rather than treating every `Stop` as session termination.

Perform the real-session demo after registration.

1. Close Visor.
2. Open `D:\Projects\visor-sandbox` in VS Code, trust the disposable workspace, and select the **Copilot** session target.
3. Start a new agent session. Ask it to create a Python file with a `Cart` class, then edit that class.
4. When Visor opens, open **Settings** and enable **Raw hook capture**. The toggle also captures retained startup events. The header shows the session ID, and the raw list shows events in arrival order.
5. Let the agent finish its turn. Confirm that the capture folder has at least one file for each registered event.
6. Start another session. The existing Visor window comes to the front rather than opening a second window.

The Step 2 manual gate remains pending until this real session has been run and its fixtures reviewed. Automated test payloads are simulated and must not be substituted for real captures.

## Raw event capture

The Electron main process binds a free port on `127.0.0.1`, generates a random token, and publishes `{ port, token, pid }` atomically in `%APPDATA%\Visor\runtime.json`. The file is removed on a clean exit. A stale file is checked against authenticated health before use. Do not share this file or its token.

`GET /health` and `POST /hooks/raw` require `Authorization: Bearer <token>` and reject any browser `Origin` header. The renderer receives only a token-free preload API. The browser preview cannot access the hook server or raw debug settings.

The Node `visor-hook` executable accepts an event argument and a JSON object on stdin. It wraps the payload with a UUID, `source: "copilot"`, an event name, and epoch-millisecond `receivedAt`. It checks the runtime, launches the configured desktop app if needed, waits up to three seconds for startup, and posts with a 500 ms timeout. Hook failures emit `{}` and exit zero. A 4.5-second watchdog bounds the invocation, and hook configuration allows five seconds. It never grants or denies tools.

On Windows, startup is dispatched through the desktop shell. This prevents Electron from retaining PowerShell's hook output pipes after the hook exits. The cold-start Electron test checks that the captured hook command completes while Visor remains alive.

In dev builds, **Raw hook capture** saves envelopes to `fixtures/raw-hooks/<event>-<n>.json`. It is off by default. The recent-event buffer holds 200 events. Enabling capture writes the retained events once, then captures new events. Packaged builds disable this capture mode.

Capture redacts common credential fields, common token patterns, transcript paths, and private absolute paths. Files within the supplied workspace retain relative paths. This is not a guarantee that arbitrary prompts or code contain no secrets. Review and sanitize every real capture before committing it. Step 2 does not commit files automatically.

`VISOR_APP_PATH` can override the configured desktop executable. `VISOR_DATA_DIR` and `VISOR_CAPTURE_DIR` provide isolated locations for tests or a disposable dev instance. The default Windows data folder is `%APPDATA%\Visor`.

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
- [apps/desktop/src/renderer/diagram/layout.ts](apps/desktop/src/renderer/diagram/layout.ts) returns fixed positions. ELK can replace it in Step 7.
- The Electron renderer has no Node access. The main process enables `contextIsolation` and `sandbox`, disables `nodeIntegration`, and rejects new windows and navigation.

## Step 2 boundaries

- [packages/bridge/src/index.ts](packages/bridge/src/index.ts) owns raw envelopes, runtime-file schemas, and token-free renderer snapshots. These are transport types, not the normalized Step 3 protocol.
- [apps/hook/src/forward.ts](apps/hook/src/forward.ts) owns stdin validation, runtime discovery, launch recovery, and posting. The executable wrapper still exits zero if the CLI has not been built.
- [apps/hook/src/install.ts](apps/hook/src/install.ts) owns sandbox hook registration.
- [apps/desktop/src/main/hook-server.ts](apps/desktop/src/main/hook-server.ts) owns authenticated HTTP ingestion.
- [apps/desktop/src/main/hook-monitor.ts](apps/desktop/src/main/hook-monitor.ts) owns recent events and dev capture. The renderer gets snapshots through the sandboxed preload, not filesystem or HTTP access.

The reserved directories for the extension, protocol, core, storage, and later fixtures remain empty. Real-session continuation and complete event capture still require manual verification.