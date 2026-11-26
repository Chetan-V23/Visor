import { z } from 'zod'

export const versionSchema = z.literal(1)
export const languageSchema = z.enum(['py', 'cpp', 'cs'])
export const pathSchema = z.string().min(1).regex(/^(?!\/)(?!.*\\)(?!.*\/\/)(?!.*\/$)(?!.*(?:^|\/)\.\.?(?:\/|$))[^:\u0000-\u001f]+$/)
export const symbolIdSchema = z.string().regex(/^(py|cpp|cs):[^:\\]+::(?:[A-Za-z_][\w.]*|<module>)$/).refine((id) => {
  return pathSchema.safeParse(id.slice(id.indexOf(':') + 1, id.indexOf('::'))).success
}, 'Symbol IDs must contain a workspace-relative path.')
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.string().min(1)
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const timestampSchema = sequenceSchema.max(8640000000000000)
const sourceSchema = z.string().regex(/^[a-z][a-z0-9-]*$/)

export const positionSchema = z.object({ line: z.number().int().positive(), column: sequenceSchema }).strip()
export const rangeSchema = z.object({ start: positionSchema, end: positionSchema }).strip().refine(({ start, end }) => {
  return end.line > start.line || (end.line === start.line && end.column >= start.column)
}, 'Range end must not precede its start.')

export const methodSymbolSchema = z.object({
  kind: z.literal('method'), id: symbolIdSchema, name: identitySchema,
  displayName: identitySchema.optional(), signature: identitySchema, docstring: z.string(),
  range: rangeSchema.nullable(), bodyHash: hashSchema.nullable()
}).strip()
export const fieldSymbolSchema = z.object({
  kind: z.literal('field'), id: symbolIdSchema, name: identitySchema,
  type: z.string().nullable(), range: rangeSchema.nullable(), initializerHash: hashSchema.optional()
}).strip()
export const memberSymbolSchema = z.discriminatedUnion('kind', [methodSymbolSchema, fieldSymbolSchema])
export const classSymbolSchema = z.object({
  id: symbolIdSchema, name: identitySchema, file: pathSchema, range: rangeSchema.nullable(),
  kind: z.enum(['class', 'module']).optional(),
  bases: z.array(identitySchema), methods: z.array(methodSymbolSchema), fields: z.array(fieldSymbolSchema)
}).strip().superRefine((symbol, context) => {
  if (symbol.id.slice(symbol.id.indexOf(':') + 1, symbol.id.indexOf('::')) !== symbol.file) {
    context.addIssue({ code: 'custom', path: ['file'], message: 'Class file must match its symbol ID.' })
  }
  const seen = new Set<string>()
  const owner = symbol.kind === 'module' ? symbol.id.slice(0, symbol.id.indexOf('::') + 2) : `${symbol.id}.`
  if ((symbol.kind === 'module') !== symbol.id.endsWith('::<module>')) {
    context.addIssue({ code: 'custom', path: ['id'], message: 'Module nodes must use the reserved module ID.' })
  }
  for (const [collection, members] of Object.entries({ methods: symbol.methods, fields: symbol.fields })) {
    for (const [index, member] of members.entries()) {
      if (member.id !== `${owner}${member.name}` || seen.has(member.id)) {
        context.addIssue({ code: 'custom', path: [collection, index, 'id'], message: 'Member IDs must be unique and owned by their class.' })
      }
      seen.add(member.id)
    }
  }
})
export const relationKindSchema = z.enum(['inherits', 'composes', 'associates', 'aggregates', 'depends', 'connects', 'calls', 'imports'])
export const relationEvidenceSchema = z.object({ file: pathSchema, range: rangeSchema.nullable(), reason: z.string() }).strip()
export const symbolReferenceSchema = z.object({ name: identitySchema, range: rangeSchema.nullable() }).strip()
export const relationCandidateSchema = z.object({
  from: symbolReferenceSchema, to: symbolReferenceSchema, kind: relationKindSchema,
  label: z.string(), certainty: z.enum(['declared', 'inferred', 'unknown']), evidence: relationEvidenceSchema
}).strip()
export const relationSchema = z.object({
  from: symbolIdSchema, to: symbolIdSchema, kind: relationKindSchema,
  label: z.string().optional(), certainty: z.enum(['declared', 'inferred', 'unknown']),
  evidence: z.array(relationEvidenceSchema).optional(),
  data: z.object({ parameters: z.array(z.object({ name: identitySchema, type: z.string().nullable() }).strip()), returnType: z.string().nullable() }).strip().optional()
}).strip()
export const fileModelSchema = z.object({
  v: versionSchema, language: languageSchema, file: pathSchema,
  classes: z.array(classSymbolSchema), functions: z.array(methodSymbolSchema), imports: z.array(identitySchema),
  analysis: z.object({
    hash: hashSchema,
    bindings: z.array(z.object({ local: identitySchema, module: z.string(), name: z.string().nullable() }).strip()),
    relations: z.array(relationCandidateSchema)
  }).strip().optional()
}).strip().refine((model) => model.classes.every((symbol) => symbol.file === model.file && symbol.id.startsWith(`${model.language}:`)), 'File classes must match the file and language.')

