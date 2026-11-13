import fixture from '../fixtures/sample-diagram.json'
import { diagramFixtureSchema } from '@visor/protocol'
import { toDiagramChange, toDiagramView } from './protocol-adapter'
import type { DiagramSource } from './types'

const documents = diagramFixtureSchema.parse(fixture)
const changes = [...documents.changes].sort((left, right) => right.seq - left.seq)

export const fixtureSource: DiagramSource = {
  load: () => ({
    ...toDiagramView(documents.model, changes[0] ?? null),
    session: {
      name: documents.session.title ?? new Date(documents.session.startedAt).toISOString(),
      project: documents.session.project.name, branch: documents.session.project.branch
    },
    changes: changes.map((change) => toDiagramChange(change, documents.model))
  })
}