import { randomUUID } from 'node:crypto'
import { contentHash, createChange } from '@visor/core'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import type { RawHook } from '@visor/bridge'
import { openDatabase, SqliteChangeStore, type Migration, type StoredChange } from '@visor/store'
import { type VisorEvent } from '@visor/protocol'
import { pythonParser } from '../../../cli/src/fixtures'
import { ChangePipeline } from './change-pipeline'
import { readSource } from './workspace'

const require = createRequire(import.meta.url)
const migrations: Migration[] = await Promise.all(['001_initial', '002_indexes', '003_semantic'].map(async (name, index) => ({ version: index + 1, sql: await readFile(require.resolve(`@visor/store/migrations/${name}.sql`), 'utf8') })))
let python: Awaited<ReturnType<typeof pythonParser>>
const folders: string[] = []
const databases: ReturnType<typeof openDatabase>[] = []
beforeAll(async () => { python = await pythonParser() })
afterAll(() => python.parser.delete())
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'visor-pipeline-'))
  folders.push(folder)
  const root = join(folder, 'project')
  await mkdir(root)
  await writeFile(join(root, 'a.py'), 'class A:\n    def run(self):\n        return 1\n')
  const database = openDatabase(':memory:')
  databases.push(database)
  const store = new SqliteChangeStore(database, migrations)
  const changes: StoredChange[] = []
  const events: VisorEvent[] = []
  const errors: string[] = []
  const pipeline = new ChangePipeline({ store, extractors: [python.extractor], onChangeAdded: (change) => changes.push(change), onNormalized: (normalized, error) => { events.push(...normalized); if (error) errors.push(error) } })
  const raw = (event: string, payload: RawHook['payload'] = {}): RawHook => ({ id: randomUUID(), source: 'copilot', event, receivedAt: Date.now(), payload: { session_id: 'test', cwd: root, ...payload } })
  return { root, folder, pipeline, store, changes, events, errors, database, raw }
}

it('stores an observed baseline and one confirmed edit with transactional file snapshots', async () => {
  const state = await setup()
  state.pipeline.enqueue(state.raw('sessionStart'))
  await state.pipeline.flush()
  expect(state.changes[0]?.change).toMatchObject({ seq: 0, cause: { observedAt: 'session-start' } })
  const input = { tool_name: 'apply_patch', tool_use_id: 'call', tool_input: { input: '*** Begin Patch\n*** Update File: a.py\n*** End Patch' } }
  state.pipeline.enqueue(state.raw('preToolUse', input))
  await state.pipeline.flush()
  await writeFile(join(state.root, 'a.py'), 'class A:\n    def run(self):\n        return 2\n\nclass B:\n    pass\n')
  const post = state.raw('postToolUse', { ...input, tool_response: '' })
  state.pipeline.enqueue(post)
  state.pipeline.enqueue(post)
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.store.listChanges('test').map((change) => change.seq)).toEqual([1, 0])
  expect(state.changes[1]?.model.classes.map((symbol) => symbol.name)).toEqual(['A', 'B'])
  expect(state.changes[1]?.change.delta).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'node.add' }), expect.objectContaining({ op: 'member.change' })]))
  expect(state.database.prepare('SELECT COUNT(*) AS count FROM change_files').get()).toEqual({ count: 2 })
})
it('recovers a post-only session as a late current-state baseline', async () => {
  const state = await setup()
  state.pipeline.enqueue(state.raw('postToolUse', { tool_name: 'create_file', tool_input: { filePath: 'a.py' } }))
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.changes).toHaveLength(1)
  expect(state.changes[0]?.change).toMatchObject({ seq: 0, cause: { observedAt: 'after-first-edit' } })
  expect(state.store.listSessions()[0]?.startObserved).toBe(false)
})