export const semanticDocumentSchema = z.object({
  v: versionSchema, workspaceRoot: z.string().min(1).max(4096), file: pathSchema, hash: hashSchema,
  provider: z.string().min(1).max(128),
  definitions: z.array(z.object({
    position: positionSchema,
    targets: z.array(z.object({ file: pathSchema, hash: hashSchema, range: rangeSchema }).strip()).max(32)
  }).strip()).max(512)
}).strip()
export const semanticQuerySchema = semanticDocumentSchema.pick({ v: true, workspaceRoot: true, file: true, hash: true })
export const semanticQueryResponseSchema = z.object({ positions: z.array(positionSchema).max(512) }).strip()
export const codeModelSchema = z.object({
  v: versionSchema, classes: z.array(classSymbolSchema), relations: z.array(relationSchema)
}).strip().superRefine((model, context) => {
  const ids = new Set<string>()
  for (const [index, symbol] of model.classes.entries()) {
    if (ids.has(symbol.id)) context.addIssue({ code: 'custom', path: ['classes', index, 'id'], message: 'Class IDs must be unique.' })
    ids.add(symbol.id)
    for (const member of [...symbol.methods, ...symbol.fields]) ids.add(member.id)
  }
  for (const [index, relation] of model.relations.entries()) {
    for (const endpoint of ['from', 'to'] satisfies ('from' | 'to')[]) {
      if (!ids.has(relation[endpoint])) context.addIssue({ code: 'custom', path: ['relations', index, endpoint], message: 'Relation endpoints must exist in the model.' })
    }
  }
})

