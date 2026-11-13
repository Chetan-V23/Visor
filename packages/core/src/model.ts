import { posix } from 'node:path'
import { codeModelSchema, type ClassSymbol, type CodeModel, type FileModel, type GraphDelta, type Relation, type SemanticDocument, type SymbolReference } from '@visor/protocol'

export function assembleModel(files: FileModel[], semantic: SemanticDocument[] = []): CodeModel {
  const classes = files.flatMap((file) => file.classes)
  const byId = new Map(classes.map((symbol) => [symbol.id, symbol]))
  const modules = new Map(files.map((file) => [file.file.replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.'), file]))
  const resolve = (file: FileModel, reference: SymbolReference, seen = new Set<string>()): ClassSymbol | undefined => {
    const identity = `${file.file}:${reference.name}`
    if (seen.has(identity)) return undefined
    seen.add(identity)
    const exact = byId.get(reference.name)
    if (exact) return exact
    const local = file.classes.filter((candidate) => candidate.name === reference.name)
    if (local.length === 1) return local[0]
    const binding = file.analysis?.bindings.find((item) => reference.name === item.local || reference.name.startsWith(`${item.local}.`))
    if (binding) {
      const relative = binding.module.match(/^\.+/)?.[0].length ?? 0
      const base = posix.dirname(file.file).split('/').filter((part) => part !== '.')
      const moduleName = relative ? [...base.slice(0, Math.max(0, base.length - relative + 1)), binding.module.slice(relative)].filter(Boolean).join('.') : binding.module
      const imported = modules.get(moduleName)
      const name = binding.name ? `${binding.name}${reference.name.slice(binding.local.length)}` : reference.name.slice(binding.local.length + 1)
      if (imported && name) { const target = resolve(imported, { name, range: null }, seen); if (target) return target }
    }
    const facts = semantic.find((document) => document.file === file.file && document.hash === file.analysis?.hash)
    const resolved = new Map<string, ClassSymbol>()
    for (const target of facts?.definitions.find((entry) => entry.position.line === reference.range?.start.line && entry.position.column === reference.range.start.column)?.targets ?? []) {
      const targetFile = files.find((candidate) => candidate.file === target.file && candidate.analysis?.hash === target.hash)
      const matches = targetFile?.classes.filter((candidate) => candidate.range && candidate.range.start.line <= target.range.start.line && candidate.range.end.line >= target.range.end.line)
      const match = matches?.sort((first, second) => (first.range?.end.line ?? 0) - (first.range?.start.line ?? 0) - (second.range?.end.line ?? 0) + (second.range?.start.line ?? 0))[0]
      if (match) resolved.set(match.id, match)
    }
    return resolved.size === 1 ? resolved.values().next().value : undefined
  }
  const relations: Relation[] = []
  for (const symbol of classes) {
    const file = files.find((candidate) => candidate.file === symbol.file)
    if (!file) continue
    for (const base of symbol.bases) {
      const target = resolve(file, { name: base, range: null })
      if (target && target.id !== symbol.id) relations.push({ from: symbol.id, to: target.id, kind: 'inherits', certainty: 'declared' })
    }
    for (const field of symbol.fields) {
      if (file.analysis?.relations.some((candidate) => candidate.from.name === symbol.id && candidate.label === field.name)) continue
      const target = field.type ? resolve(file, { name: field.type, range: field.range }) : undefined
      if (target && target.id !== symbol.id) relations.push({ from: symbol.id, to: target.id, kind: 'associates', certainty: 'inferred', label: field.name })
    }
  }
  for (const file of files) for (const candidate of file.analysis?.relations ?? []) {
    const from = resolve(file, candidate.from)
    const to = resolve(file, candidate.to)
    if (from && to && (from.id !== to.id || candidate.kind === 'connects')) relations.push({ from: from.id, to: to.id, kind: candidate.kind, label: candidate.label, certainty: candidate.certainty, evidence: [candidate.evidence] })
  }
  const strong = new Set(relations.filter((relation) => ['composes', 'aggregates', 'associates'].includes(relation.kind)).map((relation) => `${relation.from}->${relation.to}`))
  const grouped = new Map<string, Relation>()
  for (const relation of relations) {
    if (relation.kind === 'depends' && strong.has(`${relation.from}->${relation.to}`)) continue
    const key = `${relation.kind}:${relation.from}->${relation.to}`
    const prior = grouped.get(key)
    if (!prior) grouped.set(key, relation)
    else {
      prior.label = [...new Set([...(prior.label?.split(' / ') ?? []), ...(relation.label ? [relation.label] : [])])].sort().join(' / ')
      if (relation.evidence) prior.evidence = [...(prior.evidence ?? []), ...relation.evidence].filter((evidence, index, all) => all.findIndex((item) => JSON.stringify(item) === JSON.stringify(evidence)) === index)
    }
  }
  return codeModelSchema.parse({ v: 1, classes, relations: [...grouped.values()] })
}

function relationKey(relation: Relation): string { const { evidence, ...content } = relation; void evidence; return JSON.stringify(content) }

export function diffModels(before: CodeModel, after: CodeModel): GraphDelta[] {
  const delta: GraphDelta[] = []
  const oldClasses = new Map(before.classes.map((symbol) => [symbol.id, symbol]))
  const newClasses = new Map(after.classes.map((symbol) => [symbol.id, symbol]))
  for (const node of before.classes) if (!newClasses.has(node.id)) delta.push({ v: 1, op: 'node.remove', node })
  for (const node of after.classes) {
    const prior = oldClasses.get(node.id)
    if (!prior) {
      const insertion = before.relations.find((edge) => {
        return !after.relations.some((candidate) => relationKey(candidate) === relationKey(edge))
          && after.relations.some((candidate) => candidate.from === edge.from && candidate.to === node.id && candidate.kind === edge.kind)
          && after.relations.some((candidate) => candidate.from === node.id && candidate.to === edge.to && candidate.kind === edge.kind)
      })
      delta.push({ v: 1, op: 'node.add', node, ...(insertion ? { insertedBetween: [insertion.from, insertion.to] as [string, string] } : {}) })
      continue
    }
    if (JSON.stringify(prior.bases) !== JSON.stringify(node.bases)) delta.push({ v: 1, op: 'code.hunks', file: node.file, symbolId: node.id, hunks: [] })
    const oldMembers = new Map([...prior.methods, ...prior.fields].map((member) => [member.id, member]))
    const newMembers = new Map([...node.methods, ...node.fields].map((member) => [member.id, member]))
    for (const member of oldMembers.values()) {
      const current = newMembers.get(member.id)
      if (!current || member.kind !== current.kind) delta.push({ v: 1, op: 'member.remove', classId: node.id, member })
    }
    for (const member of newMembers.values()) {
      const previous = oldMembers.get(member.id)
      if (!previous || previous.kind !== member.kind) delta.push({ v: 1, op: 'member.add', classId: node.id, member })
      else {
        const { range: oldRange, ...oldContent } = previous
        const { range: newRange, ...newContent } = member
        void oldRange
        void newRange
        if (JSON.stringify(oldContent) !== JSON.stringify(newContent)) delta.push({ v: 1, op: 'member.change', classId: node.id, before: previous, after: member })
      }
    }
  }
  const oldEdges = new Map(before.relations.map((edge) => [relationKey(edge), edge]))
  const newEdges = new Map(after.relations.map((edge) => [relationKey(edge), edge]))
  for (const [key, relation] of oldEdges) if (!newEdges.has(key)) delta.push({ v: 1, op: 'edge.remove', relation })
  for (const [key, relation] of newEdges) if (!oldEdges.has(key)) delta.push({ v: 1, op: 'edge.add', relation })
  return delta
}

export function summarize(delta: GraphDelta[], fileCount: number): string {
  const added = delta.filter((item) => item.op === 'node.add')
  if (added.length) return `Added ${added.length === 1 ? `class ${added[0]?.node.name}` : `${added.length} classes`}`
  const removed = delta.filter((item) => item.op === 'node.remove')
  if (removed.length) return `Removed ${removed.length === 1 ? `class ${removed[0]?.node.name}` : `${removed.length} classes`}`
  const member = delta.find((item) => item.op === 'member.change' || item.op === 'member.add' || item.op === 'member.remove')
  if (member && (member.op === 'member.change' || member.op === 'member.add' || member.op === 'member.remove')) {
    const name = member.op === 'member.change' ? member.after.id : member.member.id
    return `${member.op === 'member.add' ? 'Added' : member.op === 'member.remove' ? 'Removed' : 'Changed'} ${name.slice(name.indexOf('::') + 2)}`
  }
  return `Changed ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
}