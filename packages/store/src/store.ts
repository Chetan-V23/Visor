import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { changeSchema, codeModelSchema, semanticDocumentSchema, sessionSummarySchema, visorEventSchema, type Change, type CodeModel, type SemanticDocument, type SessionSummary, type VisorEvent } from '@visor/protocol'

export interface Migration { version: number; sql: string }
export interface SnapshotFile { path: string; text: string | null }
export interface StoredChange { change: Change; model: CodeModel }
export interface ProjectContext { id: string; root: string; name: string; branch: string }
export interface SnapshotStore {
  getBlob(hash: string): string | null
  sourceAtChange(sessionId: string, seq: number, path: string): string | null
  filesAtChange(sessionId: string, seq: number): SnapshotFile[]
  currentFiles(sessionId: string): SnapshotFile[]
  pendingFiles(sessionId: string, toolCallId: string): SnapshotFile[]
}
export interface ChangeStore extends SnapshotStore {
  hasSourceVersion(root: string, path: string, hash: string): boolean
  putSemantic(document: SemanticDocument): boolean
  semanticDocuments(sessionId: string): SemanticDocument[]
  listSessions(): SessionSummary[]
  listChanges(sessionId: string): Change[]
  getChange(id: string): StoredChange | null
  latestChange(sessionId: string): StoredChange | null
  previousChange(sessionId: string, seq: number): StoredChange | null
  hasEvent(id: string): boolean
  nextEventSequence(sessionId: string): number
  nextChangeSequence(sessionId: string): number
  commit(event: VisorEvent, project: ProjectContext, options?: { baseline?: StoredChange; change?: StoredChange; snapshots?: SnapshotFile[]; pending?: SnapshotFile[] }): boolean
  transaction<T>(callback: () => T): T
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid database row.')
  return value as Record<string, unknown>
}
function textField(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error('Invalid database text field.')
  return value
}
function nullableText(value: unknown): string | null { return typeof value === 'string' ? value : null }

export function migrate(database: Database.Database, migrations: Migration[]): void {
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
  for (const migration of [...migrations].sort((first, second) => first.version - second.version)) {
    if (database.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)) continue
    database.transaction(() => {
      database.exec(migration.sql)
      database.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(migration.version)
    })()
  }
}

export class SqliteChangeStore implements ChangeStore {
  constructor(private readonly database: Database.Database, migrations: Migration[]) { migrate(database, migrations) }

  transaction<T>(callback: () => T): T { return this.database.transaction(callback)() }

  listSessions(): SessionSummary[] {
    return this.database.prepare('SELECT sessions.*, projects.name AS project_name FROM sessions JOIN projects ON projects.id = sessions.project_id ORDER BY started_at DESC, sessions.id').all().map((value) => {
      const row = record(value)
      return sessionSummarySchema.parse({
        v: 1, id: row.id, title: row.title, startedAt: row.started_at, startObserved: row.start_observed === 1,
        project: { id: row.project_id, name: row.project_name, branch: row.branch }
      })
    })
  }

  listChanges(sessionId: string): Change[] {
    return this.database.prepare('SELECT document_json FROM changes WHERE session_id = ? ORDER BY seq DESC').all(sessionId)
      .map((row) => changeSchema.parse(JSON.parse(textField(record(row), 'document_json'))))
  }

  getChange(id: string): StoredChange | null {
    const value = this.database.prepare('SELECT document_json, model_after_json FROM changes WHERE id = ?').get(id)
    if (!value) return null
    const row = record(value)
    return { change: changeSchema.parse(JSON.parse(textField(row, 'document_json'))), model: codeModelSchema.parse(JSON.parse(textField(row, 'model_after_json'))) }
  }