export const graphLanguageSchema = z.enum(['py', 'cpp', 'cs', 'js', 'ts'])
const graphIdSchema = z.string().regex(/^(?:py|cpp|cs|js|ts):[^\u0000-\u001f]+::[^\u0000-\u001f]+$/)
export const sourceLocationSchema = z.object({
  file: pathSchema, range: rangeSchema.nullable(), role: z.enum(['declaration', 'definition'])
})
export const containerKindSchema = z.enum(['module', 'namespace', 'class', 'struct', 'interface', 'record', 'enum', 'type'])
const graphSymbolBase = z.object({
  id: graphIdSchema, name: identitySchema, language: graphLanguageSchema, ownerId: graphIdSchema.nullable(),
  locations: z.array(sourceLocationSchema).min(1)
})
export const graphSymbolSchema = z.discriminatedUnion('kind', [
  graphSymbolBase.extend({ kind: containerKindSchema, bases: z.array(identitySchema) }),
  graphSymbolBase.extend({ kind: z.enum(['function', 'method']), signature: z.string(), docstring: z.string(), bodyHash: hashSchema.nullable(), displayName: identitySchema.optional(), declarations: z.array(z.string()).optional() }),
  graphSymbolBase.extend({ kind: z.enum(['field', 'property', 'event']), type: z.string().nullable(), initializerHash: hashSchema.optional() })
])
export const graphRelationSchema = relationSchema.extend({ from: graphIdSchema, to: graphIdSchema })
const analysisVersion = z.number().int().positive().optional()
export const symbolGraphSchema = z.object({
  v: z.literal(2), analysisVersion, symbols: z.array(graphSymbolSchema), relations: z.array(graphRelationSchema)
}).superRefine((graph, context) => {
  const ids = new Set<string>()
  for (const [index, symbol] of graph.symbols.entries()) {
    if (ids.has(symbol.id) || !symbol.id.startsWith(`${symbol.language}:`)) {
      context.addIssue({ code: 'custom', path: ['symbols', index, 'id'], message: 'Symbol IDs must be unique and match their language.' })
    }
    ids.add(symbol.id)
  }
  const byId = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]))
  const visited = new Set<string>()
  for (const [index, symbol] of graph.symbols.entries()) {
    const owner = symbol.ownerId === null ? null : byId.get(symbol.ownerId)
    if (owner ? !('bases' in owner) || owner.language !== symbol.language : symbol.ownerId !== null || !('bases' in symbol)) {
      context.addIssue({ code: 'custom', path: ['symbols', index, 'ownerId'], message: 'Members require a container in the same language.' })
    }
    const chain = new Set<string>()
    let id: string | null = symbol.id
    while (id !== null && !visited.has(id)) {
      if (chain.has(id)) { context.addIssue({ code: 'custom', path: ['symbols', index, 'ownerId'], message: 'Symbol ownership must be acyclic.' }); break }
      chain.add(id); id = byId.get(id)?.ownerId ?? null
    }
    for (const seen of chain) visited.add(seen)
  }
  for (const [index, relation] of graph.relations.entries()) {
    if (!ids.has(relation.from) || !ids.has(relation.to)) {
      context.addIssue({ code: 'custom', path: ['relations', index], message: 'Both relation endpoints must exist.' })
    }
  }
})
export type GraphLanguage = z.infer<typeof graphLanguageSchema>
export type SourceLocation = z.infer<typeof sourceLocationSchema>
export type GraphSymbol = z.infer<typeof graphSymbolSchema>
export type SymbolGraph = z.infer<typeof symbolGraphSchema>

const locations = z.array(sourceLocationSchema).min(1).optional()
const projectedMethod = methodSymbolSchema.extend({ id: graphIdSchema, locations, declarations: z.array(z.string()).optional() })
const projectedField = fieldSymbolSchema.extend({ id: graphIdSchema, locations, symbolKind: z.enum(['field', 'property', 'event']).optional() })
const projectedMember = z.discriminatedUnion('kind', [projectedMethod, projectedField])
const projectedContainer = z.object({ ...classSymbolSchema.shape, id: graphIdSchema, kind: containerKindSchema.optional(),
  ownerId: graphIdSchema.nullable().optional(), locations, methods: z.array(projectedMethod), fields: z.array(projectedField) })
export const diagramModelSchema = z.discriminatedUnion('v', [codeModelSchema, z.object({ v: z.literal(2), analysisVersion, classes: z.array(projectedContainer), relations: z.array(graphRelationSchema) })])

const eventBase = {
  v: versionSchema, id: z.uuid(), sessionId: identitySchema, seq: sequenceSchema,
  ts: timestampSchema, source: sourceSchema, agentTimestamp: z.iso.datetime().optional()
}
const editIntentSchema = z.enum(['create', 'edit', 'delete', 'rename'])
const editPayload = {
  tool: identitySchema, toolCallId: identitySchema.optional(),
  files: z.array(pathSchema).min(1), intent: editIntentSchema,
  mentionedClasses: z.array(symbolIdSchema).max(4096).optional(), mentionedSymbols: z.array(graphIdSchema).max(4096).optional()
}
export const visorEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...eventBase, kind: z.literal('session.started'), payload: z.object({ workspaceId: identitySchema, model: z.string().optional() }).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('session.ended'), payload: z.object({ reason: z.string().nullable() }).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('turn.ended'), payload: z.object({ stopHookActive: z.boolean() }).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('prompt.submitted'), payload: z.object({ text: z.string() }).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('edit.pending'), payload: z.object(editPayload).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('edit.applied'), payload: z.object({ ...editPayload, outcome: z.enum(['succeeded', 'failed', 'unknown']) }).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('file.created'), payload: z.object({ file: pathSchema }).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('file.deleted'), payload: z.object({ file: pathSchema }).strip() }).strip(),
  z.object({ ...eventBase, kind: z.literal('file.renamed'), payload: z.object({ from: pathSchema, to: pathSchema }).strip() }).strip()
])

