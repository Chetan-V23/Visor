import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { relativePath } from '@visor/core'
import type { SnapshotFile } from '@visor/store'

const ignored = new Set(['.git', '.venv', 'venv', 'node_modules', '__pycache__', '.audit', 'out', 'dist', 'build', '.ssh', '.secrets', '.credentials'])
const credentialName = /^(?:\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$))|\.(?:key|pem|p12|pfx|ppk)$/i
const MAX_SOURCE_BYTES = 2 * 1024 * 1024
const MAX_BASELINE_FILES = 500

export function workspaceRoot(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Workspace root must be an absolute directory.')
  const root = realpathSync(value)
  if (!lstatSync(root).isDirectory()) throw new Error('Workspace root must be a directory.')
  return root
}

function sourcePath(root: string, path: string): string | null {
  if (relativePath(path, root) !== path) throw new Error('Source path must remain inside the workspace.')
  let current = root
  for (const segment of path.split('/')) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('Source paths cannot follow symbolic links.')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null
      throw error
    }
  }
  const stats = lstatSync(current)
  if (!stats.isFile() || stats.size > MAX_SOURCE_BYTES) throw new Error('Source must be a regular UTF-8 file smaller than 2 MiB.')
  const actual = realpathSync(current)
  if (relativePath(actual, root) !== path) throw new Error('Resolved source path left the workspace.')
  return actual
}

function decodeSource(bytes: Uint8Array): string {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Source file exceeds the size limit.')
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}

export async function readSource(root: string, path: string): Promise<string | null> {
  const actual = sourcePath(root, path)
  return actual === null ? null : decodeSource(await readFile(actual))
}

export function readSourceSync(root: string, path: string): string | null {
  const actual = sourcePath(root, path)
  return actual === null ? null : decodeSource(readFileSync(actual))
}

export function snapshotPolicy(root: string): (path: string, directory?: boolean) => boolean {
  const policies = new Map<string, Ignore>()
  return (path, directory = false) => {
    if (relativePath(path, root) !== path) throw new Error('Snapshot path must remain inside the workspace.')
    const segments = path.split('/')
    if (segments.some((segment) => ignored.has(segment) || credentialName.test(segment))) return false
    let allowed = true
    for (let index = 0; index < segments.length; index++) {
      const parent = segments.slice(0, index).join('/')
      let rules = policies.get(parent)
      if (!rules) {
        const text = readSourceSync(root, parent ? `${parent}/.gitignore` : '.gitignore')
        rules = ignore().add(text ?? '')
        policies.set(parent, rules)
      }
      for (let end = index + 1; end <= segments.length - (directory ? 0 : 1); end++) {
        if (rules.ignores(`${segments.slice(index, end).join('/')}/`)) return false
      }
      const result = rules.test(`${segments.slice(index).join('/')}${directory ? '/' : ''}`)
      if (result.ignored) allowed = false
      else if (result.unignored) allowed = true
    }
    return allowed
  }
}

export async function scanPython(root: string): Promise<SnapshotFile[]> {
  const files: SnapshotFile[] = []
  const allowed = snapshotPolicy(root)
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > 32) throw new Error('Workspace nesting exceeds the scan limit.')
    const entries = await readdir(join(root, path), { withFileTypes: true })
    entries.sort((first, second) => first.name.localeCompare(second.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue
      const relative = path ? `${path}/${entry.name}` : entry.name
      if (!allowed(relative, entry.isDirectory())) continue
      if (entry.isDirectory()) await walk(relative, depth + 1)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.py')) {
        if (files.length >= MAX_BASELINE_FILES) throw new Error('Workspace has more than 500 Python files.')
        files.push({ path: relative, text: await readSource(root, relative) })
      }
    }
  }
  await walk('', 0)
  return files
}