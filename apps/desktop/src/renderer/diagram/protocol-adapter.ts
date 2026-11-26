import { graphLanguageSchema, type Change, type ClassSymbol, type CodeModel, type FieldSymbol, type MethodSymbol, type Relation, type SourceRange } from '@visor/protocol'
import type { DiagramChange, DiagramEdge, DiagramView } from './types'

export interface DiagramHistoryEntry {
  change: Change
  classIds: string[]
}

function relationId(relation: Relation): string {
  return `${relation.kind}:${relation.from}->${relation.to}:${relation.label ?? ''}`
}

export function toDiagramView(model: CodeModel, change: Change | null, history?: DiagramHistoryEntry[]): Pick<DiagramView, 'classes' | 'edges'> {
  return change && history ? toHistoryView(model, change, history) : projectDiagramView(model, change)
}

function projectDiagramView(model: CodeModel, change: Change | null, scope?: ReadonlySet<string>): Pick<DiagramView, 'classes' | 'edges'> {
  const classes = new Map(model.classes.map((symbol) => [symbol.id, structuredClone(symbol)]))
  const addedClasses = new Set<string>()
  const removedClasses = new Set<string>()
  const modifiedClasses = new Set<string>()
  const addedMembers = new Set<string>()
  const modifiedMembers = new Set<string>()
  const removedMembers = new Map<string, MethodSymbol[]>()
  const removedFields = new Map<string, FieldSymbol[]>()
  const relations = new Map<string, { relation: Relation; change: DiagramEdge['change'] }>(model.relations.map((relation) => [relationId(relation), { relation, change: 'unchanged' }]))
  for (const delta of change?.delta ?? []) {
    switch (delta.op) {
      case 'node.add':
        addedClasses.add(delta.node.id)
        if (!classes.has(delta.node.id)) classes.set(delta.node.id, structuredClone(delta.node))
        break
      case 'node.remove':
        removedClasses.add(delta.node.id)
        classes.set(delta.node.id, structuredClone(delta.node))
        break
      case 'node.rename':
        modifiedClasses.add(delta.to)
        break
      case 'member.add':
        addedMembers.add(delta.member.id)
        modifiedClasses.add(delta.classId)
        break
      case 'member.remove':
        if (delta.member.kind === 'method') {
          const members = removedMembers.get(delta.classId) ?? []
          members.push(structuredClone(delta.member))
          removedMembers.set(delta.classId, members)
        } else {
          const fields = removedFields.get(delta.classId) ?? []
          fields.push(delta.member)
          removedFields.set(delta.classId, fields)
        }
        modifiedClasses.add(delta.classId)
        break
      case 'member.change':
        modifiedMembers.add(delta.after.id)
        modifiedClasses.add(delta.classId)
        break
      case 'edge.add':
      case 'edge.remove':
        relations.set(relationId(delta.relation), { relation: delta.relation, change: delta.op === 'edge.add' ? 'added' : 'deleted' })
        break
      case 'code.hunks':
        if (delta.symbolId && classes.has(delta.symbolId)) modifiedClasses.add(delta.symbolId)
        break
      default: {
        const unreachable: never = delta
        throw new Error(`Unsupported graph operation: ${String(unreachable)}`)
      }
    }
  }
  const owners = new Map<string, string>()
  const methodNames = new Map<string, string>()
  const classesByFile = new Map<string, { symbol: ClassSymbol; range: SourceRange }[]>()
  for (const symbol of classes.values()) {
    owners.set(symbol.id, symbol.id)
    for (const member of [...symbol.methods, ...symbol.fields]) {
      owners.set(member.id, symbol.id)
      if (member.kind === 'method') methodNames.set(member.id, member.name)
    }
    if (!removedClasses.has(symbol.id)) {
      const locations = [...symbol.locations ?? [{ file: symbol.file, range: symbol.range }], ...[...symbol.methods, ...symbol.fields].flatMap((member) => member.locations ?? [])]
      for (const { file, range } of locations) {
        if (!range) continue
        const siblings = classesByFile.get(file) ?? []
        siblings.push({ symbol, range }); classesByFile.set(file, siblings)
      }
    }
  }
  const touchLine = (file: string, line: number, deleted = false): void => {
    let closest: { symbol: ClassSymbol; range: SourceRange } | undefined
    let smallestSpan = Infinity
    for (const entry of classesByFile.get(file) ?? []) {
      const range = entry.range
      if (line < range.start.line || line > range.end.line || (line === range.end.line && range.end.column === 0)) continue
      const span = range.end.line - range.start.line
      if (span < smallestSpan) { closest = entry; smallestSpan = span }
    }
    if (deleted && closest?.range?.start.line === line) { touchLine(file, line - 1); return }
    if (closest) modifiedClasses.add(closest.symbol.id)
  }
  const touchedFiles = new Set(change?.files.map((file) => file.path))
  for (const delta of change?.delta ?? []) {
    if (delta.op === 'code.hunks') {
      const owner = delta.symbolId ? owners.get(delta.symbolId) : undefined
      if (owner) modifiedClasses.add(owner)
      for (const hunk of delta.hunks) {
        let line = hunk.newStart
        for (const entry of hunk.lines) {
          if (entry.kind !== 'context') touchLine(delta.file, line, entry.kind === 'deleted')
          if (entry.kind !== 'deleted') line++
        }
      }
    } else if (delta.op === 'edge.add' || delta.op === 'edge.remove') {
      const evidence = delta.relation.evidence?.filter((item) => touchedFiles.has(item.file) && item.range) ?? []
      for (const item of evidence) if (item.range) touchLine(item.file, item.range.start.line)
      if (evidence.length === 0) {
        const source = classes.get(owners.get(delta.relation.from) ?? delta.relation.from)
        if (source && touchedFiles.has(source.file)) modifiedClasses.add(source.id)
      }
    }
  }
  const touchedClasses = new Set([...addedClasses, ...removedClasses, ...modifiedClasses])
  let visibleClasses = change && change.cause.kind !== 'baseline'
    ? new Set(touchedClasses)
    : new Set(classes.keys())
  if (change?.cause.kind === 'tool') {
    for (const id of change.cause.mentionedClasses ?? []) {
      if (classes.has(id)) visibleClasses.add(id)
    }
  }
  for (const delta of change?.delta ?? []) {
    if (delta.op !== 'edge.add' && delta.op !== 'edge.remove') continue
    const from = owners.get(delta.relation.from)
    const to = owners.get(delta.relation.to)
    if (from && to && touchedClasses.has(from)) visibleClasses.add(to)
  }
  if (scope) visibleClasses = new Set(scope)
  return {
    classes: [...classes.values()].filter((symbol) => visibleClasses.has(symbol.id)).map((symbol) => {
      const removed = removedMembers.get(symbol.id) ?? []
      const removedIds = new Set(removed.map((method) => method.id))
      const deletedFields = removedFields.get(symbol.id) ?? []
      const deletedFieldIds = new Set(deletedFields.map((field) => field.id))
      const changedMembers = [...symbol.methods, ...symbol.fields].filter((member) => addedMembers.has(member.id) || modifiedMembers.has(member.id))
      const editFiles = new Set([...changedMembers, ...removed, ...deletedFields].flatMap((member) => member.locations ?? [])
        .map((location) => location.file).filter((file) => touchedFiles.has(file)))
      return {
        id: symbol.id, name: symbol.name, file: [...editFiles].join(', ') || symbol.file, kind: symbol.kind, language: graphLanguageSchema.parse(symbol.id.split(':', 1)[0]),
        change: removedClasses.has(symbol.id) ? 'deleted' : addedClasses.has(symbol.id) ? 'added' : modifiedClasses.has(symbol.id) ? 'modified' : 'unchanged',
        fields: [...symbol.fields.filter((field) => !deletedFieldIds.has(field.id)), ...deletedFields].map((field) => ({
          id: field.id, name: field.name, type: field.type, change: removedClasses.has(symbol.id) || deletedFieldIds.has(field.id) ? 'deleted' : addedClasses.has(symbol.id) || addedMembers.has(field.id) ? 'added' : modifiedMembers.has(field.id) ? 'modified' : 'unchanged'
        })),
        methods: [...symbol.methods.filter((method) => !removedIds.has(method.id)), ...removed].map((method) => ({
          id: method.id, name: method.displayName ?? (symbol.methods.some((other) => other.id !== method.id && other.name === method.name) ? method.signature : method.name), signature: method.signature, docstring: method.docstring,
          change: removedClasses.has(symbol.id) || removedIds.has(method.id) ? 'deleted' : addedClasses.has(symbol.id) || addedMembers.has(method.id) ? 'added' : 'unchanged',
          modified: modifiedMembers.has(method.id), changeId: change?.id
        }))
      }
    }),
    edges: [...relations.entries()].flatMap(([id, { relation, change }]) => {
      const from = owners.get(relation.from)
      const to = owners.get(relation.to)
      if (!from || !to || !visibleClasses.has(from) || !visibleClasses.has(to)) return []
      let label = relation.label ?? relation.kind
      if (relation.kind === 'calls') {
        if (from === to) return []
        if (label === 'calls') {
          const method = methodNames.get(relation.to)
          label = method ? `Calls ${method}()` : 'Calls'
        }
      }
      return [{ id, from, to, label, kind: relation.kind, certainty: relation.certainty, evidence: relation.evidence, change }]
    })
  }
}