it('preserves pre-hook class mentions in SQLite when a new pipeline receives a snippet-free post', async () => {
  const state = await setup()
  const before = 'class A:\n    def run(self):\n        return 1\n\nclass Helper:\n    pass\n'
  await writeFile(join(state.root, 'a.py'), before)
  await writeFile(join(state.root, 'base.py'), 'class Base:\n    pass\n')
  const input = { tool_name: 'multi_replace_string_in_file', tool_use_id: 'mention-call', tool_input: { explanation: 'Keep Helper and Base in view.', replacements: [{ filePath: 'a.py', oldString: 'return 1', newString: 'return 2' }] } }
  state.pipeline.enqueue(state.raw('preToolUse', input))
  await state.pipeline.flush()
  const expected = ['py:a.py::Helper', 'py:base.py::Base']
  expect(state.store.pendingClassMentions('test', 'mention-call')).toEqual(expected)
  const pipeline = new ChangePipeline({ store: state.store, extractors: [python.extractor], onChangeAdded: (change) => state.changes.push(change), onNormalized: (_, error) => { if (error) state.errors.push(error) } })
  await writeFile(join(state.root, 'a.py'), before.replace('return 1', 'return 2'))
  pipeline.enqueue(state.raw('postToolUse', { ...input, tool_input: { replacements: [{ filePath: 'a.py' }] } }))
  await pipeline.flush()
  expect(state.errors).toEqual([])
  const stored = state.store.latestChange('test')
  expect(stored?.change.cause).toMatchObject({ mentionedClasses: expected })
  expect(stored?.model.classes.map((symbol) => symbol.name)).toEqual(['A', 'Helper', 'Base'])
  if (!stored) throw new Error('Missing stored change.')
  expect(pipeline.snapshot(stored).change.cause).toEqual(stored.change.cause)
})

