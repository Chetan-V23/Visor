# Visor Companion

The companion supplies VS Code language-server definitions to the local Visor app. Visor owns parsing, relationship classification, snapshots, and history. The companion sends file hashes and source locations, not file contents or hook events.

## Install

From the repository root, run `npx --yes pnpm@10.20.0 --filter visor-companion package`. In VS Code, run **Extensions: Install from VSIX** and select `apps/companion/visor-companion.vsix`. Enable the extension in the trusted workspace that Visor observes.

Open Visor and edit a supported file, or run **Visor: Refresh Code Relationships**. The companion requests definitions from the provider configured for that file in VS Code. For Python it requests type definitions first. If Visor uses a custom data folder, set the machine-scoped `visor.dataFolder` setting to that folder.

## Limits

The companion watches local Python, JavaScript, TypeScript, JSX, TSX, C#, and C++ source files. It requests at most 512 reference positions per file. Each provider call has a 1.5-second wait limit; the provider loop has a 10-second budget per file. The workspace refresh command shows cancellable progress. These limits stop waiting for providers; they do not cancel a language server's internal work.

Both source and target versions must already exist in Visor's saved snapshots. Dirty documents and targets outside the workspace are excluded. Target versions are rechecked before facts are posted. A save during an in-flight refresh schedules another refresh. Missing providers, unavailable Visor, and mismatched or ambiguous versions leave source-only analysis intact. Ownership remains inferred where code does not establish it. Static signal connections do not prove runtime delivery.

File watchers refresh definitions for saved versions only. They do not create change history for external edits. Electron tests cover semantic queries, accepted and stale facts, and historical matching. Packaging does not verify a live Pylance, JS/TS, C#, or C++ provider in a VS Code extension host.

The companion never launches or focuses Visor. Runtime credentials stay in the extension host and are not exposed to the renderer or output channel.