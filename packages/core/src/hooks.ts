import { z } from 'zod'
import { hookKind, isFileChangeHook, isHookProvider, rawHookSchema, type HookProvider } from '@visor/bridge'
import { relativePath } from '@visor/bridge/workspace'
import { visorEventSchema, type CodeModel, type VisorEvent } from '@visor/protocol'

export { relativePath } from '@visor/bridge/workspace'

export type Normalization = { ok: true; events: VisorEvent[] } | { ok: false; error: string }
export interface AdapterContext { workspaceRoot: string; workspaceId: string; seq: number }

const payloadSchema = z.object({
  session_id: z.string().min(1).optional(), sessionId: z.string().min(1).optional(),
  timestamp: z.string().optional(), model: z.string().optional(), prompt: z.string().optional(),
  stop_hook_active: z.boolean().optional(), reason: z.string().nullable().optional(),
  tool_name: z.string().optional(), toolName: z.string().optional(),
  tool_use_id: z.string().optional(), toolCallId: z.string().optional(),
  tool_input: z.json().optional(), toolInput: z.json().optional(), tool_response: z.json().optional()
}).passthrough()
const inputSchema = z.object({
  filePath: z.string().optional(), file_path: z.string().optional(), path: z.string().optional(), notebook_path: z.string().optional(),
  input: z.string().optional(), command: z.string().optional(), edits: z.array(z.json()).optional(),
  replacements: z.array(z.object({ filePath: z.string().optional(), file_path: z.string().optional() }).passthrough()).optional()
}).passthrough()
const snippetSchema = z.object({
  explanation: z.string().optional(), content: z.string().optional(), contents: z.string().optional(),
  text: z.string().optional(), code: z.string().optional(), oldString: z.string().optional(), newString: z.string().optional(),
  old_string: z.string().optional(), new_string: z.string().optional(), new_source: z.string().optional()
}).strip()

const hookAdapters = {
  copilot: { patchField: 'input', postUseImpliesSuccess: false },
  codex: { patchField: 'command', postUseImpliesSuccess: false },
  'claude-code': { patchField: 'input', postUseImpliesSuccess: true }
} satisfies Record<HookProvider, {
  patchField: 'input' | 'command'
  postUseImpliesSuccess: boolean
}>

export function mentionedClassIds(value: unknown, context: { workspaceRoot: string; files: string[]; models: CodeModel[] }): string[] {
  const raw = rawHookSchema.safeParse(value)
  if (!raw.success || !isFileChangeHook(raw.data)) return []
  const { source } = raw.data
  if (!isHookProvider(source)) return []
  const payload = payloadSchema.safeParse(raw.data.payload)
  if (!payload.success) return []
  const input = inputSchema.safeParse(payload.data.tool_input ?? payload.data.toolInput)
  if (!input.success) return []
  const namesByFile = new Map(context.files.map((file) => [file, new Set<string>()]))
  const addText = (file: string | null, text: string): void => {
    const names = file ? namesByFile.get(file) : undefined
    if (names) for (const name of text.match(/[A-Za-z_]\w*/g) ?? []) names.add(name)
  }
  const addSnippet = (file: string | null, value: unknown): void => {
    const snippet = snippetSchema.safeParse(value)
    if (snippet.success) for (const text of Object.values(snippet.data)) if (text) addText(file, text)
  }
  const patch = input.data[hookAdapters[source].patchField]
  if (patch) {
    let file: string | null = null
    for (const line of patch.split(/\r?\n/)) {
      const header = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
      if (header?.[1]) file = relativePath(header[1].trim(), context.workspaceRoot)
      else if (!line.startsWith('*** ')) addText(file, line)
    }
  }
  for (const replacement of input.data.replacements ?? []) addSnippet(relativePath(replacement.filePath ?? replacement.file_path ?? '', context.workspaceRoot), replacement)
  const file = relativePath(input.data.filePath ?? input.data.file_path ?? input.data.path ?? input.data.notebook_path ?? '', context.workspaceRoot)
  addSnippet(file, input.data)
  if ((payload.data.tool_name ?? payload.data.toolName) === 'MultiEdit') {
    for (const edit of input.data.edits ?? []) addSnippet(file, edit)
  }
  if (typeof input.data.explanation === 'string') for (const path of context.files) addText(path, input.data.explanation)
  const classes = new Map(context.models.flatMap((model) => model.classes.map((symbol) => [symbol.id, symbol] as const)))
  const byName = new Map<string, CodeModel['classes']>()
  const owners = new Map<string, string>()
  for (const symbol of classes.values()) {
    const name = symbol.name.split('.').at(-1) ?? symbol.name
    const matches = byName.get(name) ?? []
    matches.push(symbol)
    byName.set(name, matches)
    for (const id of [symbol.id, ...symbol.methods.map((method) => method.id), ...symbol.fields.map((field) => field.id)]) owners.set(id, symbol.id)
  }
  const result = new Set<string>()
  for (const [path, names] of namesByFile) {
    const linked = new Set(context.models.flatMap((model) => model.relations.filter((relation) => classes.get(owners.get(relation.from) ?? '')?.file === path).map((relation) => owners.get(relation.to))))
    for (const name of names) {
      const candidates = byName.get(name) ?? []
      const local = candidates.filter((symbol) => symbol.file === path)
      if (local.length) {
        for (const symbol of local) result.add(symbol.id)
        continue
      }
      const related = candidates.filter((symbol) => linked.has(symbol.id))
      const match = related.length === 1 ? related[0] : candidates.length === 1 ? candidates[0] : undefined
      if (match) result.add(match.id)
    }
  }
  return [...result]
}

