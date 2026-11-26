import { lstatSync, readFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { rawHookSchema, type RawHook } from './index'
import { writeJsonAtomic } from './node'
import { readSourceSync, scanSources, snapshotPolicy, sourceSnapshotSchema, workspaceRoot } from './workspace'

const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const pendingHookSchema = z.object({
  v: z.literal(1),
  raw: rawHookSchema,
  captured: z.array(sourceSnapshotSchema).max(64),
  baseline: z.array(sourceSnapshotSchema).max(500).optional()
}).strict().refine((hook) => [...hook.captured, ...hook.baseline ?? []].reduce((bytes, file) => bytes + Buffer.byteLength(file.text ?? '', 'utf8'), 0) <= MAX_SNAPSHOT_BYTES)
export type PendingHook = z.infer<typeof pendingHookSchema>

export async function savePendingHook(folder: string, raw: RawHook, paths: string[]): Promise<void> {
  if (paths.length > 64) throw new Error('Tool snapshot exceeds the file limit.')
  const root = workspaceRoot(raw.payload.cwd)
  const allowed = snapshotPolicy(root)
  const captured = paths.filter((path) => allowed(path)).map((path) => ({ path, text: readSourceSync(root, path) }))
  const bytes = captured.reduce((size, file) => size + Buffer.byteLength(file.text ?? '', 'utf8'), 0)
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Tool snapshot exceeds the byte limit.')
  const baseline = raw.event.toLowerCase() === 'pretooluse' ? await scanSources(root, MAX_SNAPSHOT_BYTES - bytes) : undefined
  const pending = pendingHookSchema.parse({ v: 1, raw, captured, baseline })
  await writeJsonAtomic(join(folder, 'pending-hooks', `${raw.id}.json`), pending)
}

export function readPendingHook(folder: string, id: string): PendingHook | null {
  const identity = rawHookSchema.shape.id.safeParse(id)
  if (!identity.success) return null
  try {
    const path = join(folder, 'pending-hooks', `${identity.data}.json`)
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.size > 128 * 1024 * 1024) return null
    const hook = pendingHookSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (hook.raw.id !== id) return null
    const allowed = snapshotPolicy(workspaceRoot(hook.raw.payload.cwd))
    if (![...hook.captured, ...hook.baseline ?? []].every((file) => allowed(file.path))) return null
    return hook
  } catch { return null }
}

export async function listPendingHooks(folder: string): Promise<PendingHook[]> {
  let names: string[]
  try { names = await readdir(join(folder, 'pending-hooks')) } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  return names.flatMap((name) => {
    if (!name.endsWith('.json')) return []
    const hook = readPendingHook(folder, name.slice(0, -5))
    return hook ? [hook] : []
  }).sort((left, right) => left.raw.receivedAt - right.raw.receivedAt || left.raw.id.localeCompare(right.raw.id))
}

export async function removePendingHook(folder: string, id: string): Promise<void> {
  await rm(join(folder, 'pending-hooks', `${rawHookSchema.shape.id.parse(id)}.json`), { force: true })
}