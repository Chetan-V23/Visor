import { readFile, readdir } from 'node:fs/promises'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { rawHookSchema } from '../../bridge/src/index'
import { changeSchema, codeModelSchema, pathSchema, protocolJsonSchemas, protocolSchemas, rangeSchema, relationSchema, semanticDocumentSchema, symbolIdSchema, visorEventSchema } from './index'

const exampleSchema = z.record(z.string(), z.object({
  valid: z.array(z.json()).min(1),
  invalid: z.array(z.object({ document: z.json(), errorPath: z.array(z.union([z.string(), z.number()])) }).strict()).min(1)
}).strict())
const examples = exampleSchema.parse(JSON.parse(await readFile(new URL('../examples/documents.json', import.meta.url), 'utf8')))

describe.each(Object.entries(protocolSchemas))('%s examples', (name, schema) => {
  const cases = examples[name]
  if (!cases) throw new Error(`No examples exist for ${name}.`)
  it.each(cases.valid)('accepts valid document %#', (document) => {
    expect(schema.safeParse(document).success).toBe(true)
  })
  it.each(cases.invalid)('rejects invalid document %# at its expected path', ({ document, errorPath }) => {
    const result = schema.safeParse(document)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('An invalid example passed.')
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(errorPath)
  })
})

function fieldAt(value: unknown, path: string): unknown {
  let current = value
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null || !(part in current)) return undefined
    current = Object.getOwnPropertyDescriptor(current, part)?.value
  }
  return current
}

it('reviews the documented real capture set against its field mapping', async () => {
  const mappingSchema = z.object({
    common: z.record(z.string(), z.string()),
    captures: z.array(z.object({ fixture: z.string(), kind: z.string().nullable(), fields: z.record(z.string(), z.string()), note: z.string() }).strict())
  }).strict()
  const mapping = mappingSchema.parse(JSON.parse(await readFile(new URL('../examples/raw-field-map.json', import.meta.url), 'utf8')))
  const folder = new URL('../../../fixtures/raw-hooks/', import.meta.url)
  expect((await readdir(folder)).filter((file) => file.endsWith('.json'))).toEqual(expect.arrayContaining(mapping.captures.map((capture) => capture.fixture)))
  for (const capture of mapping.captures) {
    const raw = rawHookSchema.parse(JSON.parse(await readFile(new URL(capture.fixture, folder), 'utf8')))
    for (const path of Object.values({ ...mapping.common, ...capture.fields })) {
      expect(fieldAt(raw, path), `${capture.fixture} must supply ${path}`).not.toBeUndefined()
    }
    expect(capture.note.length).toBeGreaterThan(0)
    if (capture.kind === null) expect(raw.payload.tool_name).toBe('get_errors')
  }
})

describe('protocol v1', () => {
  it('represents ownership and signal connections with source evidence and bounded semantic facts', () => {
    const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } }
    for (const kind of ['composes', 'aggregates', 'associates', 'connects', 'depends']) {
      expect(relationSchema.parse({ from: 'py:a.py::Main', to: 'py:a.py::Viewer', kind, certainty: 'inferred', evidence: [{ file: 'a.py', range: location, reason: 'constructed-field' }] }).kind).toBe(kind)
    }
    const document = { v: 1, workspaceRoot: 'D:/project', file: 'a.py', hash: 'a'.repeat(64), provider: 'vscode', definitions: [{ position: location.start, targets: [{ file: 'b.py', hash: 'b'.repeat(64), range: location }] }] }
    expect(semanticDocumentSchema.safeParse(document).success).toBe(true)
    expect(semanticDocumentSchema.safeParse({ ...document, definitions: [{ ...document.definitions[0], targets: [{ file: '../outside.py', hash: 'b'.repeat(64), range: location }] }] }).success).toBe(false)
    expect(semanticDocumentSchema.safeParse({ ...document, definitions: Array.from({ length: 513 }, () => document.definitions[0]) }).success).toBe(false)
  })
  it('accepts a versioned model and rejects incompatible versions', () => {
    expect(codeModelSchema.parse({ v: 1, classes: [], relations: [] })).toEqual({ v: 1, classes: [], relations: [] })
    expect(codeModelSchema.safeParse({ v: 2, classes: [], relations: [] }).success).toBe(false)
  })
  it.each(['../cart.py', 'src/../cart.py', '/cart.py', 'C:/cart.py', 'src\\cart.py', './cart.py', 'src//cart.py', 'src/'])('rejects noncanonical path %s', (path) => {
    expect(pathSchema.safeParse(path).success).toBe(false)
  })
  it('accepts canonical paths and namespaced symbol IDs', () => {
    expect(pathSchema.parse('src/shop/cart.py')).toBe('src/shop/cart.py')
    expect(symbolIdSchema.parse('py:src/shop/cart.py::Cart.add_item')).toBe('py:src/shop/cart.py::Cart.add_item')
    expect(symbolIdSchema.safeParse('py:../cart.py::Cart').success).toBe(false)
  })
  it('rejects reversed source ranges', () => {
    expect(rangeSchema.safeParse({ start: { line: 2, column: 4 }, end: { line: 2, column: 3 } }).success).toBe(false)
  })
  it('accepts additive v1 fields without changing the known document', () => {
    expect(codeModelSchema.parse({ v: 1, classes: [], relations: [], futureMetadata: 'extra' })).toEqual({ v: 1, classes: [], relations: [] })
    const schemas = protocolJsonSchemas()
    expect(schemas.CodeModel?.additionalProperties).not.toBe(false)
  })
  it('rejects dangling relations rather than silently dropping them in the UI', () => {
    expect(codeModelSchema.safeParse({ v: 1, classes: [], relations: [{ from: 'py:a.py::A', to: 'py:b.py::B', kind: 'calls', certainty: 'unknown' }] }).success).toBe(false)
  })
  it('supports a late baseline without inventing an observed session start', () => {
    const change = examples.Change?.valid[0]
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('Missing change example.')
    const baseline = { ...change, seq: 0, cause: { kind: 'baseline', eventId: '4508c17a-baaa-4a0c-9add-7384850f24fd', observedAt: 'before-first-edit' } }
    expect(changeSchema.parse(baseline).cause.kind).toBe('baseline')
    expect(changeSchema.safeParse({ ...baseline, seq: 1 }).success).toBe(false)
  })
  it('distinguishes a turn ending from a session ending', () => {
    const event = { v: 1, id: 'a5048d6d-6635-4198-82bb-3afe6015d710', sessionId: 'live', seq: 1, ts: 42, source: 'copilot' }
    expect(visorEventSchema.parse({ ...event, kind: 'turn.ended', payload: { stopHookActive: false } }).kind).toBe('turn.ended')
    expect(visorEventSchema.safeParse({ ...event, kind: 'session.ended', payload: { stopHookActive: false } }).success).toBe(false)
  })
  it('exports every public document as serializable JSON Schema', () => {
    const schemas = protocolJsonSchemas()
    expect(Object.keys(schemas)).toHaveLength(10)
    for (const schema of Object.values(schemas)) {
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema)
    }
  })
})