function toHistoryView(model: CodeModel, change: Change, history: DiagramHistoryEntry[]): Pick<DiagramView, 'classes' | 'edges'> {
  const edits = history.filter((entry) => entry.change.cause.kind !== 'baseline').sort((left, right) => left.change.seq - right.change.seq)
  if (edits.length === 0) return projectDiagramView(model, change)
  const included = change.cause.kind === 'baseline' ? edits.slice(0, 1) : edits.filter((entry) => entry.change.seq <= change.seq)
  const deleted = new Map<string, { node: CodeModel['classes'][number]; changeId: string }>()
  if (change.cause.kind !== 'baseline') {
    for (const entry of included) {
      for (const delta of entry.change.delta) {
        if (delta.op === 'node.remove') deleted.set(delta.node.id, { node: delta.node, changeId: entry.change.id })
        else if (delta.op === 'node.add') deleted.delete(delta.node.id)
      }
    }
  }
  for (const symbol of model.classes) deleted.delete(symbol.id)
  const augmentedModel = { ...model, classes: [...model.classes, ...[...deleted.values()].map((entry) => entry.node)] }
  const visible = new Set(included.flatMap((entry) => entry.classIds))
  const view = projectDiagramView(augmentedModel, {
    ...change,
    delta: [...change.delta, ...[...deleted.values()].map((entry) => ({ v: 1, op: 'node.remove', node: entry.node } as const))]
  }, visible)
  for (const symbol of view.classes) {
    const deletion = deleted.get(symbol.id)
    if (deletion) for (const method of symbol.methods) method.changeId = deletion.changeId
  }
  return view
}

export function toDiagramChange(change: Change, model: CodeModel): DiagramChange {
  const delta = change.delta.find((entry) => 'classId' in entry || 'node' in entry)
  const classId = delta && 'classId' in delta ? delta.classId : delta && 'node' in delta ? delta.node.id : model.classes.find((symbol) => change.files.some((file) => file.path === symbol.file))?.id ?? ''
  return {
    id: change.id, number: change.seq, summary: change.summary, time: new Date(change.ts).toISOString().slice(11, 19),
    files: change.files.length, added: change.files.reduce((total, file) => total + file.added, 0),
    deleted: change.files.reduce((total, file) => total + file.deleted, 0), classId
  }
}

export function toDiagramChanges(changes: Change[], model: CodeModel): DiagramChange[] {
  const ordered = [...changes].sort((left, right) => right.seq - left.seq)
  let number = ordered.filter((change) => change.cause.kind !== 'baseline').length
  return ordered.map((change) => ({ ...toDiagramChange(change, model), number: change.cause.kind === 'baseline' ? 0 : number-- }))
}