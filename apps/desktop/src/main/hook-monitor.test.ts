import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RawHook } from '@visor/bridge'
import { CopilotAdapter } from '@visor/core'
import { readRuntime, removeOwnedRuntime, writeJsonAtomic } from '@visor/bridge/node'
import { HookMonitor } from './hook-monitor'
import { sanitizeRaw } from './raw-capture'

const folders: string[] = []
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))) })

async function folder() {
  const value = await mkdtemp(join(tmpdir(), 'visor-monitor-'))
  folders.push(value)
  return value
}

function raw(event = 'sessionStart'): RawHook {
  return { id: randomUUID(), source: 'copilot', event, receivedAt: 42, payload: { sessionId: 'live-session', cwd: 'D:\\private\\project' } }
}

describe('raw event monitor and capture', () => {
  it('retains schema-valid normalized events once, with per-session sequence and an error diagnostic', () => {
    const monitor = new HookMonitor({ port: 1234, dataFolder: 'test', captureFolder: 'test', onSnapshot: () => {}, onFileChange: () => {} })
    const events = new CopilotAdapter({ workspaceRoot: 'D:\\private\\project', workspaceId: 'project', seq: 0 }).toEvents(raw())
    monitor.recordNormalization(events)
    monitor.recordNormalization(events)
    expect(monitor.snapshot().normalizedEvents).toEqual([])
    const snapshot = monitor.setDebugEnabled(true)
    expect(snapshot.normalizedEvents).toEqual(events)
    expect(snapshot.normalizedEvents?.[0]?.seq).toBe(0)
    monitor.recordNormalization([], 'Invalid hook fields.')
    expect(monitor.snapshot().normalizationError).toBe('Invalid hook fields.')
  })
  it('updates session identity, focuses once, hides events by default, and ignores duplicate IDs', () => {
    let focused = 0
    const monitor = new HookMonitor({ port: 1234, dataFolder: 'test', captureFolder: null, onSnapshot: () => {}, onFileChange: () => { focused++ } })
    const event = raw()
    monitor.ingest(event)
    monitor.ingest(event)
    expect(monitor.snapshot()).toMatchObject({ sessionId: 'live-session', events: [], debugEnabled: false })
    expect(focused).toBe(0)
    monitor.ingest({ ...raw('preToolUse'), payload: { tool_name: 'read_file' } })
    expect(focused).toBe(0)
    const edit = { ...raw('PreToolUse'), payload: { tool_name: 'create_file' } }
    monitor.ingest(edit)
    monitor.ingest(edit)
    expect(focused).toBe(1)
    monitor.ingest({ ...raw('PostToolUse'), payload: { session_id: 'compatible-session' } })
    expect(monitor.snapshot().sessionId).toBe('compatible-session')
  })

  it('captures only after opt-in, in arrival order, without replacing earlier fixtures', async () => {
    const captureFolder = await folder()
    const monitor = new HookMonitor({ port: 1234, dataFolder: 'test', captureFolder, onSnapshot: () => {}, onFileChange: () => {} })
    monitor.ingest(raw())
    await monitor.flush()
    expect(await readdir(captureFolder)).toEqual([])
    monitor.setDebugEnabled(true)
    monitor.ingest(raw('postToolUse'))
    monitor.ingest(raw('postToolUse'))
    await monitor.flush()
    expect((await readdir(captureFolder)).sort()).toEqual(['postToolUse-1.json', 'postToolUse-2.json', 'sessionStart-1.json'])
    monitor.setDebugEnabled(false)
    monitor.setDebugEnabled(true)
    await monitor.flush()
    expect((await readdir(captureFolder)).sort()).toEqual(['postToolUse-1.json', 'postToolUse-2.json', 'sessionStart-1.json'])
    expect(await readFile(join(captureFolder, 'postToolUse-1.json'), 'utf8')).not.toContain('private')
  })

  it('redacts common secrets and private paths but retains workspace-relative file paths', () => {
    const event = { ...raw(), payload: {
      cwd: 'D:\\private\\project', transcriptPath: 'D:\\private\\transcript.jsonl',
      apiKey: 'do-not-save', toolArgs: { filePath: 'D:\\private\\project\\cart.py', password: 'do-not-save' },
      prompt: 'token=do-not-save Read D:\\private\\outside.py and /home/person/private.py',
      nested: ['Bearer do-not-save']
    } }
    const sanitized = sanitizeRaw(event)
    expect(sanitized.payload).toMatchObject({ cwd: '<workspace>', transcriptPath: '<path>', apiKey: '<redacted>', toolArgs: { filePath: 'cart.py', password: '<redacted>' } })
    expect(JSON.stringify(sanitized)).not.toContain('do-not-save')
    expect(JSON.stringify(sanitized)).not.toContain('private')
  })

  it('cannot enable dev capture in a packaged app', () => {
    const monitor = new HookMonitor({ port: 1234, dataFolder: 'test', captureFolder: null, onSnapshot: () => {}, onFileChange: () => {} })
    expect(monitor.setDebugEnabled(true).debugEnabled).toBe(false)
  })

  it('only removes a runtime file owned by the current process and token', async () => {
    const dataFolder = await folder()
    const runtime = { port: 1234, pid: process.pid, token: 'a'.repeat(64) }
    await writeJsonAtomic(join(dataFolder, 'runtime.json'), runtime)
    await removeOwnedRuntime(dataFolder, { ...runtime, token: 'b'.repeat(64) })
    expect(await readRuntime(dataFolder)).toEqual(runtime)
    await removeOwnedRuntime(dataFolder, runtime)
    expect(await readRuntime(dataFolder)).toBeNull()
  })
})