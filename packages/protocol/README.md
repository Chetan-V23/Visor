# Visor graph and history formats

## Version 2 graph snapshots

New SQLite `model_after_json` rows contain `{ v: 2, symbols, relations }`. Each symbol has a language, a kind, an ID, an optional owner represented by `ownerId`, and one or more workspace-relative locations. A location identifies a declaration or definition. Relations refer to symbol IDs; a missing target is not a graph edge. The diagram groups callables and fields by owner without changing their IDs.

JS and TS IDs use the module file as scope. C# and C++ use project and lexical scope, including overload parameter types. Locations can move without changing an ID. For example, `cpp:@workspace::Calc.get(int) const` can have a declaration in `calc.hpp` and a definition in `calc.cpp`. A body edit shows `calc.cpp` on the class card. Hovering over the method shows the saved implementation. A rename or an overload identity change can appear as a removal and an addition.

The optional `analysisVersion` identifies the analyzer that built a graph, independently of the storage format `v`. When an older C++ graph has saved source, the desktop app can rebuild its diagram and method changes from those snapshots. It does not read the current working files or rewrite the stored graph.

The store reads each snapshot by its version without migrating existing rows. It accepts both v1 and v2 change documents. Hook envelopes remain v1; the optional `mentionedSymbols` field carries resolved non-Python IDs. The [schemas](src/index.ts) and [projection](src/projection.ts) define the storage and diagram boundaries. The following sections describe the original v1 contracts, which remain readable.

This package defines the documents that Visor stores and projects into its UI. It implements Step 3 of the [build plan](../../BUILD_PLAN.md), using the real Step 2 captures and decisions D1-D7 in the [feasibility report](../../FEASIBILITY_REPORT.md).

The package exports Zod schemas, schema-derived TypeScript types, adapter interfaces, and `protocolJsonSchemas()`. It has no Electron, React, filesystem, network, or database dependency. Raw transport envelopes remain in [packages/bridge/src/index.ts](../bridge/src/index.ts). Normalization and extraction are implemented in [packages/core/src/index.ts](../core/src/index.ts).

## Decisions

| Decision | v1 contract |
| --- | --- |
| One changes-bar entry | One completed file-changing tool call, anchored by its `PostToolUse` envelope. `PreToolUse` is intent, not another change. Read/search/diagnostic calls never create changes. |
| External edits | In the same session, external edits that touch the same files within 2,000 ms can join the anchored change. Preserve their event IDs in `cause.relatedEventIds`. External-only batches use `cause.eventIds`. Separate tool calls remain separate changes. This policy is implemented in a later pipeline, not here. |
| Symbol IDs | `<language>:<workspace-relative path>::<qualified symbol>`. Prefixes are `py`, `cpp`, and `cs`. For example, `py:src/shop/cart.py::Cart.add_item`. Nested scopes use dots. A rename changes the ID. The protocol supports `node.rename`, but the current differ reports removal and addition until rename matching is implemented. Overload identity needs a documented extension before C++ extraction. |
| Paths | Workspace-relative file paths with forward slashes. Reject absolute paths, drive prefixes, backslashes, control characters, traversal, dot segments, empty segments, and trailing slashes. The live app resolves and confines external paths against its known workspace root before schema validation. |
| Time | `ts` is the Step 2 envelope's `receivedAt`, assigned by Visor's forwarder on ingress. Retain the agent's ISO timestamp separately as `agentTimestamp`. Do not replace ingress time with the agent's clock or the replay clock. |
| Order | The app assigns monotonically increasing event `seq` values per session after deduplication. Changes have a separate per-session sequence. Change 0 is a baseline; ordinary changes start at 1. Arrival order, not timestamp sorting, determines event order. |
| Event IDs | Preserve the Step 2 envelope UUID as `VisorEvent.id`. A resend retains its ID and does not receive a new sequence. v1 emits at most one normalized event per raw hook. Separate confirmed filesystem events receive their own IDs. A tool change can reuse its post-tool event UUID as `Change.id`. |
| Versioning | Persisted roots (`VisorEvent`, `CodeModel`, `FileModel`, `Change`, `SessionSummary`) and every delta carry `v: 1`. Embedded symbols and relations inherit that version. Added optional fields keep v1. Readers ignore unknown object fields. Changes to required fields, meanings, ID grammar, kinds, or operations require a new version. Unknown versions and discriminants are rejected. |

Project identity comes from the app's workspace context. The protocol does not contain an absolute project root, runtime token, transcript path, or database path. D7 keeps runtime and history storage outside the user's repository.

## Captured fields

