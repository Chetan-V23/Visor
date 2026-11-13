import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { type Change, type CodeModel, type VisorEvent } from '@visor/protocol'
import { openDatabase, SqliteChangeStore, type Migration } from './index'
import { contentHash } from '../../core/src/index'

const migrations: Migration[] = await Promise.all(['001_initial', '002_indexes', '003_semantic'].map(async (name, index) => ({ version: index + 1, sql: await readFile(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8') })))
const databases: ReturnType<typeof openDatabase>[] = []
const folders: string[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})
function setup(path = ':memory:') {
  const database = openDatabase(path)
  databases.push(database)
  return { database, store: new SqliteChangeStore(database, [...migrations].reverse()) }
}
const project = { id: 'project', root: 'D:\\workspace', name: 'workspace', branch: '' }
const event = (kind: 'session.started' | 'turn.ended' | 'session.ended' = 'session.started', seq = 0): VisorEvent => {
  const base = { v: 1 as const, id: randomUUID(), sessionId: 'session', seq, ts: 42, source: 'copilot' }
  return kind === 'session.started' ? { ...base, kind, payload: { workspaceId: project.id } }
    : kind === 'turn.ended' ? { ...base, kind, payload: { stopHookActive: false } }
      : { ...base, kind, payload: { reason: null } }
}
const model: CodeModel = { v: 1, classes: [], relations: [] }
function baseline(input: VisorEvent, hash = contentHash('before')): Change {
  return { v: 1, id: randomUUID(), sessionId: input.sessionId, seq: 0, ts: input.ts, cause: { kind: 'baseline', eventId: input.id, observedAt: 'session-start' }, summary: 'Baseline', files: [{ path: 'a.py', beforeHash: null, afterHash: hash, added: 0, deleted: 0 }], delta: [] }
}
it('applies numbered migrations in order once and enables expected tables', () => {
  const { database } = setup()
  new SqliteChangeStore(database, migrations)
  expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
  expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(expect.arrayContaining([{ name: 'projects' }, { name: 'sessions' }, { name: 'events' }, { name: 'changes' }, { name: 'change_files' }, { name: 'blobs' }]))
})
it('deduplicates events durably and assigns separate sequences', () => {
  const { store } = setup()
  const input = event()
  expect(store.commit(input, project)).toBe(true)
  expect(store.commit(input, project)).toBe(false)
  expect(store.nextEventSequence('session')).toBe(1)
  expect(store.nextChangeSequence('session')).toBe(0)
  expect(store.listSessions()).toHaveLength(1)
})
it('rolls back the event, session, change, and blobs when a change-file hash is missing', () => {
  const { store, database } = setup()
  const input = event()
  expect(() => store.commit(input, project, { baseline: { change: baseline(input, 'a'.repeat(64)), model }, snapshots: [{ path: 'a.py', text: 'before' }] })).toThrow()
  expect(store.hasEvent(input.id)).toBe(false)
  expect(store.listSessions()).toEqual([])
  expect(store.listChanges('session')).toEqual([])
  expect(database.prepare('SELECT hash FROM blobs').all()).toEqual([])
})
it('saves immutable baseline models and exact content snapshots', () => {
  const { store } = setup()
  const input = event()
  const change = baseline(input)
  store.commit(input, project, { baseline: { change, model }, snapshots: [{ path: 'a.py', text: 'before' }] })
  expect(store.getChange(change.id)).toEqual({ change, model })
  expect(store.currentFiles('session')).toEqual([{ path: 'a.py', text: 'before' }])
  expect(store.getBlob(contentHash('before'))).toBe('before')
})
it('looks up historical source across unrelated edits and stops at a file deletion', () => {
  const { store } = setup()
  const start = event()
  const initial = baseline(start)
  store.commit(start, project, { baseline: { change: initial, model }, snapshots: [{ path: 'a.py', text: 'before' }] })
  const edit: VisorEvent = { v: 1, id: randomUUID(), sessionId: 'session', seq: 1, ts: 43, source: 'copilot', kind: 'edit.applied', payload: { tool: 'fixture', files: ['a.py'], intent: 'edit', outcome: 'succeeded' } }
  const changed: Change = { ...initial, id: randomUUID(), seq: 1, cause: { kind: 'tool', eventId: edit.id, tool: 'fixture' }, files: [{ path: 'a.py', beforeHash: contentHash('before'), afterHash: contentHash('after'), added: 1, deleted: 1 }] }
  store.commit(edit, project, { change: { change: changed, model }, snapshots: [{ path: 'a.py', text: 'after' }] })
  const other: Change = { ...changed, id: randomUUID(), seq: 2, files: [{ path: 'b.py', beforeHash: null, afterHash: contentHash('other'), added: 1, deleted: 0 }] }
  store.commit({ ...edit, id: randomUUID(), seq: 2 }, project, { change: { change: other, model }, snapshots: [{ path: 'b.py', text: 'other' }] })
  expect(store.sourceAtChange('session', 0, 'a.py')).toBe('before')
  expect(store.sourceAtChange('session', 2, 'a.py')).toBe('after')
  expect(store.previousChange('session', 2)).toEqual({ change: changed, model })
  const removed: Change = { ...changed, id: randomUUID(), seq: 3, files: [{ path: 'a.py', beforeHash: contentHash('after'), afterHash: null, added: 0, deleted: 1 }] }
  store.commit({ ...edit, id: randomUUID(), seq: 3 }, project, { change: { change: removed, model }, snapshots: [{ path: 'a.py', text: null }] })
  expect(store.sourceAtChange('session', 3, 'a.py')).toBeNull()
  expect(store.sourceAtChange('session', 3, 'unknown.py')).toBeNull()
  expect(store.filesAtChange('session', 0)).toEqual([{ path: 'a.py', text: 'before' }])
  expect(store.filesAtChange('session', 3)).toEqual([{ path: 'b.py', text: 'other' }])
})

it('accepts semantic facts only for observed workspace file versions', () => {
  const { store } = setup()
  const start = event()
  store.commit(start, project, { baseline: { change: baseline(start), model }, snapshots: [{ path: 'a.py', text: 'before' }] })
  const range = { start: { line: 1, column: 0 }, end: { line: 1, column: 3 } }
  const document = { v: 1 as const, workspaceRoot: project.root, file: 'a.py', hash: contentHash('before'), provider: 'vscode', definitions: [{ position: range.start, targets: [{ file: 'a.py', hash: contentHash('before'), range }] }] }
  expect(store.putSemantic({ ...document, hash: contentHash('unobserved') })).toBe(false)
  expect(store.putSemantic({ ...document, workspaceRoot: 'D:/other' })).toBe(false)
  expect(store.putSemantic({ ...document, definitions: [{ position: range.start, targets: [{ file: 'a.py', hash: contentHash('unobserved'), range }] }] })).toBe(false)
  expect(store.putSemantic(document)).toBe(true)
  expect(store.semanticDocuments('session')).toEqual([document])
})
it('keeps Stop open and closes only on an explicit session end', () => {
  const { store, database } = setup()
  store.commit(event(), project)
  store.commit(event('turn.ended', 1), project)
  expect(database.prepare('SELECT ended_at FROM sessions').get()).toEqual({ ended_at: null })
  store.commit(event('session.ended', 2), project)
  expect(database.prepare('SELECT ended_at FROM sessions').get()).toEqual({ ended_at: 42 })
})
it('persists changes and deduplication across closing and reopening the database', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'visor-store-'))
  folders.push(folder)
  const path = join(folder, 'visor.db')
  const first = setup(path)
  const input = event()
  const change = baseline(input)
  first.store.commit(input, project, { baseline: { change, model }, snapshots: [{ path: 'a.py', text: 'before' }] })
  first.database.close()
  const second = setup(path)
  expect(second.store.getChange(change.id)).toEqual({ change, model })
  expect(second.store.commit(input, project)).toBe(false)
})