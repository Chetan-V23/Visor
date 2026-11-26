import { codeModelSchema, graphLanguageSchema, symbolGraphSchema, type ClassSymbol, type CodeModel, type GraphSymbol, type SourceLocation, type SymbolGraph } from './index'

function locations(file: string, range: SourceLocation['range'], saved?: SourceLocation[]): SourceLocation[] {
  return saved ?? [{ file, range, role: 'definition' }]
}

export function graphFromModel(model: CodeModel): SymbolGraph {
  if (model.v === 1) codeModelSchema.parse(model)
  const symbols: GraphSymbol[] = []
  for (const owner of model.classes) {
    const language = graphLanguageSchema.parse(owner.id.split(':', 1)[0])
    symbols.push({ id: owner.id, name: owner.name, kind: owner.kind ?? 'class', language, ownerId: owner.ownerId ?? null,
      locations: locations(owner.file, owner.range, owner.locations), bases: owner.bases })
    for (const member of owner.methods) {
      symbols.push({ id: member.id, name: member.name, kind: owner.kind === 'module' || owner.kind === 'namespace' ? 'function' : 'method',
        language, ownerId: owner.id, locations: locations(owner.file, member.range, member.locations), signature: member.signature,
        docstring: member.docstring, bodyHash: member.bodyHash, ...(member.displayName ? { displayName: member.displayName } : {}), ...(member.declarations ? { declarations: member.declarations } : {}) })
    }
    for (const member of owner.fields) {
      symbols.push({ id: member.id, name: member.name, kind: member.symbolKind ?? 'field', language, ownerId: owner.id,
        locations: locations(owner.file, member.range, member.locations), type: member.type,
        ...(member.initializerHash ? { initializerHash: member.initializerHash } : {}) })
    }
  }
  return symbolGraphSchema.parse({ v: 2, ...(model.analysisVersion !== undefined && { analysisVersion: model.analysisVersion }), symbols, relations: model.relations })
}

export function modelFromGraph(graph: SymbolGraph): CodeModel {
  const owners = new Map<string, ClassSymbol>()
  for (const symbol of graph.symbols) {
    if (!('bases' in symbol)) continue
    const source = symbol.locations.find((location) => location.role === 'definition') ?? symbol.locations[0]
    if (!source) throw new Error('Missing container location.')
    owners.set(symbol.id, { id: symbol.id, name: symbol.name, kind: symbol.kind, ownerId: symbol.ownerId,
      locations: symbol.locations, file: source.file, range: source.range, bases: symbol.bases, methods: [], fields: [] })
  }
  for (const symbol of graph.symbols) {
    if ('bases' in symbol) continue
    const owner = symbol.ownerId && owners.get(symbol.ownerId)
    if (!owner) throw new Error('A callable or field must belong to a container.')
    const source = symbol.locations.find((location) => location.role === 'definition') ?? symbol.locations[0]
    if (!source) throw new Error('Missing member location.')
    const shared = { id: symbol.id, name: symbol.name, range: source.range, locations: symbol.locations }
    if ('signature' in symbol) owner.methods.push({ ...shared, kind: 'method', signature: symbol.signature, docstring: symbol.docstring,
      bodyHash: symbol.bodyHash, ...(symbol.displayName ? { displayName: symbol.displayName } : {}), ...(symbol.declarations ? { declarations: symbol.declarations } : {}) })
    else owner.fields.push({ ...shared, kind: 'field', symbolKind: symbol.kind, type: symbol.type, ...(symbol.initializerHash ? { initializerHash: symbol.initializerHash } : {}) })
  }
  return { v: 2, ...(graph.analysisVersion !== undefined && { analysisVersion: graph.analysisVersion }), classes: [...owners.values()], relations: graph.relations }
}

export function readStoredModel(input: unknown): CodeModel {
  return input && typeof input === 'object' && 'v' in input && input.v === 2
    ? modelFromGraph(symbolGraphSchema.parse(input)) : codeModelSchema.parse(input)
}