it('does not create changes for reads, explicit failures, or unchanged disk content', async () => {
  const state = await setup()
  state.pipeline.enqueue(state.raw('sessionStart'))
  state.pipeline.enqueue(state.raw('postToolUse', { tool_name: 'read_file', tool_input: { filePath: 'a.py' } }))
  state.pipeline.enqueue(state.raw('postToolUse', { tool_name: 'edit_file', tool_input: { filePath: 'a.py' }, tool_response: { isError: true } }))
  state.pipeline.enqueue(state.raw('postToolUse', { tool_name: 'edit_file', tool_input: { filePath: 'a.py' }, tool_response: '' }))
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.store.listChanges('test')).toHaveLength(1)
})
it.each([{ files: ['a.diagram.md'] }, { files: ['a.py', 'a.diagram.md'] }])('does not create history entries for documentation-only edits ($files)', async ({ files }) => {
  const state = await setup()
  await writeFile(join(state.root, 'a.diagram.md'), 'run(self)\n')
  state.pipeline.enqueue(state.raw('sessionStart'))
  await state.pipeline.flush()
  const input = { tool_name: 'apply_patch', tool_use_id: 'documentation-call', tool_input: { input: `*** Begin Patch\n${files.map((path) => `*** Update File: ${path}`).join('\n')}\n*** End Patch` } }
  state.pipeline.enqueue(state.raw('preToolUse', input))
  await writeFile(join(state.root, 'a.diagram.md'), 'run(self, value)\n')
  const post = state.raw('postToolUse', input)
  state.pipeline.enqueue(post)
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.store.hasEvent(post.id)).toBe(true)
  expect(state.events.map((event) => event.kind)).toEqual(['session.started', 'edit.pending', 'edit.applied'])
  expect(state.store.listChanges('test').map((change) => change.seq)).toEqual([0])
  expect(state.changes).toHaveLength(1)
})
it.each([{ files: ['a.py'] }, { files: ['a.py', 'a.diagram.md'] }])('records source edits without semantic changes ($files)', async ({ files }) => {
  const state = await setup()
  await writeFile(join(state.root, 'a.diagram.md'), 'run(self)\n')
  state.pipeline.enqueue(state.raw('sessionStart'))
  await state.pipeline.flush()
  const input = { tool_name: 'apply_patch', tool_use_id: 'source-call', tool_input: { input: `*** Begin Patch\n${files.map((path) => `*** Update File: ${path}`).join('\n')}\n*** End Patch` } }
  state.pipeline.enqueue(state.raw('preToolUse', input))
  await writeFile(join(state.root, 'a.py'), 'class A:\n    def run(self):\n        return 1\n\nSETTING = 2\n')
  if (files.includes('a.diagram.md')) await writeFile(join(state.root, 'a.diagram.md'), 'run(self, value)\n')
  state.pipeline.enqueue(state.raw('postToolUse', input))
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.pipeline.listChanges('test').map((change) => change.seq)).toEqual([1, 0])
  expect(state.changes[1]?.change.files.map((file) => file.path)).toEqual(files)
  expect(state.changes[1]?.change.delta.every((delta) => delta.op === 'code.hunks')).toBe(true)
})
it('hides legacy documentation-only history while keeping source-less code records', async () => {
  const state = await setup()
  state.pipeline.enqueue(state.raw('sessionStart'))
  await state.pipeline.flush()
  const baseline = state.store.latestChange('test')
  const session = state.store.listSessions()[0]
  if (!baseline || !session) throw new Error('Missing baseline session.')
  const event: Extract<VisorEvent, { kind: 'edit.applied' }> = {
    v: 1, id: randomUUID(), sessionId: 'test', seq: 1, ts: Date.now(), source: 'copilot', kind: 'edit.applied',
    payload: { tool: 'apply_patch', toolCallId: 'legacy-documentation', files: ['a.diagram.md'], intent: 'create', outcome: 'succeeded' }
  }
  const text = 'run(self, value)\n'
  const change = createChange(event, 1, baseline.model, baseline.model, [{ path: 'a.diagram.md', before: null, after: text }])
  state.store.commit(event, { id: session.project.id, root: state.root, name: session.project.name, branch: '' }, {
    change: { change, model: baseline.model }, snapshots: [{ path: 'a.diagram.md', text }]
  })
  expect(state.store.listChanges('test').map((stored) => stored.seq)).toEqual([1, 0])
  expect(state.pipeline.listChanges('test').map((stored) => stored.seq)).toEqual([0])
  expect(state.store.getChange(change.id)?.change).toEqual(change)
  expect(state.store.hasEvent(event.id)).toBe(true)
  const sourceEvent: typeof event = { ...event, id: randomUUID(), seq: 2, payload: { ...event.payload, files: ['a.py'] } }
  const sourceChange: StoredChange = { model: baseline.model, change: {
    ...change, id: sourceEvent.id, seq: 2,
    cause: { kind: 'tool', eventId: sourceEvent.id, tool: sourceEvent.payload.tool },
    files: [{ path: 'a.py', beforeHash: null, afterHash: null, added: 1, deleted: 1 }],
    delta: [{ v: 1, op: 'code.hunks', file: 'a.py', hunks: [] }]
  } }
  state.store.commit(sourceEvent, { id: session.project.id, root: state.root, name: session.project.name, branch: '' }, { change: sourceChange })
  expect(state.pipeline.listChanges('test').map((stored) => stored.seq)).toEqual([2, 0])
  expect(state.store.getChange(change.id)?.change).toEqual(change)
})
it('rejects escaped and linked source paths, then keeps processing valid events', async () => {
  const state = await setup()
  const outside = join(state.folder, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'secret.py'), 'private = 1\n')
  await symlink(outside, join(state.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(readSource(state.root, 'linked/secret.py')).rejects.toThrow('symbolic links')
  await expect(readSource(state.root, '../outside/secret.py')).rejects.toThrow('inside the workspace')
  state.pipeline.enqueue(state.raw('preToolUse', { tool_name: 'create_file', tool_input: { filePath: '../outside/secret.py' } }))
  state.pipeline.enqueue(state.raw('sessionStart'))
  await state.pipeline.flush()
  expect(state.errors).toHaveLength(1)
  expect(state.changes[0]?.model.classes.map((symbol) => symbol.name)).toEqual(['A'])
})
it('preserves exact UTF-8 text including a byte-order mark', async () => {
  const state = await setup()
  const source = '\ufeffclass A:\r\n    pass\r\n'
  await writeFile(join(state.root, 'a.py'), source, 'utf8')
  expect(await readSource(state.root, 'a.py')).toBe(source)
})
it('captures the before-state before returning from pre-hook ingestion, without a producer-side flush', async () => {
  const state = await setup()
  const input = { tool_name: 'edit_file', tool_use_id: 'fast-call', tool_input: { filePath: 'a.py' } }
  state.pipeline.enqueue(state.raw('preToolUse', input))
  await writeFile(join(state.root, 'a.py'), 'class A:\n    def run(self):\n        return 2\n\nclass B:\n    pass\n')
  state.pipeline.enqueue(state.raw('postToolUse', input))
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.changes.map((record) => record.change.seq)).toEqual([0, 1])
  expect(state.changes[0]?.model.classes.map((symbol) => symbol.name)).toEqual(['A'])
  expect(state.changes[1]?.model.classes.map((symbol) => symbol.name)).toEqual(['A', 'B'])
})
it('keeps fast successive tool calls separate with each exact after-state', async () => {
  const state = await setup()
  const input = (call: string) => ({ tool_name: 'edit_file', tool_use_id: call, tool_input: { filePath: 'a.py' } })
  state.pipeline.enqueue(state.raw('preToolUse', input('first')))
  await writeFile(join(state.root, 'a.py'), 'class A:\n    def run(self):\n        return 2\n')
  state.pipeline.enqueue(state.raw('postToolUse', input('first')))
  state.pipeline.enqueue(state.raw('preToolUse', input('second')))
  await writeFile(join(state.root, 'a.py'), 'class A:\n    def run(self):\n        return 3\n')
  state.pipeline.enqueue(state.raw('postToolUse', input('second')))
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.changes.map((record) => record.change.seq)).toEqual([0, 1, 2])
  const first = state.changes[1]?.change.files[0]?.afterHash
  const secondBefore = state.changes[2]?.change.files[0]?.beforeHash
  const second = state.changes[2]?.change.files[0]?.afterHash
  expect(first).toBe(secondBefore)
  expect(first).not.toBe(second)
})
it('excludes gitignored source and credential files from baselines and touched-file blobs', async () => {
  const state = await setup()
  const secret = 'class Secret:\n    pass\n'
  await mkdir(join(state.root, 'private'))
  await mkdir(join(state.root, 'nested'))
  await writeFile(join(state.root, '.gitignore'), '*.py\n!a.py\nprivate/\n')
  await writeFile(join(state.root, 'secrets.py'), secret)
  await writeFile(join(state.root, 'private', 'key.py'), secret)
  await writeFile(join(state.root, 'nested', '.gitignore'), 'hidden.py\n!visible.py\n')
  await writeFile(join(state.root, 'nested', 'hidden.py'), secret)
  await writeFile(join(state.root, 'nested', 'visible.py'), 'class Visible:\n    pass\n')
  await writeFile(join(state.root, '.env'), 'PRIVATE_VALUE=do-not-store\n')
  state.pipeline.enqueue(state.raw('sessionStart'))
  await state.pipeline.flush()
  expect(state.changes[0]?.model.classes.map((symbol) => symbol.name)).toEqual(['A', 'Visible'])
  for (const filePath of ['secrets.py', 'private/key.py', 'nested/hidden.py', '.env']) {
    const input = { tool_name: 'edit_file', tool_use_id: filePath, tool_input: { filePath } }
    state.pipeline.enqueue(state.raw('preToolUse', input))
    await writeFile(join(state.root, filePath), `${secret}\n`)
    state.pipeline.enqueue(state.raw('postToolUse', input))
  }
  await state.pipeline.flush()
  expect(state.errors).toEqual([])
  expect(state.store.currentFiles('test').map((file) => file.path)).toEqual(['a.py', 'nested/visible.py'])
  expect(state.store.getBlob(contentHash(secret))).toBeNull()
  expect(state.store.getBlob(contentHash(`${secret}\n`))).toBeNull()
  expect(state.changes).toHaveLength(1)
})