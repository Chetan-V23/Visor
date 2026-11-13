import { useEffect, useId, useRef } from 'react'
import {
  Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, getBezierPath,
  MarkerType, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState,
  useNodesInitialized, useReactFlow, useViewport, type Edge, type EdgeProps
} from '@xyflow/react'
import { Focus, Minus, Plus, RotateCcw, Workflow } from 'lucide-react'
import { themeVariables } from '@visor/theme'
import { layout, type RelationRoute } from '../diagram/layout'
import type { DiagramEdge, DiagramView } from '../diagram/types'
import { ClassNode, MethodTooltipProvider, type ClassFlowNode } from './ClassNode'
import { IconButton } from './IconButton'

type RelationFlowEdge = Edge<{ label: string; description: string; route: RelationRoute | undefined }, 'relation'>

const relationNames = { inherits: 'Inheritance', composes: 'Composition', aggregates: 'Aggregation', associates: 'Association', depends: 'Dependency', connects: 'Signal/Event', calls: 'Call', imports: 'Import' }

function relationDescription(edge: DiagramEdge): string {
  return `${relationNames[edge.kind ?? 'calls']} (${edge.certainty ?? 'unknown'})\n${edge.label}${edge.evidence?.map((evidence) => `\n${evidence.file}${evidence.range ? `:${evidence.range.start.line}` : ''}: ${evidence.reason}`).join('') ?? ''}`
}

