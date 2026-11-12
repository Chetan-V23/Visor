import type { DiagramView } from './types'

export function layout(view: DiagramView): Map<string, { x: number; y: number }> {
  return new Map(view.classes.map((symbol, index) => [
    symbol.id, { x: index * 350, y: index === 1 ? 50 : 0 }
  ]))
}