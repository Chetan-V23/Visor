import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { runtimeSchema, type Runtime } from './index'

export function dataFolder(): string {
  return process.env.VISOR_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'Visor')
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function readRuntime(folder: string): Promise<Runtime | null> {
  try {
    const text = await readFile(join(folder, 'runtime.json'), 'utf8')
    if (text.length > 4096) return null
    const input: unknown = JSON.parse(text)
    const parsed = runtimeSchema.safeParse(input)
    return parsed.success ? parsed.data : null
  } catch { return null }
}

export async function removeOwnedRuntime(folder: string, runtime: Runtime): Promise<void> {
  const current = await readRuntime(folder)
  if (current?.token === runtime.token && current.pid === runtime.pid) {
    await rm(join(folder, 'runtime.json'), { force: true })
  }
}