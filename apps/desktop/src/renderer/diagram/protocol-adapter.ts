import type { Change, CodeModel, MethodSymbol, Relation } from '@visor/protocol'
import type { DiagramChange, DiagramEdge, DiagramView } from './types'

function relationId(relation: Relation): string {
  return `${relation.kind}:${relation.from}->${relation.to}:${relation.label ?? ''}`
}

export function toDiagramView(model: CodeModel, change: Change | null): Pick<DiagramView, 'classes' | 'edges'> {
  const classes = new Map(model.classes.map((symbol) => [symbol.id, structuredClone(symbol)]))
  const addedClasses = new Set<string>()
  const removedClasses = new Set<string>()
  const modifiedClasses = new Set<string>()
  const addedMembers = new Set<string>()
  const modifiedMembers = new Set<string>()
  const removedMembers = new Map<string, MethodSymbol[]>()
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
  const classesByFile = new Map<string, CodeModel['classes']>()
  for (const symbol of classes.values()) {
    owners.set(symbol.id, symbol.id)
    for (const member of [...symbol.methods, ...symbol.fields]) owners.set(member.id, symbol.id)
    if (!removedClasses.has(symbol.id)) {
      const siblings = classesByFile.get(symbol.file) ?? []
      siblings.push(symbol)
      classesByFile.set(symbol.file, siblings)
    }
  }
  const touchLine = (file: string, line: number, deleted = false): void => {
    let closest: CodeModel['classes'][number] | undefined
    let smallestSpan = Infinity
    for (const symbol of classesByFile.get(file) ?? []) {
      const range = symbol.range
      if (!range || line < range.start.line || line > range.end.line || (line === range.end.line && range.end.column === 0)) continue
      const span = range.end.line - range.start.line
      if (span < smallestSpan) { closest = symbol; smallestSpan = span }
    }
    if (deleted && closest?.range?.start.line === line) { touchLine(file, line - 1); return }
    if (closest) modifiedClasses.add(closest.id)
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
  const visibleClasses = change && change.cause.kind !== 'baseline'
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
  return {
    classes: [...classes.values()].filter((symbol) => visibleClasses.has(symbol.id)).map((symbol) => {
      const removed = removedMembers.get(symbol.id) ?? []
      const removedIds = new Set(removed.map((method) => method.id))
      return {
        id: symbol.id, name: symbol.name, file: symbol.file, kind: symbol.kind,
        change: removedClasses.has(symbol.id) ? 'deleted' : addedClasses.has(symbol.id) ? 'added' : modifiedClasses.has(symbol.id) ? 'modified' : 'unchanged',
        methods: [...symbol.methods.filter((method) => !removedIds.has(method.id)), ...removed].map((method) => ({
          id: method.id, name: method.displayName ?? method.name, signature: method.signature, docstring: method.docstring,
          change: removedClasses.has(symbol.id) || removedIds.has(method.id) ? 'deleted' : addedClasses.has(symbol.id) || addedMembers.has(method.id) ? 'added' : 'unchanged',
          modified: modifiedMembers.has(method.id), changeId: change?.id
        }))
      }
    }),
    edges: [...relations.entries()].flatMap(([id, entry]) => {
      const from = owners.get(entry.relation.from)
      const to = owners.get(entry.relation.to)
      return from && to && visibleClasses.has(from) && visibleClasses.has(to) ? [{ id, from, to, label: entry.relation.label ?? entry.relation.kind, kind: entry.relation.kind, certainty: entry.relation.certainty, evidence: entry.relation.evidence, change: entry.change }] : []
    })
  }
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