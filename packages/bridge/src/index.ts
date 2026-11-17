import { z } from 'zod'
import { changeSchema, codeModelSchema, type Change, type SessionSummary, type VisorEvent } from '@visor/protocol'

export const MAX_HOOK_BYTES = 1024 * 1024
export const MAX_RECENT_EVENTS = 200

export const rawPayloadSchema = z.record(z.string(), z.json())
export const rawHookSchema = z.object({
  id: z.uuid(),
  source: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  event: z.string().regex(/^[A-Za-z][A-Za-z0-9.]{0,63}$/),
  receivedAt: z.number().int().nonnegative(),
  payload: rawPayloadSchema
}).strict()

export const runtimeSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive()
}).strict()

export const appConfigSchema = z.object({
  appPath: z.string().min(1),
  appArgs: z.array(z.string()).default([])
})

export type RawHook = z.infer<typeof rawHookSchema>
export type Runtime = z.infer<typeof runtimeSchema>
export type AppConfig = z.infer<typeof appConfigSchema>

export interface HookSnapshot {
  sessionId: string | null
  port: number
  dataFolder: string
  devMode: boolean
  debugEnabled: boolean
  captureFolder: string | null
  captureError: string | null
  events: RawHook[]
  normalizedEvents?: VisorEvent[]
  normalizationError?: string | null
}

export interface HookBridge {
  getSnapshot(): Promise<HookSnapshot>
  setDebugEnabled(enabled: boolean): Promise<HookSnapshot>
  onSnapshot(callback: (snapshot: HookSnapshot) => void): () => void
}

export const historySnapshotSchema = z.object({ change: changeSchema, model: codeModelSchema }).strip()
export type HistorySnapshot = z.infer<typeof historySnapshotSchema>
export const methodCodeRequestSchema = z.object({ changeId: z.uuid(), methodId: z.string().min(1).max(2048) }).strict()
export const methodCodeSchema = z.object({
  file: z.string(),
  lines: z.array(z.object({ kind: z.enum(['unchanged', 'added', 'deleted']), text: z.string() }))
}).strip()
export type MethodCode = z.infer<typeof methodCodeSchema>
export interface HistoryBridge {
  listSessions(): Promise<SessionSummary[]>
  listChanges(sessionId: string): Promise<Change[]>
  getChange(id: string): Promise<HistorySnapshot | null>
  getMethodCode(request: z.infer<typeof methodCodeRequestSchema>): Promise<MethodCode | null>
  onChangeAdded(callback: (change: Change) => void): () => void
  onSessionsChanged(callback: () => void): () => void
}

export const sessionIdentitySchema = z.object({
  sessionId: z.string().min(1).max(512).optional(),
  session_id: z.string().min(1).max(512).optional()
}).passthrough()

export function sessionIdFrom(raw: RawHook): string | null {
  const parsed = sessionIdentitySchema.safeParse(raw.payload)
  return parsed.success ? parsed.data.sessionId ?? parsed.data.session_id ?? null : null
}

export function isSessionStart(event: string): boolean {
  return event === 'sessionStart' || event === 'SessionStart'
}

const fileChangeEvents = new Set(['preToolUse', 'PreToolUse', 'postToolUse', 'PostToolUse'])
const fileChangeTools = new Set([
  'create_file', 'replace_string_in_file', 'multi_replace_string_in_file',
  'insert_edit_into_file', 'apply_patch', 'edit_file',
  'edit_notebook_file', 'create_new_jupyter_notebook', 'vscode_renameSymbol'
])

export function isFileChangeHook(raw: RawHook): boolean {
  const toolName = raw.payload.toolName ?? raw.payload.tool_name
  return fileChangeEvents.has(raw.event) && typeof toolName === 'string' && fileChangeTools.has(toolName)
}