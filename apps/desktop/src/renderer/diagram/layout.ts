import dagre from '@dagrejs/dagre'
import type { DiagramView } from './types'

type Position = { x: number; y: number }
export type RelationRoute = { points: Position[]; label: Position; source: Position; target: Position }

export function layout(view: DiagramView): { positions: Map<string, Position>; routes: Map<string, RelationRoute> } {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: 'LR', ranksep: 160, nodesep: 90, edgesep: 50, marginx: 20, marginy: 20 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const symbol of view.classes) graph.setNode(symbol.id, { width: 270, height: 140 + symbol.methods.length * 40 + Math.min(symbol.fields?.length ?? 0, 3) * 28 })
  for (const edge of view.edges) if (graph.hasNode(edge.from) && graph.hasNode(edge.to)) graph.setEdge(edge.from, edge.to, { width: 230, height: 44, labelpos: 'c' }, edge.id)
  dagre.layout(graph)
  const positions = new Map(view.classes.map((symbol) => {
    const position: { x: number; y: number; width: number; height: number } = graph.node(symbol.id)
    return [symbol.id, { x: position.x - position.width / 2, y: position.y - position.height / 2 }]
  }))
  const routes = new Map<string, RelationRoute>()
  for (const edge of view.edges) {
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue
    const route = graph.edge({ v: edge.from, w: edge.to, name: edge.id })
    if (!('x' in route) || typeof route.x !== 'number' || !('y' in route) || typeof route.y !== 'number') continue
    const source: Position & { width: number } = graph.node(edge.from)
    const target: Position & { width: number } = graph.node(edge.to)
    routes.set(edge.id, { points: route.points, label: { x: route.x, y: route.y }, source: { x: source.x + source.width / 2, y: source.y }, target: { x: target.x - target.width / 2, y: target.y } })
  }
  return { positions, routes }
}