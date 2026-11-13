import { useEffect, useState } from 'react'
import type { HookSnapshot } from '@visor/bridge'
import { motion, useReducedMotion } from 'framer-motion'
import { Box, ChevronRight, FileCode2, Folder, GitBranch, Settings2 } from 'lucide-react'
import type { DiagramSource } from './diagram/types'
import { useHistory } from './diagram/history-source'
import { DiagramCanvas } from './components/DiagramCanvas'
import { Settings } from './components/Settings'

export function App({ source }: { source: DiagramSource }) {
  const history = useHistory(source)
  const { view, selectedId } = history
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [hooks, setHooks] = useState<HookSnapshot | null>(null)
  const reducedMotion = useReducedMotion()
  const selectedChange = view.changes.find((change) => change.id === selectedId)

  useEffect(() => {
    const bridge = window.visorHooks
    if (!bridge) return
    let active = true
    const update = (snapshot: HookSnapshot) => { if (active) setHooks(snapshot) }
    const unsubscribe = bridge.onSnapshot(update)
    void bridge.getSnapshot().then(update).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="brand"><Box size={30} strokeWidth={1.6} /><span>VISOR</span></header>
        <div className="project-label"><Folder size={15} /><span>{view.session.project}</span></div>
        {!history.preview && history.sessions.length > 0 && <label className="session-picker"><span>Session</span><select aria-label="Session" value={history.sessionId ?? ''} onChange={(event) => history.selectSession(event.currentTarget.value)}>
          {history.sessions.map((session) => <option key={session.id} value={session.id}>{session.title?.trim() || new Date(session.startedAt).toLocaleString()}</option>)}
        </select></label>}
        <nav className="changes-nav" aria-label="Changes" onKeyDown={(event) => {
          if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
          const current = view.changes.findIndex((change) => change.id === selectedId)
          const next = view.changes[Math.max(0, Math.min(view.changes.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]
          if (!next) return
          event.preventDefault()
          history.selectChange(next.id)
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-change-id="${next.id}"]`)?.focus()
        }}>
          <div className="changes-heading"><h2>Changes <span className="change-count">{view.changes.length}</span></h2><label className="live-toggle"><input type="checkbox" role="switch" aria-label="Live" checked={history.live} onChange={(event) => history.setLive(event.currentTarget.checked)} /><span>Live</span></label></div>
          <ol className="changes-list">
            {view.changes.map((change) => (
              <li key={change.id}>
                <button type="button" data-testid="change-entry" data-change-id={change.id} className={`change-entry ${change.id === selectedId ? 'change-active' : ''}`} aria-current={change.id === selectedId ? 'step' : undefined} onClick={() => history.selectChange(change.id)}>
                  <span className="change-topline"><span>{change.number === 0 ? 'Baseline' : `Change ${change.number}`}</span><time>{change.time}</time></span>
                  <span className="change-summary">{change.summary}</span>
                  <span className="change-meta"><span><FileCode2 size={13} />{change.files} {change.files === 1 ? 'file' : 'files'}</span><span className="diff-added">+{change.added}</span><span className="diff-deleted">-{change.deleted}</span></span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <footer className="sidebar-footer"><button type="button" className="settings-button" onClick={() => setSettingsOpen(true)}><Settings2 size={18} />Settings<ChevronRight size={15} /></button><span className="app-version">Visor <span>0.1.0</span></span></footer>
      </aside>
      <main className="main-panel">
        <header className="session-header">
          <div className="session-breadcrumb"><span>Sessions</span><ChevronRight size={13} /><span>{view.session.project}</span>{history.preview && <span className="sample-label">Sample session</span>}</div>
          <div className="session-title"><h1 title={view.session.name}>{view.session.name}</h1>{view.session.branch && <span className="branch"><GitBranch size={14} />{view.session.branch}</span>}</div>
          <div className="session-meta"><span>GitHub Copilot</span>{history.session && <><span aria-hidden="true">/</span><time>{new Date(history.session.startedAt).toLocaleDateString()}</time></>}<span aria-hidden="true">/</span><span>{view.changes.length} changes</span>{history.loading && <span role="status">Loading</span>}</div>
          {history.error && <p role="alert" className="history-error">{history.error}</p>}
        </header>
        <motion.div className="diagram-region" initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <DiagramCanvas view={view} />
        </motion.div>
        <footer className="session-footer"><span><FileCode2 size={14} />{selectedChange ? `Change ${selectedChange.number}` : 'Session'}<span className="footer-separator" />{selectedChange?.summary}</span><span>Local workspace</span></footer>
      </main>
      {settingsOpen && <Settings hooks={hooks} preview={history.preview} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}