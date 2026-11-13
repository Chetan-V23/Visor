import { expect, it } from 'vitest'
import { graphDeltaSchema, type ClassSymbol, type CodeModel, type Relation } from '@visor/protocol'
import { assembleModel, diffModels, summarize } from './model'

const symbol = (name: string): ClassSymbol => ({ id: `py:a.py::${name}`, name, file: 'a.py', range: null, bases: [], methods: [], fields: [] })
const edge = (from: string, to: string): Relation => ({ from: `py:a.py::${from}`, to: `py:a.py::${to}`, kind: 'inherits', certainty: 'declared' })
const model = (names: string[], relations: Relation[] = []): CodeModel => ({ v: 1, classes: names.map(symbol), relations })

it('adds and removes classes with their complete symbols', () => {
  expect(diffModels(model(['A']), model(['A', 'B']))).toEqual([{ v: 1, op: 'node.add', node: symbol('B') }])
  expect(diffModels(model(['A', 'B']), model(['A']))).toEqual([{ v: 1, op: 'node.remove', node: symbol('B') }])
})
it('observes method additions and body changes but ignores range-only shifts', () => {
  const before = model(['A'])
  const after = model(['A'])
  const member = { kind: 'method' as const, id: 'py:a.py::A.run', name: 'run', signature: 'run(self)', docstring: '', range: null, bodyHash: 'a'.repeat(64) }
  const node = after.classes[0]
  if (!node) throw new Error('Missing test class.')
  node.methods.push(member)
  expect(diffModels(before, after)[0]).toMatchObject({ op: 'member.add', member })
  const changed = structuredClone(after)
  const method = changed.classes[0]?.methods[0]
  if (!method) throw new Error('Missing test method.')
  method.range = { start: { line: 3, column: 4 }, end: { line: 4, column: 12 } }
  expect(diffModels(after, changed)).toEqual([])
  method.bodyHash = 'b'.repeat(64)
  expect(diffModels(after, changed)[0]?.op).toBe('member.change')
})
it('observes initializer-only field changes', () => {
  const before = model(['Main'])
  const node = before.classes[0]
  if (!node) throw new Error('Missing test class.')
  node.fields.push({ kind: 'field', id: `${node.id}.PATH`, name: 'PATH', type: null, range: null, initializerHash: 'a'.repeat(64) })
  const after = structuredClone(before)
  const field = after.classes[0]?.fields[0]
  if (!field) throw new Error('Missing test field.')
  field.initializerHash = 'b'.repeat(64)
  expect(diffModels(before, after)[0]?.op).toBe('member.change')
})
it('replaces the edge when a known base changes', () => {
  const delta = diffModels(model(['A', 'B', 'C'], [edge('C', 'A')]), model(['A', 'B', 'C'], [edge('C', 'B')]))
  expect(delta.map((item) => item.op)).toEqual(['edge.remove', 'edge.add'])
  expect(delta.every((item) => graphDeltaSchema.safeParse(item).success)).toBe(true)
})
it('tags A to B becoming A to C to B as an insertion', () => {
  const delta = diffModels(model(['A', 'B'], [edge('A', 'B')]), model(['A', 'C', 'B'], [edge('A', 'C'), edge('C', 'B')]))
  expect(delta[0]).toMatchObject({ op: 'node.add', insertedBetween: ['py:a.py::A', 'py:a.py::B'] })
})
it('marks a changed unresolved base without inventing a dangling edge or source lines', () => {
  const before = model(['A'])
  const after = model(['A'])
  const oldClass = before.classes[0]
  const newClass = after.classes[0]
  if (!oldClass || !newClass) throw new Error('Missing test classes.')
  oldClass.bases = ['ExternalA']
  newClass.bases = ['ExternalB']
  expect(diffModels(before, after)).toEqual([{ v: 1, op: 'code.hunks', file: 'a.py', symbolId: 'py:a.py::A', hunks: [] }])
})
it('resolves declared inheritance without assuming a typed reference is owned', () => {
  const base = symbol('Base')
  const child = { ...symbol('Child'), bases: ['Base', 'External'], fields: [{ kind: 'field' as const, id: 'py:a.py::Child.base', name: 'base', type: 'Base', range: null }] }
  const assembled = assembleModel([{ v: 1, language: 'py', file: 'a.py', classes: [base, child], functions: [], imports: [] }])
  expect(assembled.relations.map((relation) => relation.kind)).toEqual(['inherits', 'associates'])
  expect(summarize(diffModels(model([]), assembled), 1)).toBe('Added 2 classes')
})