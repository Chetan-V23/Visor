# Visor

Step 1 of the [build plan](BUILD_PLAN.md) is a standalone Electron window with a sample Python class diagram. It has three classes, two arrow relationships, four change entries, method signature and docstring tooltips, and a Settings panel.

The changes list selects a fixture entry. It does not replay historical diagrams yet. Hooks, parsing, persistence, and live sessions belong to later steps.

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

## Verify Step 1

```powershell
pnpm typecheck
pnpm test
```

`pnpm test` runs Vitest, builds the desktop app, and launches the actual Electron app with Playwright. No separate browser download is required. UI checks cover the class and edge counts, four changes, mouse and keyboard tooltips, colors, renderer isolation, controls, Settings, and responsive sizes. Screenshots are in `test-results/` after the UI tests.

For the visual demo, compare the running window with the Step 1 sketch. Hover over `Cart.add_item` to see its Python signature and docstring. Check that added methods are green, removed methods are red and struck through, and unchanged methods are black without a text background.

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

The reserved directories for hooks, the extension, protocol, core, storage, and later fixtures are intentionally empty.