[examples/raw-field-map.json](examples/raw-field-map.json) maps the original reviewed capture set to its source fields. The test verifies that those captures and mapped fields still exist. Step 4's [normalization manifest](../../fixtures/normalized/manifest.json) fixes the larger reviewed golden set; new captures are reviewed and added with `pnpm fixtures:update` rather than making an actively growing capture directory a flaky test dependency.

| Needed value | Observed source | Rule |
| --- | --- | --- |
| Event ID, agent, ingress time | `id`, `source`, `receivedAt` | Preserve the envelope values. |
| Session ID | `payload.session_id` | The capture uses snake_case. The adapter also supports `sessionId`. |
| Agent clock | `payload.timestamp` | Store as optional `agentTimestamp`. |
| Workspace | `payload.cwd` | Captures contain `<workspace>`, not a recoverable root. The live app supplies workspace identity and path context. |
| First prompt | `payload.prompt` | Preserve as text. A missing prompt remains unknown; do not invent a title. |
| Tool name | `payload.tool_name` | Also support `toolName` at the boundary. Use the shared file-change policy, not a substring match. |
| Tool call correlation | `payload.tool_use_id` | Pre/post envelope IDs differ. This field pairs the calls. |
| Create-file path and text | `payload.tool_input.filePath`, `payload.tool_input.content` | The observed `create_file` event is pending intent, not proof of creation. |
| Patch paths | Operation headers inside `payload.tool_input.input` | The captured `apply_patch` payload has no direct file-path field. Step 4 parses update/add/delete/move headers and normalizes paths. Do not search arbitrary patch body text for paths. |
| Diagnostic file list | `payload.tool_input.filePaths` | The captured `get_errors` call is read-only. Emit no edit event or change. |
| Tool outcome | `payload.tool_response` | Both captured responses are empty. Use `outcome: "unknown"`; an empty response is not evidence of success. |
| Turn end | `payload.stop_hook_active` | `agentStop` / `Stop` maps to `turn.ended`, not `session.ended`. |

The adapter accepts `tool_input` and `toolInput`. It does not currently accept `toolArgs`. Replacement and multi-replacement support has dedicated synthetic boundary tests. Those tests are not real captures.

The captured patch includes a redacted workspace marker and redacted file contents. It can test field locations and parsing shape, but cannot reconstruct the original private root or source bytes. Never use it to claim a complete source snapshot.

## Lifecycle and missing observations

Visor auto-opens only for file-changing tool calls. If it was closed, earlier session-start and prompt hooks were dropped. `SessionSummary.startObserved` is then `false`; `startedAt` records the first observed ingress time, and `title` stays `null` until a prompt is observed.

The pipeline records baseline 0 at an observed session start or before the first observed edit. `cause.observedAt` distinguishes `session-start`, `before-first-edit`, and `after-first-edit`. A post-tool recovery baseline is not the session's true before-state. Do not invent a `session.started` event to hide that gap.

No capture provides a session-end signal. `session.ended` is reserved for an explicit future session-end hook or companion signal. Its `reason` is nullable when unknown. `turn.ended` leaves the session available for later turns.

## Documents

The authoritative shapes are in [src/index.ts](src/index.ts). All public TypeScript document types derive from their schemas.

| Document | Contents |
| --- | --- |
| `VisorEvent` | `{ v, id, sessionId, seq, ts, source, kind, payload, agentTimestamp? }`. Payloads discriminate by kind. |
| `CodeModel` | Current workspace classes and relations. IDs are unique; relation endpoints must resolve to a class, method, or field in the model. |
| `FileModel` | One language/file's classes, free functions, and import names. Free-function IDs use the same file namespace. Unresolved imports remain names, not invented graph endpoints. |
| `ClassSymbol` | `{ id, name, file, range, bases, methods, fields }`. Member IDs belong to their class, and the embedded path matches `file`. |
| `MethodSymbol` | `{ kind: "method", id, name, signature, docstring, range, bodyHash, displayName? }`. `displayName` is optional presentation metadata, not a parsed signature. |
| `FieldSymbol` | `{ kind: "field", id, name, type, range, initializerHash? }`. Unknown types are `null`. The optional LF-normalized initializer hash detects value-only changes without storing initializer values in the model. |
| `Relation` | `{ from, to, kind, certainty, label?, data? }`. Kinds are `inherits`, `composes`, `calls`, and `imports`. Optional data holds parameter and return types for D5. Unknown types are `null`; certainty is `declared`, `inferred`, or `unknown`. |
| `Change` | `{ v, id, sessionId, seq, ts, cause, summary, files, delta }`. Causes are tool, external, or baseline. A file entry stores its path, before/after hashes, and added/deleted line counts. |
| `GraphDelta` | Versioned node, member, edge, or code-hunk operation. See below. |
| `SessionSummary` | Versioned session ID, nullable title, observed start time, start-observation flag, and non-sensitive project metadata. |