export function normalizeHook(value: unknown, context: AdapterContext, expectedSource?: HookProvider): Normalization {
  try {
    const raw = rawHookSchema.safeParse(value)
    if (!raw.success) return { ok: false, error: 'Invalid hook envelope.' }
    const { source } = raw.data
    if (!isHookProvider(source) || (expectedSource && expectedSource !== source)) {
      return { ok: false, error: 'Unsupported hook provider.' }
    }
    const payload = payloadSchema.safeParse(raw.data.payload)
    if (!payload.success) return { ok: false, error: 'Invalid hook fields.' }
    const data = payload.data
    const kind = hookKind(raw.data)
    if (!kind || ((kind === 'edit.pending' || kind === 'edit.applied') && !isFileChangeHook(raw.data))) return { ok: true, events: [] }
    const sessionId = data.session_id ?? data.sessionId
    if (!sessionId) return { ok: false, error: 'A normalized event needs a session identity.' }
    const clock = z.iso.datetime().safeParse(data.timestamp)
    const base = {
      v: 1, id: raw.data.id, source, sessionId, seq: context.seq,
      ts: raw.data.receivedAt, ...(clock.success ? { agentTimestamp: clock.data } : {})
    }
    let event: unknown
    if (kind === 'session.started') event = { ...base, kind: 'session.started', payload: { workspaceId: context.workspaceId, ...(data.model ? { model: data.model } : {}) } }
    else if (kind === 'session.ended') event = { ...base, kind: 'session.ended', payload: { reason: data.reason ?? null } }
    else if (kind === 'prompt.submitted') event = { ...base, kind: 'prompt.submitted', payload: { text: data.prompt } }
    else if (kind === 'turn.ended') event = { ...base, kind: 'turn.ended', payload: { stopHookActive: data.stop_hook_active } }
    else {
      const tool = data.tool_name ?? data.toolName
      const input = inputSchema.safeParse(data.tool_input ?? data.toolInput)
      if (!input.success) return { ok: false, error: 'Invalid file-changing tool input.' }
      let candidates: string[]
      const response = z.object({ isError: z.boolean().optional(), success: z.boolean().optional(), type: z.string().optional() }).safeParse(data.tool_response)
      const created = tool === 'create_file' || tool === 'create_new_jupyter_notebook'
        || (tool === 'Write' && response.success && response.data.type === 'create')
      let intent: 'create' | 'edit' | 'delete' | 'rename' = created ? 'create' : 'edit'
      if (tool === 'apply_patch') {
        const patch = input.data[hookAdapters[source].patchField] ?? ''
        const operations = [...patch.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)\r?$/gm)]
        candidates = operations.map((operation) => operation[2]?.trim() ?? '')
        if (operations.some((operation) => operation[1] === 'Move to')) intent = 'rename'
        else if (operations.length && operations.every((operation) => operation[1] === 'Add File')) intent = 'create'
        else if (operations.length && operations.every((operation) => operation[1] === 'Delete File')) intent = 'delete'
      } else if (tool === 'multi_replace_string_in_file') {
        candidates = input.data.replacements?.map((item) => item.filePath ?? item.file_path ?? '') ?? []
      } else candidates = [input.data.filePath ?? input.data.file_path ?? input.data.path ?? input.data.notebook_path ?? '']
      const files = candidates.map((candidate) => relativePath(candidate, context.workspaceRoot))
      if (!files.length || files.some((file) => file === null)) return { ok: false, error: 'Tool paths must stay inside the workspace.' }
      const failed = response.success && (response.data.isError === true || response.data.success === false)
      const succeeded = hookAdapters[source].postUseImpliesSuccess
        || (response.success && (response.data.success === true || response.data.isError === false))
      const outcome = failed ? 'failed' : succeeded ? 'succeeded' : 'unknown'
      const toolCallId = data.tool_use_id ?? data.toolCallId
      const edit = { tool, files: [...new Set(files)], intent, ...(toolCallId ? { toolCallId } : {}) }
      event = kind === 'edit.pending' ? { ...base, kind: 'edit.pending', payload: edit }
        : { ...base, kind: 'edit.applied', payload: { ...edit, outcome } }
    }
    const parsed = visorEventSchema.safeParse(event)
    return parsed.success ? { ok: true, events: [parsed.data] } : { ok: false, error: 'Hook does not satisfy the v1 event contract.' }
  } catch { return { ok: false, error: 'Malformed hook input.' } }
}
