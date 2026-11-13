import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { z } from 'zod'
import { historySnapshotSchema } from '@visor/bridge'
import { sessionSummarySchema, type VisorEvent } from '@visor/protocol'
import { openDatabase, SqliteChangeStore, type Migration } from '@visor/store'

const fixtureSchema = z.object({ v: z.literal(1), session: sessionSummarySchema, changes: z.array(historySnapshotSchema) })

export function seedHistory(databasePath: string, projectRoot: string, document: unknown, migrations: Migration[]): void {
  const fixture = fixtureSchema.parse(document)
  const database = openDatabase(databasePath)
  try {
    const store = new SqliteChangeStore(database, migrations)
    const project = { id: fixture.session.project.id, root: projectRoot, name: fixture.session.project.name || basename(projectRoot), branch: fixture.session.project.branch }
    store.transaction(() => {
      store.commit({ v: 1, id: randomUUID(), source: 'copilot', sessionId: fixture.session.id, seq: 0, ts: fixture.session.startedAt, kind: 'session.started', payload: { workspaceId: project.id } }, project)
      store.commit({ v: 1, id: randomUUID(), source: 'copilot', sessionId: fixture.session.id, seq: 1, ts: fixture.session.startedAt, kind: 'prompt.submitted', payload: { text: fixture.session.title ?? '' } }, project)
      for (const [index, record] of fixture.changes.entries()) {
        const event: VisorEvent = { v: 1, id: record.change.cause.kind === 'tool' ? record.change.cause.eventId : randomUUID(), source: 'copilot', sessionId: fixture.session.id, seq: index + 2, ts: record.change.ts, kind: 'edit.applied', payload: { tool: 'fixture', files: record.change.files.map((file) => file.path), intent: 'edit', outcome: 'succeeded' } }
        store.commit(event, project, { change: record })
      }
    })
  } finally { database.close() }
}