function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const { getNode } = useReactFlow<ClassFlowNode, RelationFlowEdge>()
  const route = props.data?.route
  let [path, labelX, labelY] = getBezierPath(props)
  if (route && route.points.length > 1) {
    const sourceDelta = { x: props.sourceX - route.source.x, y: props.sourceY - route.source.y }
    const targetDelta = { x: props.targetX - route.target.x, y: props.targetY - route.target.y }
    const points = route.points.map((point, index) => {
      const fraction = index / (route.points.length - 1)
      return { x: point.x + sourceDelta.x * (1 - fraction) + targetDelta.x * fraction, y: point.y + sourceDelta.y * (1 - fraction) + targetDelta.y * fraction }
    })
    const start = points[0]
    const end = points[points.length - 1]
    const sourceHalfHeight = Math.max(0, (getNode(props.source)?.measured?.height ?? 140) / 2 - 16)
    const targetHalfHeight = Math.max(0, (getNode(props.target)?.measured?.height ?? 140) / 2 - 16)
    if (start) { start.x = props.sourceX + 3; start.y = Math.max(props.sourceY - sourceHalfHeight, Math.min(props.sourceY + sourceHalfHeight, start.y)) }
    if (end) { end.x = props.targetX - 3; end.y = Math.max(props.targetY - targetHalfHeight, Math.min(props.targetY + targetHalfHeight, end.y)) }
    path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
    labelX = route.label.x + (sourceDelta.x + targetDelta.x) / 2
    labelY = route.label.y + (sourceDelta.y + targetDelta.y) / 2
  }
  return (
    <>
      <BaseEdge id={props.id} path={path} markerStart={props.markerStart} markerEnd={props.markerEnd} style={{ ...props.style, strokeLinejoin: 'round' }} />
      <EdgeLabelRenderer>
        <span className="relation-label" tabIndex={0} title={props.data?.description} style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          {props.data?.label}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { class: ClassNode }
const edgeTypes = { relation: RelationEdge }

function makeNodes(view: DiagramView): ClassFlowNode[] {
  const { positions } = layout(view)
  return view.classes.map((symbol) => ({
    id: symbol.id,
    type: 'class',
    position: positions.get(symbol.id) ?? { x: 0, y: 0 },
    data: { symbol }
  }))
}

function CanvasControls({ reset }: { reset: () => void }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const { zoom } = useViewport()
  return (
    <div className="canvas-controls" aria-label="Diagram controls">
      <IconButton label="Zoom out" onClick={() => void zoomOut({ duration: 150 })}><Minus size={17} /></IconButton>
      <output className="zoom-value" aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
      <IconButton label="Zoom in" onClick={() => void zoomIn({ duration: 150 })}><Plus size={17} /></IconButton>
      <span className="control-divider" />
      <IconButton label="Fit diagram" onClick={() => void fitView({ padding: 0.18, duration: 150 })}><Focus size={18} /></IconButton>
      <IconButton label="Reset layout" onClick={reset}><RotateCcw size={16} /></IconButton>
    </div>
  )
}

function Diagram({ view }: { view: DiagramView }) {
  const markerPrefix = useId().replace(/:/g, '-')
  const topology = JSON.stringify([view.classes.map((symbol) => symbol.id), view.edges.map((edge) => edge.id)])
  const previousTopology = useRef(topology)
  const [nodes, setNodes, onNodesChange] = useNodesState(makeNodes(view))
  const makeEdges = (): RelationFlowEdge[] => {
    const { routes } = layout(view)
    return view.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: 'relation',
    data: { label: `${relationNames[edge.kind ?? 'calls']}: ${edge.label}${edge.certainty === 'inferred' ? ' (inferred)' : ''}`, description: relationDescription(edge), route: routes.get(edge.id) },
    ariaLabel: relationDescription(edge),
    style: { stroke: edge.change === 'added' ? themeVariables.added : edge.change === 'deleted' ? themeVariables.deleted : themeVariables.ink, strokeWidth: 1.6, strokeDasharray: ['depends', 'connects', 'imports'].includes(edge.kind ?? '') ? '6 4' : undefined },
    markerStart: edge.kind === 'composes' || edge.kind === 'aggregates' ? `${markerPrefix}-${edge.kind}-${edge.change ?? 'unchanged'}` : undefined,
    markerEnd: edge.kind === 'inherits' ? `${markerPrefix}-inherits-${edge.change ?? 'unchanged'}` : edge.kind === 'composes' || edge.kind === 'aggregates' ? undefined : { type: MarkerType.Arrow, color: edge.change === 'added' ? themeVariables.added : edge.change === 'deleted' ? themeVariables.deleted : themeVariables.ink, width: 18, height: 18 }
    }))
  }
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationFlowEdge>(makeEdges())
  const { fitView } = useReactFlow()
  const nodesInitialized = useNodesInitialized()
  const nodeIds = nodes.map((node) => node.id).join('\0')

  useEffect(() => {
    if (nodesInitialized) void fitView({ padding: 0.18, duration: 150 })
  }, [nodesInitialized, nodeIds, topology, fitView])

  useEffect(() => {
    const relationshipTopologyChanged = previousTopology.current !== topology
    setNodes((previous) => {
      const previousNodes = new Map(previous.map((node) => [node.id, node]))
      const next = makeNodes(view)
      const topologyChanged = relationshipTopologyChanged || previousNodes.size !== next.length || next.some((node) => !previousNodes.has(node.id))
      return next.map((node) => {
        const prior = previousNodes.get(node.id)
        return prior ? { ...prior, ...node, position: topologyChanged ? node.position : prior.position } : node
      })
    })
    previousTopology.current = topology
    setEdges(makeEdges())
  }, [view, topology, setNodes, setEdges])

  return (
    <>
    <svg width="0" height="0" aria-hidden="true" style={{ position: 'absolute' }}><defs>
      {(['composes', 'aggregates', 'inherits'] as const).flatMap((kind) => (['unchanged', 'added', 'deleted'] as const).map((change) => {
        const color = change === 'added' ? themeVariables.added : change === 'deleted' ? themeVariables.deleted : themeVariables.ink
        return <marker key={`${kind}-${change}`} id={`${markerPrefix}-${kind}-${change}`} viewBox="0 0 14 14" refX={kind === 'inherits' ? 12 : 0} refY="7" markerWidth="14" markerHeight="14" markerUnits="userSpaceOnUse" orient="auto"><path d={kind === 'inherits' ? 'M1 1 L12 7 L1 13 Z' : 'M0 7 L7 1 L14 7 L7 13 Z'} fill={kind === 'composes' ? color : 'var(--visor-surface-raised)'} stroke={color} strokeWidth="1.6" /></marker>
      }))}
    </defs></svg>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.08}
      maxZoom={1.8}
      nodesConnectable={false}
      edgesFocusable
      deleteKeyCode={null}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="#00000025" />
      <CanvasControls reset={() => {
        setNodes(makeNodes(view))
        requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 150 }))
      }} />
    </ReactFlow>
    </>
  )
}

export function DiagramCanvas({ view }: { view: DiagramView }) {
  return (
    <section className="diagram-panel" aria-label="Class diagram">
      <div className="diagram-heading">
        <div><Workflow size={17} /><span>Class diagram</span></div>
        <span>{view.classes.length} classes <span aria-hidden="true">/</span> {view.edges.length} relationships</span>
      </div>
      <div className="diagram-canvas">
        {view.classes.length === 0 && <div className="diagram-empty"><Workflow size={28} /><span>No classes</span></div>}
        <ReactFlowProvider><MethodTooltipProvider changeId={view.classes.find((symbol) => symbol.methods.length > 0)?.methods[0]?.changeId}><Diagram view={view} /></MethodTooltipProvider></ReactFlowProvider>
      </div>
      <footer className="diagram-status">
        <span><span className="status-dot" /> Python</span>
        <span className="diagram-legend"><span className="legend-added">+ Added</span><span className="legend-deleted">- Deleted</span><span>Unchanged</span></span>
      </footer>
    </section>
  )
}