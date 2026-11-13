import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { historySnapshotSchema, type HistorySnapshot } from '@visor/bridge'
import { changeSchema, sessionSummarySchema, type Change, type SessionSummary } from '@visor/protocol'
import { toDiagramChange, toDiagramView } from './protocol-adapter'
import type { DiagramSource, DiagramView } from './types'

interface HistoryState {
  mode: 'live' | 'paused'
  sessionId: string | null
  selectedId: string | null
  sessions: SessionSummary[]
  changes: Change[]
  snapshot: HistorySnapshot | null
  loading: boolean
  error: string | null
}

type HistoryRequest = Pick<HistoryState, 'mode' | 'sessionId' | 'selectedId'> & { version: number }

const emptyView: DiagramView = { session: { name: 'No session', project: 'Local workspace', branch: '' }, classes: [], edges: [], changes: [] }

export function useHistory(source: DiagramSource) {
  const preview = !window.visorHistory
  const [sample] = useState(() => preview ? source.load() : emptyView)
  const [state, setState] = useState<HistoryState>({ mode: 'live', sessionId: null, selectedId: preview ? sample.changes[0]?.id ?? null : null, sessions: [], changes: [], snapshot: null, loading: !preview, error: null })
  const request = useRef<HistoryRequest>({ version: 0, mode: 'live', sessionId: null, selectedId: null })

  async function load(sessionId: string | null, selectedId: string | null, mode: HistoryState['mode']): Promise<void> {
    const bridge = window.visorHistory
    if (!bridge) return
    const current = request.current.version + 1
    request.current = { version: current, mode, sessionId, selectedId }
    setState((previous) => ({ ...previous, mode, sessionId: sessionId ?? previous.sessionId, selectedId: selectedId ?? previous.selectedId, loading: true, error: null }))
    try {
      const sessions = sessionSummarySchema.array().parse(await bridge.listSessions())
      const session = sessions.find((candidate) => candidate.id === sessionId) ?? sessions[0]
      const changes = session ? changeSchema.array().parse(await bridge.listChanges(session.id)) : []
      const selected = mode === 'paused' ? changes.find((change) => change.id === selectedId) ?? changes[0] : changes[0]
      const document = selected ? await bridge.getChange(selected.id) : null
      const snapshot = document === null ? null : historySnapshotSchema.parse(document)
      if (current !== request.current.version) return
      request.current = { version: current, mode, sessionId: session?.id ?? null, selectedId: selected?.id ?? null }
      setState({ mode, sessionId: session?.id ?? null, selectedId: selected?.id ?? null, sessions, changes, snapshot, loading: false, error: null })
    } catch {
      if (current === request.current.version) setState((previous) => ({ ...previous, loading: false, error: 'Could not load session history.' }))
    }
  }

  const refresh = useEffectEvent((change?: Change) => {
    const selection = request.current
    const sessionId = selection.mode === 'live' && change ? change.sessionId : selection.sessionId
    void load(sessionId, selection.mode === 'paused' ? selection.selectedId : null, selection.mode)
  })
  useEffect(() => {
    const bridge = window.visorHistory
    if (!bridge) return
    refresh()
    const unsubscribeChange = bridge.onChangeAdded((change) => refresh(change))
    const unsubscribeSession = bridge.onSessionsChanged(() => refresh())
    return () => { request.current.version++; unsubscribeChange(); unsubscribeSession() }
  }, [])

  const session = state.sessions.find((candidate) => candidate.id === state.sessionId)
  const view: DiagramView = preview ? sample : session ? {
    session: { name: session.title?.trim() || new Date(session.startedAt).toLocaleString(), project: session.project.name, branch: session.project.branch },
    ...(state.snapshot ? toDiagramView(state.snapshot.model, state.snapshot.change) : { classes: [], edges: [] }),
    changes: state.changes.map((change) => toDiagramChange(change, state.snapshot?.model ?? { v: 1, classes: [], relations: [] }))
  } : emptyView

  function selectChange(id: string): void {
    if (preview) { setState((previous) => ({ ...previous, selectedId: id, mode: id === sample.changes[0]?.id ? 'live' : 'paused' })); return }
    void load(state.sessionId, id, id === state.changes[0]?.id ? 'live' : 'paused')
  }
  function setLive(enabled: boolean): void {
    if (preview) { setState((previous) => ({ ...previous, mode: enabled ? 'live' : 'paused', selectedId: enabled ? sample.changes[0]?.id ?? null : previous.selectedId })); return }
    void load(state.sessionId, state.selectedId, enabled ? 'live' : 'paused')
  }
  function selectSession(id: string): void { void load(id, null, 'live') }

  return { view, selectedId: state.selectedId, sessions: state.sessions, sessionId: state.sessionId, session, live: state.mode === 'live', loading: state.loading, error: state.error, preview, selectChange, selectSession, setLive }
}