import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { methodCodeSchema, type MethodCode } from '@visor/bridge'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { Box, Minus, Plus } from 'lucide-react'
import type { DiagramClass, DiagramMethod } from '../diagram/types'

export type ClassFlowNode = Node<{ symbol: DiagramClass }, 'class'>

type CodeState = { kind: 'loading' } | { kind: 'ready'; code: MethodCode } | { kind: 'unavailable' } | { kind: 'error' }

interface TooltipControls {
  id: string
  methodId: string | null
  show(method: DiagramMethod, target: HTMLButtonElement): void
  hideSoon(methodId?: string): void
  close(): void
}
const TooltipContext = createContext<TooltipControls | null>(null)

export function MethodTooltipProvider({ children, changeId }: { children: ReactNode; changeId?: string }) {
  const tooltipId = useId()
  const [active, setActive] = useState<{ method: DiagramMethod; anchor: { left: number; top: number; bottom: number } } | null>(null)
  const [code, setCode] = useState<CodeState>({ kind: 'loading' })
  const tooltip = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function keepOpen(): void {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current)
  }
  function close(): void {
    keepOpen()
    setActive(null)
  }
  function hideSoon(methodId?: string): void {
    keepOpen()
    closeTimer.current = setTimeout(() => setActive((current) => methodId && current?.method.id !== methodId ? current : null), 200)
  }

  useEffect(() => () => keepOpen(), [])
  useEffect(() => close(), [changeId])
  useEffect(() => {
    if (!active) return
    const { method } = active
    const bridge = window.visorHistory
    if (!bridge || !method.changeId) { setCode({ kind: 'unavailable' }); return }
    let current = true
    setCode({ kind: 'loading' })
    void bridge.getMethodCode({ changeId: method.changeId, methodId: method.id }).then((document) => {
      if (current) setCode(document === null ? { kind: 'unavailable' } : { kind: 'ready', code: methodCodeSchema.parse(document) })
    }).catch(() => { if (current) setCode({ kind: 'error' }) })
    return () => { current = false }
  }, [active])

  useLayoutEffect(() => {
    const panel = tooltip.current
    if (!active || !panel) return
    const { anchor } = active
    const position = () => {
      const bounds = panel.getBoundingClientRect()
      const top = anchor.bottom + 8 + bounds.height <= window.innerHeight - 12 ? anchor.bottom + 8 : anchor.top - bounds.height - 8
      panel.style.left = `${Math.max(12, Math.min(anchor.left, document.documentElement.clientWidth - bounds.width - 12))}px`
      panel.style.top = `${Math.max(12, Math.min(top, window.innerHeight - bounds.height - 12))}px`
    }
    const observer = new ResizeObserver(position)
    observer.observe(panel)
    window.addEventListener('resize', position)
    position()
    return () => { observer.disconnect(); window.removeEventListener('resize', position) }
  }, [active])

  function show(method: DiagramMethod, target: HTMLButtonElement): void {
    keepOpen()
    const bounds = target.getBoundingClientRect()
    setCode({ kind: 'loading' })
    setActive({ method, anchor: { left: bounds.left, top: bounds.top, bottom: bounds.bottom } })
  }

  return (
    <TooltipContext.Provider value={{ id: tooltipId, methodId: active?.method.id ?? null, show, hideSoon, close }}>
      {children}
      {active && createPortal(
        <div ref={tooltip} id={tooltipId} role="tooltip" tabIndex={0} className="method-tooltip" style={{ left: active.anchor.left, top: active.anchor.bottom + 8 }} onMouseEnter={keepOpen} onMouseLeave={() => hideSoon()} onFocus={keepOpen} onBlur={() => hideSoon()} onKeyDown={(event) => { if (event.key === 'Escape') close() }}>
          <span className="tooltip-eyebrow">{code.kind === 'ready' ? code.code.file : 'Python method'}</span>
          {code.kind === 'ready' ? <pre className="method-code"><code>{code.code.lines.map((line, index) =>
            <span key={index} className={`code-line code-${line.kind}`}><span className="code-marker" aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'deleted' ? '-' : ' '}</span>{line.text}</span>
          )}</code></pre> : <>
            <code>{active.method.signature}</code>
            <p>{code.kind === 'loading' ? 'Loading source...' : code.kind === 'error' ? 'Could not load source.' : 'Source unavailable.'}</p>
            {active.method.docstring && <p>{active.method.docstring}</p>}
          </>}
        </div>,
        document.body
      )}
    </TooltipContext.Provider>
  )
}

function MethodRow({ method }: { method: DiagramMethod }) {
  const tooltip = useContext(TooltipContext)
  if (!tooltip) throw new Error('Method rows require a tooltip provider.')
  const edited = method.change === 'unchanged' && method.modified === true
  return (
      <button
        type="button"
        className={`method-row method-${method.change} nodrag nopan`}
        aria-describedby={tooltip.methodId === method.id ? tooltip.id : undefined}
        onMouseEnter={(event) => tooltip.show(method, event.currentTarget)}
        onMouseLeave={(event) => { if (document.activeElement !== event.currentTarget) tooltip.hideSoon(method.id) }}
        onFocus={(event) => tooltip.show(method, event.currentTarget)}
        onBlur={() => tooltip.hideSoon(method.id)}
        onKeyDown={(event) => { if (event.key === 'Escape') tooltip.close() }}
      >
        <span className="method-marker" aria-label={edited ? 'edited' : method.change}>
          {method.change === 'added' ? <Plus size={12} /> : method.change === 'deleted' ? <Minus size={12} /> : edited ? <span className="method-edited-dot" title="Edited method" aria-hidden="true" /> : <span aria-hidden="true">.</span>}
        </span>
        <span className="method-name">{method.name}</span>
      </button>
  )
}

export function ClassNode({ data, selected }: NodeProps<ClassFlowNode>) {
  const { symbol } = data
  return (
    <article className={`class-node class-${symbol.change ?? 'unchanged'} ${selected ? 'class-selected' : ''}`} data-testid="class-node" data-change={symbol.change ?? 'unchanged'} aria-label={`${symbol.name} class`}>
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