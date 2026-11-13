import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { diagramFixtureSchema } from '@visor/protocol'
import { fixtureSource } from './fixture-source'
import { layout } from './layout'
import { toDiagramView } from './protocol-adapter'

const documents = diagramFixtureSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/sample-diagram.json', import.meta.url), 'utf8')))

describe('Step 1 diagram source', () => {
  it('loads three connected classes and four newest-first changes', () => {
    const view = fixtureSource.load()
    expect(view.classes.map((symbol) => symbol.name)).toEqual(['Cart', 'CheckoutService', 'Invoice'])
    expect(view.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['py:src/shop/cart.py::Cart', 'py:src/shop/checkout.py::CheckoutService'],
      ['py:src/shop/checkout.py::CheckoutService', 'py:src/shop/invoice.py::Invoice']
    ])
    expect(view.changes.map((change) => change.number)).toEqual([4, 3, 2, 1])
    expect(view.classes[0]?.methods[1]?.signature).toBe('def add_item(self, item: Item) -> None')
  })

  it('returns isolated data for each caller', () => {
    fixtureSource.load().classes.pop()
    expect(fixtureSource.load().classes).toHaveLength(3)
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
    expect(new Set([...positions.values()].map((position) => JSON.stringify(position))).size).toBe(3)
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