Ranges use 1-based lines, 0-based UTF-16 columns, and an exclusive end. The end cannot precede the start. Tree-sitter byte columns must be converted by the extractor. Unknown ranges are `null`, not invented coordinates.

`bodyHash` is lowercase SHA-256 of the method body after LF normalization. Before/after file hashes identify the exact UTF-8 content stored as blobs. Unknown hashes are `null`. The sample fixture has no source bodies, so it deliberately has no hashes.

### Event kinds

`session.started`, `session.ended`, `turn.ended`, `prompt.submitted`, `edit.pending`, `edit.applied`, `file.created`, `file.deleted`, and `file.renamed`.

`edit.pending` identifies a tool, affected files, optional tool-call ID, and create/edit/delete/rename intent. `edit.applied` adds a required `succeeded`, `failed`, or `unknown` outcome. Its name records tool completion, not proof of a semantic delta. A failed call creates no change; unknown outcomes require a disk-state check. The separate `file.*` kinds require confirmed file observations.

### Delta operations

- `node.add` carries the new class and optional `insertedBetween: [from, to]` for D6 choreography.
- `node.remove` carries the prior class, preserving removed tooltips and animation content.
- `node.rename` carries old and new IDs.
- `member.add` and `member.remove` carry the owning class ID and the member document.
- `member.change` carries the owning class ID and before/after members with the same identity and kind. This preserves D6 change metadata rather than mislabeling a modification as an addition.
- `edge.add` and `edge.remove` carry a complete relation, including optional D5 type data.
- `code.hunks` carries a relative file path, optional symbol ID, and hunks for D5's later code-level view. Each hunk has old/new start and count fields and typed context/added/deleted lines. A changed declaration with an unresolved base can carry an empty hunk list and a class ID: it marks a semantic change without inventing source lines or a dangling edge. File snapshots supply actual textual hunks separately.

## Integration boundaries

`HarnessAdapter<Raw>` exposes `source` and `toEvents(raw): VisorEvent[]`. Its typed input can include app-assigned sequencing and workspace context. The Step 4 boundary returns a structured error for malformed external input before calling the typed adapter. The adapter never reads files or assigns session ordering itself.

`LanguageExtractor` exposes `language`, `matches(path)`, and `extract(path, text): FileModel`. Python uses `py`; C++ and C# register separate extractors later. Syntax-error recovery belongs to Step 4, not this schema package.

[protocol-adapter.ts](../../apps/desktop/src/renderer/diagram/protocol-adapter.ts) implements `toDiagramView(model, change)` as the classes and edges projection of `DiagramView`. It derives highlights from deltas, retains removed members, collapses member-level relation endpoints to their owning class, and marks changed classes for the glow renderer. It does not mutate protocol documents.

[fixture-source.ts](../../apps/desktop/src/renderer/diagram/fixture-source.ts) validates the sample for browser-only previews. It remains the only production module importing the sample JSON. [history-source.ts](../../apps/desktop/src/renderer/diagram/history-source.ts) loads stored snapshots in Electron and combines the projection with actual session metadata and newest-first summaries. Components consume `DiagramView`, not protocol schemas.

## Validation and examples

[examples/documents.json](examples/documents.json) contains valid and invalid examples for all public document families, all event kinds, and all delta operations. These examples are illustrative contracts, not golden normalizer results. Real raw fixtures remain unchanged; [fixtures/normalized](../../fixtures/normalized) belongs to Step 4.

Run the focused checks from the repository root.

```powershell
npx --yes pnpm@10.20.0 exec vitest run packages/protocol/src/index.test.ts apps/desktop/src/renderer/diagram/diagram.test.ts
npx --yes pnpm@10.20.0 typecheck
npx --yes pnpm@10.20.0 test
```

`protocolJsonSchemas()` exports all ten public schema families as serializable draft-2020-12 JSON Schemas in input mode. Input schemas permit additive fields. Cross-field checks, including range ordering and reference integrity, remain Zod refinements and are not fully expressed by JSON Schema. Consumers must run the Zod schemas for authoritative validation.

The capture-mapping test detects missing reviewed captures. The golden manifest records reviewed additions. Neither check verifies secrets in arbitrary source text. Review captured content and generated goldens before committing them.