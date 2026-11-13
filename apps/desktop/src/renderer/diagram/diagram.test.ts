import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { changeSchema, codeModelSchema, diagramFixtureSchema } from '@visor/protocol'
import { fixtureSource } from './fixture-source'
import { layout } from './layout'
import { toDiagramView } from './protocol-adapter'

const documents = diagramFixtureSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/sample-diagram.json', import.meta.url), 'utf8')))

describe('Step 1 diagram source', () => {
  it('loads the latest touched classes and four newest-first changes', () => {
    const view = fixtureSource.load()
    expect(view.classes.map((symbol) => symbol.name)).toEqual(['Cart', 'CheckoutService'])
    expect(view.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['py:src/shop/cart.py::Cart', 'py:src/shop/checkout.py::CheckoutService']
    ])
    expect(view.changes.map((change) => change.number)).toEqual([4, 3, 2, 1])
    expect(view.classes[0]?.methods[1]?.signature).toBe('def add_item(self, item: Item) -> None')
  })

  it('returns isolated data for each caller', () => {
    fixtureSource.load().classes.pop()
    expect(fixtureSource.load().classes).toHaveLength(2)
  })

  it('projects member additions and removed tooltip details without changing the model', () => {
    const before = structuredClone(documents)
    const view = toDiagramView(documents.model, documents.changes[0] ?? null)
    const methods = view.classes[0]?.methods
    expect(methods?.find((method) => method.name === 'add_item(self, item)')?.change).toBe('added')
    expect(methods?.find((method) => method.name === 'checkout(self)')).toMatchObject({ change: 'deleted', signature: 'def checkout(self) -> Invoice' })
    expect(documents).toEqual(before)
    view.classes[0]?.methods.pop()
    expect(documents.model.classes[0]?.methods).toHaveLength(3)
  })

  it('retains changed-class and changed-method metadata for the later glow renderer', () => {
    const view = toDiagramView(documents.model, documents.changes[2] ?? null)
    expect(view.classes[0]?.change).toBe('modified')
    expect(view.classes[0]?.methods.find((method) => method.name === 'total(self)')).toMatchObject({ modified: true, change: 'unchanged' })
  })

  it('localizes a selected edit to touched classes without pulling in unrelated neighbors', () => {
    const change = documents.changes[2]
    if (!change) throw new Error('Missing member-edit fixture.')
    const view = toDiagramView(documents.model, change)
    expect(view.classes.map((symbol) => symbol.name)).toEqual(['Cart'])
    expect(view.edges).toEqual([])
  })

  it('localizes member-owned text changes to the containing class', () => {
    const change = documents.changes[2]
    const member = documents.model.classes[0]?.methods[0]
    if (!change || !member) throw new Error('Missing member-edit fixture.')
    const view = toDiagramView(documents.model, changeSchema.parse({ ...change, delta: [{ v: 1, op: 'code.hunks', file: 'src/shop/cart.py', symbolId: member.id, hunks: [] }] }))
    expect(view.classes.map((symbol) => symbol.name)).toEqual(['Cart'])
  })

  it('localizes text-only hunks without treating context lines or a shared file as edits', () => {
    const symbol = documents.model.classes[0]
    const change = documents.changes[2]
    if (!symbol || !change) throw new Error('Missing class fixture.')
    const model = codeModelSchema.parse({ v: 1, relations: [], classes: ['First', 'Second'].map((name, index) => ({ ...symbol, id: `py:shared.py::${name}`, name, file: 'shared.py', methods: [], fields: [], range: { start: { line: index === 0 ? 10 : 30, column: 0 }, end: { line: index === 0 ? 26 : 40, column: 0 } } })) })
    const edit = changeSchema.parse({ ...change, files: [{ path: 'shared.py', beforeHash: null, afterHash: null, added: 1, deleted: 0 }], delta: [{ v: 1, op: 'code.hunks', file: 'shared.py', hunks: [{ oldStart: 23, oldLines: 7, newStart: 23, newLines: 8, lines: [...Array.from({ length: 7 }, () => ({ kind: 'context', text: '' })), { kind: 'added', text: '    # New class-body text' }] }] }] })
    expect(toDiagramView(model, edit).classes.map((item) => item.name)).toEqual(['Second'])
    const constantEdit = changeSchema.parse({ ...edit, delta: [{ v: 1, op: 'code.hunks', file: 'shared.py', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: [{ kind: 'added', text: 'LABEL = "new"' }] }] }] })
    expect(toDiagramView(model, constantEdit).classes).toEqual([])
  })

  it('localizes relation-only edits to their source class in the touched file', () => {
    const source = documents.model.classes[0]
    const target = documents.model.classes[2]
    const change = documents.changes[2]
    if (!source || !target || !change) throw new Error('Missing relationship fixture.')
    const relation = { from: source.id, to: target.id, kind: 'associates', certainty: 'inferred', label: 'invoice', evidence: [{ file: source.file, range: source.range, reason: 'Updated import resolves a retained reference.' }] }
    const model = codeModelSchema.parse({ ...documents.model, relations: [relation] })
    const edit = changeSchema.parse({ ...change, files: [{ path: source.file, beforeHash: null, afterHash: null, added: 1, deleted: 1 }], delta: [{ v: 1, op: 'edge.add', relation }] })
    expect(toDiagramView(model, edit).classes.map((symbol) => symbol.name)).toEqual(['Cart'])
    expect(toDiagramView(model, edit).edges).toEqual([])
  })

  it('preserves ownership kinds, evidence, and distinct labels from older snapshots', () => {
    const source = documents.model.classes[0]
    const target = documents.model.classes[1]
    if (!source || !target) throw new Error('Missing test classes.')
    const relations = ['image_a', 'image_b'].map((label) => ({ from: source.id, to: target.id, kind: 'composes' as const, certainty: 'inferred' as const, label, evidence: [{ file: source.file, range: null, reason: 'Constructed field.' }] }))
    const view = toDiagramView({ ...documents.model, relations }, null)
    expect(view.edges.map((edge) => edge.label)).toEqual(['image_a', 'image_b'])
    expect(view.edges.every((edge) => edge.kind === 'composes' && edge.certainty === 'inferred' && edge.evidence?.[0]?.reason === 'Constructed field.')).toBe(true)
  })

  it('projects a removed class from its prior symbol data', () => {
    const symbol = documents.model.classes[0]
    const change = documents.changes[0]
    if (!symbol || !change) throw new Error('The sample fixture is incomplete.')
    const view = toDiagramView({ v: 1, classes: [], relations: [] }, { ...change, delta: [{ v: 1, op: 'node.remove', node: symbol }] })
    expect(view.classes[0]).toMatchObject({ name: 'Cart', change: 'deleted' })
    expect(view.classes[0]?.methods.every((method) => method.change === 'deleted')).toBe(true)
  })

  it('gives every class a stable, distinct position', () => {
    const view = fixtureSource.load()
    expect(layout(view)).toEqual(layout(view))
    const { positions } = layout(view)
    expect(new Set([...positions.values()].map((position) => JSON.stringify(position))).size).toBe(2)
    expect((positions.get(view.classes[0]?.id ?? '')?.x ?? 0) < (positions.get(view.classes[1]?.id ?? '')?.x ?? 0)).toBe(true)
  })

  it('preserves the requested palette in reusable CSS tokens', () => {
    const css = readFileSync(new URL('../../../../../packages/theme/src/tokens.css', import.meta.url), 'utf8')
    expect(css).toContain('--visor-deleted: #C44A3A;')
    expect(css).toContain('--visor-diagram: #D97A2B;')
    expect(css).toContain('--visor-app: #F2D479;')
    expect(css).toContain('--visor-added: #6FAF4F;')
  })
})