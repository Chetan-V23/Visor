import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fixtureSource } from './fixture-source'
import { layout } from './layout'

describe('Step 1 diagram source', () => {
  it('loads three connected classes and four newest-first changes', () => {
    const view = fixtureSource.load()
    expect(view.classes.map((symbol) => symbol.name)).toEqual(['Cart', 'CheckoutService', 'Invoice'])
    expect(view.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['cart', 'checkout'], ['checkout', 'invoice']
    ])
    expect(view.changes.map((change) => change.number)).toEqual([4, 3, 2, 1])
    expect(view.classes[0]?.methods[1]?.signature).toBe('def add_item(self, item: Item) -> None')
  })

  it('returns isolated data for each caller', () => {
    fixtureSource.load().classes.pop()
    expect(fixtureSource.load().classes).toHaveLength(3)
  })

  it('gives every class a stable, distinct position', () => {
    const view = fixtureSource.load()
    expect(layout(view)).toEqual(layout(view))
    expect([...layout(view).values()]).toEqual([
      { x: 0, y: 0 }, { x: 350, y: 50 }, { x: 700, y: 0 }
    ])
  })

  it('preserves the requested palette in reusable CSS tokens', () => {
    const css = readFileSync(new URL('../../../../../packages/theme/src/tokens.css', import.meta.url), 'utf8')
    expect(css).toContain('--visor-deleted: #C44A3A;')
    expect(css).toContain('--visor-diagram: #D97A2B;')
    expect(css).toContain('--visor-app: #F2D479;')
    expect(css).toContain('--visor-added: #6FAF4F;')
  })
})