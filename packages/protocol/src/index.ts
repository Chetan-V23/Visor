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

const eventBase = {
  v: versionSchema, id: z.uuid(), sessionId: identitySchema, seq: sequenceSchema,
  ts: timestampSchema, source: sourceSchema, agentTimestamp: z.iso.datetime().optional()
}
const editIntentSchema = z.enum(['create', 'edit', 'delete', 'rename'])
const editPayload = {
  tool: identitySchema, toolCallId: identitySchema.optional(),
  files: z.array(pathSchema).min(1), intent: editIntentSchema,
  mentionedClasses: z.array(symbolIdSchema).max(4096).optional()
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
  startObserved: z.boolean(), project: z.object({ id: identitySchema, name: identitySchema, branch: z.string() }).strip()
}).strip()
export const diagramFixtureSchema = z.object({
  v: versionSchema, session: sessionSummarySchema, model: codeModelSchema, changes: z.array(changeSchema)
}).strip()

export type Language = z.infer<typeof languageSchema>
export type SourceRange = z.infer<typeof rangeSchema>
export type MethodSymbol = z.infer<typeof methodSymbolSchema>
export type FieldSymbol = z.infer<typeof fieldSymbolSchema>
export type ClassSymbol = z.infer<typeof classSymbolSchema>
export type Relation = z.infer<typeof relationSchema>
export type RelationCandidate = z.infer<typeof relationCandidateSchema>
export type SymbolReference = z.infer<typeof symbolReferenceSchema>
export type SemanticDocument = z.infer<typeof semanticDocumentSchema>
export type FileModel = z.infer<typeof fileModelSchema>
export type CodeModel = z.infer<typeof codeModelSchema>
export type VisorEvent = z.infer<typeof visorEventSchema>
export type GraphDelta = z.infer<typeof graphDeltaSchema>
export type Change = z.infer<typeof changeSchema>
export type SessionSummary = z.infer<typeof sessionSummarySchema>

export interface HarnessAdapter<Raw> {
  source: string
  toEvents(raw: Raw): VisorEvent[]
}
export interface LanguageExtractor {
  language: Language
  matches(path: string): boolean
  extract(path: string, text: string): FileModel
}

export const protocolSchemas = {
  VisorEvent: visorEventSchema, CodeModel: codeModelSchema, Change: changeSchema, GraphDelta: graphDeltaSchema,
  ClassSymbol: classSymbolSchema, MethodSymbol: methodSymbolSchema, FieldSymbol: fieldSymbolSchema,
  Relation: relationSchema, FileModel: fileModelSchema, SessionSummary: sessionSummarySchema
}

export function protocolJsonSchemas() {
  return Object.fromEntries(Object.entries(protocolSchemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: 'input' })]))
}