import { posix, win32 } from 'node:path'
import { z } from 'zod'
import { isFileChangeHook, rawHookSchema } from '@visor/bridge'
import { pathSchema, visorEventSchema, type HarnessAdapter, type VisorEvent } from '@visor/protocol'

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
  filePath: z.string().optional(), file_path: z.string().optional(), path: z.string().optional(),
  input: z.string().optional(),
  replacements: z.array(z.object({ filePath: z.string().optional(), file_path: z.string().optional() }).passthrough()).optional()
}).passthrough()

export function relativePath(candidate: string, workspaceRoot: string): string | null {
  if (candidate.split(/[\\/]/).includes('..') || /[\u0000-\u001f]/.test(candidate)) return null
  const paths = win32.isAbsolute(workspaceRoot) && !workspaceRoot.startsWith('/') ? win32 : posix
  const root = workspaceRoot.replace(/\\/g, '/')
  const file = candidate.replace(/\\/g, '/')
  if (paths === posix && win32.isAbsolute(file) && !posix.isAbsolute(file)) return null
  const resolved = paths.isAbsolute(file) || (!paths.isAbsolute(root) && file.startsWith(`${root}/`))
    ? paths.resolve(file) : paths.resolve(root, file)
  const relative = paths.relative(paths.resolve(root), resolved).replace(/\\/g, '/')
  const parsed = pathSchema.safeParse(relative)
  return parsed.success ? parsed.data : null
}

export class CopilotAdapter implements HarnessAdapter<unknown> {
  readonly source = 'copilot'
  constructor(private readonly context: AdapterContext) {}

  toEvents(raw: unknown): VisorEvent[] {
    const result = this.normalize(raw)
    return result.ok ? result.events : []
  }

  normalize(value: unknown): Normalization {
    try {
      const raw = rawHookSchema.safeParse(value)
      if (!raw.success || raw.data.source !== this.source) return { ok: false, error: 'Invalid Copilot hook envelope.' }
      const payload = payloadSchema.safeParse(raw.data.payload)
      if (!payload.success) return { ok: false, error: 'Invalid Copilot hook fields.' }
      const data = payload.data
      const name = raw.data.event.toLowerCase()
      if (!['sessionstart', 'sessionend', 'sessionended', 'userpromptsubmitted', 'agentstop', 'stop'].includes(name) && !isFileChangeHook(raw.data)) return { ok: true, events: [] }
      const sessionId = data.session_id ?? data.sessionId
      if (!sessionId) return { ok: false, error: 'A normalized event needs a session identity.' }
      const clock = z.iso.datetime().safeParse(data.timestamp)
      const base = {
        v: 1, id: raw.data.id, source: this.source, sessionId, seq: this.context.seq,
        ts: raw.data.receivedAt, ...(clock.success ? { agentTimestamp: clock.data } : {})
      }
      let event: unknown
      if (name === 'sessionstart') event = { ...base, kind: 'session.started', payload: { workspaceId: this.context.workspaceId, ...(data.model ? { model: data.model } : {}) } }
      else if (name === 'sessionend' || name === 'sessionended') event = { ...base, kind: 'session.ended', payload: { reason: data.reason ?? null } }
      else if (name === 'userpromptsubmitted') event = { ...base, kind: 'prompt.submitted', payload: { text: data.prompt } }
      else if (name === 'agentstop' || name === 'stop') event = { ...base, kind: 'turn.ended', payload: { stopHookActive: data.stop_hook_active } }
      else {
        const tool = data.tool_name ?? data.toolName
        const input = inputSchema.safeParse(data.tool_input ?? data.toolInput)
        if (!input.success) return { ok: false, error: 'Invalid file-changing tool input.' }
        let candidates: string[]
        let intent: 'create' | 'edit' | 'delete' | 'rename' = tool === 'create_file' || tool === 'create_new_jupyter_notebook' ? 'create' : 'edit'
        if (tool === 'apply_patch') {
          const operations = [...(input.data.input ?? '').matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)\r?$/gm)]
          candidates = operations.map((operation) => operation[2]?.trim() ?? '')
          if (operations.some((operation) => operation[1] === 'Move to')) intent = 'rename'
          else if (operations.length && operations.every((operation) => operation[1] === 'Add File')) intent = 'create'
          else if (operations.length && operations.every((operation) => operation[1] === 'Delete File')) intent = 'delete'
        } else if (tool === 'multi_replace_string_in_file') {
          candidates = input.data.replacements?.map((item) => item.filePath ?? item.file_path ?? '') ?? []
        } else candidates = [input.data.filePath ?? input.data.file_path ?? input.data.path ?? '']
        const files = candidates.map((candidate) => relativePath(candidate, this.context.workspaceRoot))
        if (!files.length || files.some((file) => file === null)) return { ok: false, error: 'Tool paths must stay inside the workspace.' }
        const response = z.object({ isError: z.boolean().optional(), success: z.boolean().optional() }).safeParse(data.tool_response)
        const outcome = response.success && (response.data.isError === true || response.data.success === false) ? 'failed'
          : response.success && (response.data.success === true || response.data.isError === false) ? 'succeeded' : 'unknown'
        const toolCallId = data.tool_use_id ?? data.toolCallId
        const edit = { tool, files: [...new Set(files)], intent, ...(toolCallId ? { toolCallId } : {}) }
        event = name === 'pretooluse' ? { ...base, kind: 'edit.pending', payload: edit }
          : { ...base, kind: 'edit.applied', payload: { ...edit, outcome } }
      }
      const parsed = visorEventSchema.safeParse(event)
      return parsed.success ? { ok: true, events: [parsed.data] } : { ok: false, error: 'Hook does not satisfy the v1 event contract.' }
    } catch { return { ok: false, error: 'Malformed hook input.' } }
  }
}