  latestChange(sessionId: string): StoredChange | null {
    const value = this.database.prepare('SELECT id FROM changes WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId)
    return value ? this.getChange(textField(record(value), 'id')) : null
  }

  previousChange(sessionId: string, seq: number): StoredChange | null {
    const value = this.database.prepare('SELECT id FROM changes WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT 1').get(sessionId, seq)
    return value ? this.getChange(textField(record(value), 'id')) : null
  }

  sourceAtChange(sessionId: string, seq: number, path: string): string | null {
    const value = this.database.prepare('SELECT after_hash FROM change_files JOIN changes ON changes.id = change_files.change_id WHERE session_id = ? AND seq <= ? AND path = ? ORDER BY seq DESC LIMIT 1').get(sessionId, seq, path)
    const hash = value ? nullableText(record(value).after_hash) : null
    return hash === null ? null : this.getBlob(hash)
  }

  filesAtChange(sessionId: string, seq: number): SnapshotFile[] {
    return this.database.prepare('SELECT DISTINCT path FROM change_files JOIN changes ON changes.id = change_files.change_id WHERE session_id = ? AND seq <= ? ORDER BY path').all(sessionId, seq)
      .flatMap((value) => { const path = textField(record(value), 'path'); const text = this.sourceAtChange(sessionId, seq, path); return text === null ? [] : [{ path, text }] })
  }

  putSemantic(input: SemanticDocument): boolean {
    const document = semanticDocumentSchema.parse(input)
    if (!this.hasSourceVersion(document.workspaceRoot, document.file, document.hash)) return false
    if (document.definitions.some((entry) => entry.targets.some((target) => !this.hasSourceVersion(document.workspaceRoot, target.file, target.hash)))) return false
    this.database.prepare('INSERT INTO semantic_documents(root_path, path, hash, document_json) VALUES (?, ?, ?, ?) ON CONFLICT(root_path, path, hash) DO UPDATE SET document_json = excluded.document_json').run(document.workspaceRoot, document.file, document.hash, JSON.stringify(document))
    return true
  }

  hasSourceVersion(root: string, path: string, hash: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM change_files JOIN changes ON changes.id = change_files.change_id JOIN sessions ON sessions.id = changes.session_id JOIN projects ON projects.id = sessions.project_id WHERE projects.root_path = ? AND path = ? AND after_hash = ? LIMIT 1').get(root, path, hash))
  }

  semanticDocuments(sessionId: string): SemanticDocument[] {
    return this.database.prepare('SELECT document_json FROM semantic_documents JOIN projects ON projects.root_path = semantic_documents.root_path JOIN sessions ON sessions.project_id = projects.id WHERE sessions.id = ?').all(sessionId)
      .map((value) => semanticDocumentSchema.parse(JSON.parse(textField(record(value), 'document_json'))))
  }

  hasEvent(id: string): boolean { return Boolean(this.database.prepare('SELECT id FROM events WHERE id = ?').get(id)) }
  nextEventSequence(sessionId: string): number { return Number(record(this.database.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM events WHERE session_id = ?').get(sessionId)).seq) }
  nextChangeSequence(sessionId: string): number { return Number(record(this.database.prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM changes WHERE session_id = ?').get(sessionId)).seq) }

  getBlob(hash: string): string | null {
    const value = this.database.prepare('SELECT content FROM blobs WHERE hash = ?').get(hash)
    return value ? textField(record(value), 'content') : null
  }

  currentFiles(sessionId: string): SnapshotFile[] {
    return this.database.prepare('SELECT path, content FROM session_files JOIN blobs ON blobs.hash = session_files.hash WHERE session_id = ? ORDER BY path').all(sessionId)
      .map((value) => { const row = record(value); return { path: textField(row, 'path'), text: textField(row, 'content') } })
  }

  pendingFiles(sessionId: string, toolCallId: string): SnapshotFile[] {
    return this.database.prepare('SELECT path, content FROM pending_files LEFT JOIN blobs ON blobs.hash = pending_files.hash WHERE session_id = ? AND tool_call_id = ? ORDER BY path').all(sessionId, toolCallId)
      .map((value) => { const row = record(value); return { path: textField(row, 'path'), text: nullableText(row.content) } })
  }

  commit(input: VisorEvent, project: ProjectContext, options: { baseline?: StoredChange; change?: StoredChange; snapshots?: SnapshotFile[]; pending?: SnapshotFile[] } = {}): boolean {
    const event = visorEventSchema.parse(input)
    return this.transaction(() => {
      if (this.hasEvent(event.id)) return false
      this.database.prepare('INSERT INTO projects(id, root_path, name) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, name = excluded.name').run(project.id, project.root, project.name)
      this.database.prepare('INSERT INTO sessions(id, project_id, source, title, started_at, start_observed, branch) VALUES (?, ?, ?, NULL, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(event.sessionId, project.id, event.source, event.ts, event.kind === 'session.started' ? 1 : 0, project.branch)
      const session = record(this.database.prepare('SELECT project_id FROM sessions WHERE id = ?').get(event.sessionId))
      if (session.project_id !== project.id) throw new Error('Session workspace identity cannot change.')
      this.database.prepare('INSERT INTO events(id, session_id, seq, ts, kind, document_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(event.id, event.sessionId, event.seq, event.ts, event.kind, JSON.stringify(event))
      if (event.kind === 'prompt.submitted') this.database.prepare('UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL').run(event.payload.text.replace(/\s+/g, ' ').trim().slice(0, 180), event.sessionId)
      if (event.kind === 'session.ended') this.database.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(event.ts, event.sessionId)
      for (const file of [...options.snapshots ?? [], ...options.pending ?? []]) if (file.text !== null) this.putBlob(file.text)
      if (options.baseline) this.putChange(options.baseline, event.sessionId)
      if (options.change) this.putChange(options.change, event.sessionId)
      for (const file of options.snapshots ?? []) {
        if (file.text === null) this.database.prepare('DELETE FROM session_files WHERE session_id = ? AND path = ?').run(event.sessionId, file.path)
        else this.database.prepare('INSERT INTO session_files(session_id, path, hash) VALUES (?, ?, ?) ON CONFLICT(session_id, path) DO UPDATE SET hash = excluded.hash').run(event.sessionId, file.path, this.putBlob(file.text))
      }
      if (event.kind === 'edit.pending' && event.payload.toolCallId) {
        for (const file of options.pending ?? []) this.database.prepare('INSERT INTO pending_files(session_id, tool_call_id, path, hash) VALUES (?, ?, ?, ?) ON CONFLICT(session_id, tool_call_id, path) DO UPDATE SET hash = excluded.hash')
          .run(event.sessionId, event.payload.toolCallId, file.path, file.text === null ? null : this.putBlob(file.text))
      }
      if (event.kind === 'edit.applied' && event.payload.toolCallId) this.database.prepare('DELETE FROM pending_files WHERE session_id = ? AND tool_call_id = ?').run(event.sessionId, event.payload.toolCallId)
      return true
    })
  }

  private putBlob(text: string): string {
    const hash = createHash('sha256').update(text, 'utf8').digest('hex')
    this.database.prepare('INSERT OR IGNORE INTO blobs(hash, content) VALUES (?, ?)').run(hash, text)
    return hash
  }

  private putChange(input: StoredChange, sessionId: string): void {
    const change = changeSchema.parse(input.change)
    const model = codeModelSchema.parse(input.model)
    if (change.sessionId !== sessionId) throw new Error('Change must belong to the committed event session.')
    this.database.prepare('INSERT INTO changes(id, session_id, seq, ts, summary, delta_json, model_after_json, document_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(change.id, change.sessionId, change.seq, change.ts, change.summary, JSON.stringify(change.delta), JSON.stringify(model), JSON.stringify(change))
    for (const file of change.files) this.database.prepare('INSERT INTO change_files(change_id, path, before_hash, after_hash, added, deleted) VALUES (?, ?, ?, ?, ?, ?)')
      .run(change.id, file.path, file.beforeHash, file.afterHash, file.added, file.deleted)
  }
}