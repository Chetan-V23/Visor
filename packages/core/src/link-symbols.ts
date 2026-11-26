import { posix } from 'node:path'
import { symbolGraphSchema, type GraphSymbol, type SemanticDocument, type SourceRange, type SymbolFile, type SymbolGraph } from '@visor/protocol'

function includesPoint(range: SourceRange, point: SourceRange['start']): boolean {
  return (range.start.line < point.line || range.start.line === point.line && range.start.column <= point.column)
    && (range.end.line > point.line || range.end.line === point.line && range.end.column > point.column)
}

export function linkSymbols(files: SymbolFile[], facts: SemanticDocument[]): SymbolGraph {
  const byPath = new Map(files.map((file) => [file.file, file]))
  const groups = new Map<string, { file: SymbolFile; symbol: GraphSymbol }[]>()
  for (const file of files) for (const symbol of file.symbols) {
    const group = groups.get(symbol.id) ?? []
    group.push({ file, symbol }); groups.set(symbol.id, group)
  }
  const symbols = new Map<string, GraphSymbol>()
  for (const [id, group] of groups) {
    const definitions = group.filter(({ symbol }) => symbol.locations.some((source) => source.role === 'definition'))
    const primary = (definitions[0] ?? group[0])?.symbol
    if (!primary || group.some(({ symbol }) => symbol.kind !== primary.kind || symbol.ownerId !== primary.ownerId)) continue
    if (definitions.length > 1 && primary.kind !== 'namespace' && !group.every(({ file }) => file.partial.includes(id))) continue
    const merged = { ...primary, locations: group.flatMap(({ symbol }) => symbol.locations) }
    if ('bases' in merged) merged.bases = [...new Set(group.flatMap(({ symbol }) => 'bases' in symbol ? symbol.bases : []))]
    if ('signature' in merged && group.length > 1) merged.declarations = [...new Set(group.flatMap(({ symbol }) => 'signature' in symbol && symbol.bodyHash === null ? [symbol.signature] : []))].sort()
    symbols.set(id, merged)
  }
  for (const symbol of symbols.values()) {
    let owner = symbol.ownerId
    const seen = new Set([symbol.id])
    while (owner !== null) {
      const parent = symbols.get(owner)
      if (!parent || seen.has(owner)) { symbols.delete(symbol.id); break }
      seen.add(owner); owner = parent.ownerId
    }
  }
  const membersByName = new Map<string, GraphSymbol[]>()
  for (const symbol of symbols.values()) {
    const key = `${symbol.ownerId}\n${symbol.name}`
    const members = membersByName.get(key) ?? []; members.push(symbol); membersByName.set(key, members)
  }
  const moduleFor = (file: SymbolFile, spec: string): SymbolFile | undefined => {
    if (!spec.startsWith('.') && file.language !== 'cpp') return undefined
    const base = posix.join(posix.dirname(file.file), spec)
    const exact = byPath.get(base)
    if (exact) return file.language === 'cpp' ? exact.language === 'cpp' ? exact : undefined : exact.language === 'js' || exact.language === 'ts' ? exact : undefined
    if (file.language === 'cpp') return undefined
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '')
    const candidates = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'].flatMap((ext) => [stem + ext, `${base}/index${ext}`]).filter((path) => byPath.has(path))
    return candidates.length === 1 ? byPath.get(candidates[0] ?? '') : undefined
  }
  const relations = new Map<string, SymbolGraph['relations'][number]>()
  for (const file of files) for (const ref of file.references) {
    const from = symbols.get(ref.from)
    if (!from) continue
    const matchesKind = (candidate: GraphSymbol) => ref.kind === 'calls' ? 'signature' in candidate : ref.kind === 'inherits' ? 'bases' in candidate : ref.kind === 'imports' ? candidate.kind === 'module' : true
    let targets: GraphSymbol[] = []
    const provider = facts.find((fact) => fact.file === file.file && fact.hash === file.hash)?.definitions.find((item) => item.position.line === ref.range.start.line && item.position.column === ref.range.start.column)
    const observed = provider?.targets.filter((target) => byPath.get(target.file)?.hash === target.hash) ?? []
    if (observed.length && !ref.module) {
      for (const target of observed) {
        const document = byPath.get(target.file)
        if (!document) continue
        const selected = document.selections.filter((entry) => includesPoint(entry.range, target.range.start))
        const found = selected.flatMap(({ id }) => { const symbol = symbols.get(id); return symbol ? [symbol] : [] })
        targets.push(...(found.length ? found : document.symbols.filter((symbol) => symbol.locations.some((loc) => loc.range &&
          loc.range.start.line === target.range.start.line && loc.range.start.column === target.range.start.column && loc.range.end.line === target.range.end.line && loc.range.end.column === target.range.end.column))))
      }
    } else if (ref.module) {
      const target = moduleFor(file, ref.module)
      if (target) targets = target.symbols.filter((symbol) => symbol.kind === 'module')
    } else {
      const [head, ...tail] = ref.name.replace(/::/g, '.').split('.')
      const binding = file.imports.find((entry) => entry.local === head)
      if (binding) {
        const target = moduleFor(file, binding.module)
        const exportName = binding.name === '*' ? tail.shift() ?? 'default' : binding.name
        const exported = target?.exports.filter((item) => item.name === exportName) ?? []
        targets = exported.flatMap((item) => { const id = tail.length ? `${item.id}.${tail.join('.')}` : item.id; const found = symbols.get(id); return found ? [found] : [] })
      } else {
        const name = ref.name.replace(/^(?:this\.|this->)/, '').replace(/::/g, '.')
        let parent: GraphSymbol | undefined = from
        while (parent && !targets.length) {
          targets = (membersByName.get(`${parent.id}\n${name}`) ?? []).filter(matchesKind)
          parent = parent.ownerId ? symbols.get(parent.ownerId) : undefined
        }
        const prefix = from.id.slice(0, from.id.indexOf('::') + 2)
        const exact = symbols.get(prefix + name)
        if (!targets.length && exact) targets = [exact]
        if (!targets.length && !name.includes('.')) targets = file.symbols.filter((symbol) => symbol.name === name && symbol.ownerId === null && matchesKind(symbol))
      }
    }
    const ids = new Set(targets.filter(matchesKind).map((target) => target.id).filter((id) => symbols.has(id)))
    if (ids.size !== 1) continue
    const [to] = ids
    if (!to) continue
    const key = JSON.stringify([from.id, ref.kind, to])
    const fromProvider = observed.length > 0 && !ref.module
    const evidence = { file: file.file, range: ref.range, reason: fromProvider ? 'saved-definition' : 'source-reference' }
    const existing = relations.get(key)
    if (existing) existing.evidence?.push(evidence)
    else relations.set(key, { from: from.id, to, kind: ref.kind, certainty: ref.kind === 'imports' || ref.kind === 'inherits' || fromProvider ? 'declared' : 'inferred', evidence: [evidence] })
  }
  return symbolGraphSchema.parse({ v: 2, symbols: [...symbols.values()], relations: [...relations.values()] })
}