export const hunkSchema = z.object({
  oldStart: sequenceSchema, oldLines: sequenceSchema, newStart: sequenceSchema, newLines: sequenceSchema,
  lines: z.array(z.object({ kind: z.enum(['context', 'added', 'deleted']), text: z.string() }).strip())
}).strip()
export const graphDeltaSchema = z.discriminatedUnion('op', [
  z.object({ v: versionSchema, op: z.literal('node.add'), node: classSymbolSchema, insertedBetween: z.tuple([symbolIdSchema, symbolIdSchema]).optional() }).strip(),
  z.object({ v: versionSchema, op: z.literal('node.remove'), node: classSymbolSchema }).strip(),
  z.object({ v: versionSchema, op: z.literal('node.rename'), from: symbolIdSchema, to: symbolIdSchema }).strip(),
  z.object({ v: versionSchema, op: z.literal('member.add'), classId: symbolIdSchema, member: memberSymbolSchema }).strip(),
  z.object({ v: versionSchema, op: z.literal('member.remove'), classId: symbolIdSchema, member: memberSymbolSchema }).strip(),
  z.object({ v: versionSchema, op: z.literal('member.change'), classId: symbolIdSchema, before: memberSymbolSchema, after: memberSymbolSchema }).strip().refine((delta) => delta.before.id === delta.after.id && delta.before.kind === delta.after.kind, 'Member changes must preserve identity and kind.'),
  z.object({ v: versionSchema, op: z.literal('edge.add'), relation: relationSchema }).strip(),
  z.object({ v: versionSchema, op: z.literal('edge.remove'), relation: relationSchema }).strip(),
  z.object({ v: versionSchema, op: z.literal('code.hunks'), file: pathSchema, symbolId: symbolIdSchema.optional(), hunks: z.array(hunkSchema) }).strip()
])
export const changeFileSchema = z.object({
  path: pathSchema, beforeHash: hashSchema.nullable(), afterHash: hashSchema.nullable(),
  added: sequenceSchema, deleted: sequenceSchema
}).strip()
export const changeSchema = z.object({
  v: versionSchema, id: z.uuid(), sessionId: identitySchema, seq: sequenceSchema, ts: timestampSchema,
  cause: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('tool'), eventId: z.uuid(), tool: identitySchema, toolCallId: identitySchema.optional(), relatedEventIds: z.array(z.uuid()).optional(), mentionedClasses: z.array(symbolIdSchema).max(4096).optional() }).strip(),
    z.object({ kind: z.literal('external'), eventIds: z.array(z.uuid()).min(1), source: sourceSchema }).strip(),
    z.object({ kind: z.literal('baseline'), eventId: z.uuid(), observedAt: z.enum(['session-start', 'before-first-edit', 'after-first-edit']) }).strip()
  ]),
  summary: identitySchema, files: z.array(changeFileSchema), delta: z.array(graphDeltaSchema)
}).strip().refine((change) => (change.seq === 0) === (change.cause.kind === 'baseline'), 'Only a baseline may use change sequence zero.')
export const sessionSummarySchema = z.object({
  v: versionSchema, id: identitySchema, title: z.string().nullable(), startedAt: timestampSchema,
  source: sourceSchema.optional(),
  startObserved: z.boolean(), project: z.object({ id: identitySchema, name: identitySchema, branch: z.string() }).strip()
}).strip()

