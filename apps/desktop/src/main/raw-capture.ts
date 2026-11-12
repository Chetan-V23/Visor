import { readdir } from 'node:fs/promises'
import { isAbsolute, join, posix, win32 } from 'node:path'
import type { RawHook } from '@visor/bridge'
import { writeJsonAtomic } from '@visor/bridge/node'

type JsonValue = RawHook['payload'][string]

function sanitizeText(text: string, workspace: string): string {
  let value = text
  if (workspace.length > 1) {
    for (const root of [workspace, workspace.replaceAll('\\', '/')]) {
      value = value.replaceAll(root, '<workspace>')
    }
  }
  return value
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s"'<>]+/g, '<path>')
    .replace(/(^|[\s"'=])\/(?:Users|home|tmp|var|etc|mnt|Volumes|workspace)\/[^\s"'<>]+/g, '$1<path>')
    .replace(/((?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer <redacted>')
}

function sanitizeValue(value: JsonValue, workspace: string, key = ''): JsonValue {
  if (/authorization|password|passwd|secret|token|api[_-]?key|credential|cookie|private[_-]?key/i.test(key)) return '<redacted>'
  if (typeof value === 'string') {
    if (/transcript[_-]?path/i.test(key)) return '<path>'
    if (/^(cwd|workspaceRoot|workspace_root|path|filePath|file_path)$/i.test(key)) {
      if (value === workspace) return '<workspace>'
      const paths = win32.isAbsolute(value) && /^[A-Za-z]:/.test(value) ? win32 : posix
      if (paths.isAbsolute(value) || isAbsolute(value)) {
        const relative = workspace ? paths.relative(workspace, value) : '..'
        return !relative.startsWith('..') && !paths.isAbsolute(relative) ? relative.replaceAll('\\', '/') : '<path>'
      }
    }
    return sanitizeText(value, workspace)
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, workspace))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, entry]) => [childKey, sanitizeValue(entry, workspace, childKey)]))
  }
  return value
}

export function sanitizeRaw(raw: RawHook): RawHook {
  const workspace = typeof raw.payload.cwd === 'string' ? raw.payload.cwd : ''
  const payload = Object.fromEntries(Object.entries(raw.payload).map(([key, value]) => [key, sanitizeValue(value, workspace, key)]))
  return { ...raw, payload }
}

export async function captureRaw({ raw, folder }: { raw: RawHook; folder: string }): Promise<void> {
  let names: string[] = []
  try { names = await readdir(folder) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const pattern = new RegExp(`^${raw.event.replaceAll('.', '\\.') }-(\\d+)\\.json$`)
  const number = Math.max(0, ...names.map((name) => Number(pattern.exec(name)?.[1] ?? 0))) + 1
  await writeJsonAtomic(join(folder, `${raw.event}-${number}.json`), sanitizeRaw(raw))
}