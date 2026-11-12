import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Box, Minus, Plus } from 'lucide-react'
import type { DiagramClass, DiagramMethod } from '../diagram/types'

export type ClassFlowNode = Node<{ symbol: DiagramClass }, 'class'>

function MethodRow({ method }: { method: DiagramMethod }) {
  const tooltipId = useId()
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)

  function showTooltip(target: HTMLButtonElement): void {
    const bounds = target.getBoundingClientRect()
    const width = Math.min(370, window.innerWidth - 24)
    setAnchor({
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(bounds.bottom + 10, window.innerHeight - 170))
    })
  }

  return (
    <>
      <button
        type="button"
        className={`method-row method-${method.change} nodrag nopan`}
        aria-describedby={anchor ? tooltipId : undefined}
        onMouseEnter={(event) => showTooltip(event.currentTarget)}
        onMouseLeave={() => setAnchor(null)}
        onFocus={(event) => showTooltip(event.currentTarget)}
        onBlur={() => setAnchor(null)}
        onKeyDown={(event) => { if (event.key === 'Escape') setAnchor(null) }}
      >
        <span className="method-marker" aria-label={method.change}>
          {method.change === 'added' ? <Plus size={12} /> : method.change === 'deleted' ? <Minus size={12} /> : <span aria-hidden="true">.</span>}
        </span>
        <span className="method-name">{method.name}</span>
      </button>
      {anchor && createPortal(
        <div id={tooltipId} role="tooltip" className="method-tooltip" style={anchor}>
          <span className="tooltip-eyebrow">Python method</span>
          <code>{method.signature}</code>
          <p>{method.docstring}</p>
        </div>,
        document.body
      )}
    </>
  )
}

export function ClassNode({ data, selected }: NodeProps<ClassFlowNode>) {
  const { symbol } = data
  return (
    <article className={`class-node ${selected ? 'class-selected' : ''}`} data-testid="class-node" aria-label={`${symbol.name} class`}>
      <Handle type="target" position={Position.Left} />
      <header className="class-heading">
        <span className="class-kind"><Box size={13} strokeWidth={1.7} /> CLASS <span>PY</span></span>
        <h2>{symbol.name}</h2>
        <span className="class-file">{symbol.file}</span>
      </header>
      <div className="class-methods">
        {symbol.methods.map((method) => <MethodRow key={method.id} method={method} />)}
      </div>
      <footer className="class-footer">{symbol.methods.length} methods</footer>
      <Handle type="source" position={Position.Right} />
    </article>
  )
}