const v2 = z.literal(2)
const deltaV2 = z.discriminatedUnion('op', [
  z.object({ v: v2, op: z.literal('node.add'), node: projectedContainer, insertedBetween: z.tuple([graphIdSchema, graphIdSchema]).optional() }),
  z.object({ v: v2, op: z.literal('node.remove'), node: projectedContainer }),
  z.object({ v: v2, op: z.literal('node.rename'), from: graphIdSchema, to: graphIdSchema }),
  z.object({ v: v2, op: z.literal('member.add'), classId: graphIdSchema, member: projectedMember }),
  z.object({ v: v2, op: z.literal('member.remove'), classId: graphIdSchema, member: projectedMember }),
  z.object({ v: v2, op: z.literal('member.change'), classId: graphIdSchema, before: projectedMember, after: projectedMember }).refine((delta) => delta.before.id === delta.after.id && delta.before.kind === delta.after.kind),
  z.object({ v: v2, op: z.literal('edge.add'), relation: graphRelationSchema }),
  z.object({ v: v2, op: z.literal('edge.remove'), relation: graphRelationSchema }),
  z.object({ v: v2, op: z.literal('code.hunks'), file: pathSchema, symbolId: graphIdSchema.optional(), hunks: z.array(hunkSchema) })
])
const [toolCause, externalCause, baselineCause] = changeSchema.shape.cause.options
const changeV2 = z.object({ ...changeSchema.shape, v: v2, delta: z.array(deltaV2), cause: z.discriminatedUnion('kind', [
  toolCause.extend({ mentionedClasses: z.array(graphIdSchema).max(4096).optional() }), externalCause, baselineCause
]) }).refine((change) => (change.seq === 0) === (change.cause.kind === 'baseline'))
export const storedChangeSchema = z.discriminatedUnion('v', [changeSchema, changeV2])
export const diagramFixtureSchema = z.object({
  v: versionSchema, session: sessionSummarySchema, model: codeModelSchema, changes: z.array(changeSchema)
}).strip()

export type Language = z.infer<typeof languageSchema>
export type SourceRange = z.infer<typeof rangeSchema>
export type MethodSymbol = z.infer<typeof projectedMethod>
export type FieldSymbol = z.infer<typeof projectedField>
export type ClassSymbol = z.infer<typeof projectedContainer>
export type Relation = z.infer<typeof relationSchema>
export type RelationCandidate = z.infer<typeof relationCandidateSchema>
export type SymbolReference = z.infer<typeof symbolReferenceSchema>
export type SemanticDocument = z.infer<typeof semanticDocumentSchema>
export type FileModel = z.infer<typeof fileModelSchema>
export interface CodeModel { v: 1 | 2; analysisVersion?: number; classes: ClassSymbol[]; relations: Relation[] }
export type VisorEvent = z.infer<typeof visorEventSchema>
type Versioned<T> = T extends { v: number } ? Omit<T, 'v'> & { v: 1 | 2 } : never
export type GraphDelta = Versioned<z.infer<typeof deltaV2>>
export type Change = Omit<Versioned<z.infer<typeof changeV2>>, 'delta'> & { delta: GraphDelta[] }
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export interface HarnessAdapter<Raw> {
  source: string
  toEvents(raw: Raw): VisorEvent[]
}
export interface LanguageExtractor {
  language: GraphLanguage
  matches(path: string): boolean
  extract(path: string, text: string, scope?: string): FileModel | SymbolFile
}

export interface SymbolFile {
  v: 2; language: GraphLanguage; file: string; hash: string; symbols: GraphSymbol[]
  selections: { id: string; range: SourceRange }[]
  references: { from: string; name: string; kind: Relation['kind']; range: SourceRange; module?: string }[]
  imports: { local: string; name: string; module: string }[]
  exports: { name: string; id: string }[]
  partial: string[]
}

export const protocolSchemas = {
  VisorEvent: visorEventSchema, CodeModel: codeModelSchema, Change: changeSchema, GraphDelta: graphDeltaSchema,
  ClassSymbol: classSymbolSchema, MethodSymbol: methodSymbolSchema, FieldSymbol: fieldSymbolSchema,
  Relation: relationSchema, FileModel: fileModelSchema, SessionSummary: sessionSummarySchema
}

export function protocolJsonSchemas(version: 1 | 2 = 1) {
  const schemas = version === 1 ? protocolSchemas : { SymbolGraph: symbolGraphSchema, Change: changeV2, GraphDelta: deltaV2 }
  return Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]))
}

export { graphFromModel, modelFromGraph, readStoredModel } from './projection'
export { grammarExtensions, grammarForFile, isProjectMarker, sourceGlob, type Grammar } from './languages'
