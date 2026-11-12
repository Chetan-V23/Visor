import { useState } from 'react'
import {
  Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, getBezierPath,
  MarkerType, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState,
  useReactFlow, useViewport, type Edge, type EdgeProps
} from '@xyflow/react'
import { Focus, Minus, Plus, RotateCcw, Workflow } from 'lucide-react'
import { themeVariables } from '@visor/theme'
import { layout } from '../diagram/layout'
import type { DiagramView } from '../diagram/types'
import { ClassNode, type ClassFlowNode } from './ClassNode'
import { IconButton } from './IconButton'

type RelationFlowEdge = Edge<{ label: string }, 'relation'>

function RelationEdge(props: EdgeProps<RelationFlowEdge>) {
  const [path, labelX, labelY] = getBezierPath(props)
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={props.style} />
      <EdgeLabelRenderer>
        <span className="relation-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          {props.data?.label}
        </span>
      </EdgeLabelRenderer>
    </>
  )
}

const nodeTypes = { class: ClassNode }
const edgeTypes = { relation: RelationEdge }

function makeNodes(view: DiagramView): ClassFlowNode[] {
  const positions = layout(view)
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
  const [initialNodes] = useState(() => makeNodes(view))
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, , onEdgesChange] = useEdgesState<RelationFlowEdge>(view.edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: 'relation',
    data: { label: edge.label },
    style: { stroke: themeVariables.ink, strokeWidth: 1.6 },
    markerEnd: { type: MarkerType.ArrowClosed, color: themeVariables.ink, width: 18, height: 18 }
  })))
  const { fitView } = useReactFlow()

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.2}
      maxZoom={1.8}
      nodesConnectable={false}
      edgesFocusable={false}
      deleteKeyCode={null}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.1} color="#00000025" />
      <CanvasControls reset={() => {
        setNodes(makeNodes(view))
        requestAnimationFrame(() => void fitView({ padding: 0.18, duration: 150 }))
      }} />
    </ReactFlow>
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
        <ReactFlowProvider><Diagram view={view} /></ReactFlowProvider>
      </div>
      <footer className="diagram-status">
        <span><span className="status-dot" /> Python</span>
        <span className="diagram-legend"><span className="legend-added">+ Added</span><span className="legend-deleted">- Deleted</span><span>Unchanged</span></span>
      </footer>
    </section>
  )
}