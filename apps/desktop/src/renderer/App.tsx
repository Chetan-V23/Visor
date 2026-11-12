import { useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { Box, ChevronRight, FileCode2, Folder, GitBranch, Settings2 } from 'lucide-react'
import type { DiagramSource } from './diagram/types'
import { DiagramCanvas } from './components/DiagramCanvas'
import { Settings } from './components/Settings'

export function App({ source }: { source: DiagramSource }) {
  const [view] = useState(() => source.load())
  const [selectedId, setSelectedId] = useState(view.changes[0]?.id)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const reducedMotion = useReducedMotion()
  const selectedChange = view.changes.find((change) => change.id === selectedId)

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="brand"><Box size={30} strokeWidth={1.6} /><span>VISOR</span></header>
        <div className="project-label"><Folder size={15} /><span>{view.session.project}</span></div>
        <nav className="changes-nav" aria-label="Changes">
          <div className="changes-heading"><h2>Changes</h2><span>{view.changes.length}</span></div>
          <ol className="changes-list">
            {view.changes.map((change) => (
              <li key={change.id}>
                <button type="button" data-testid="change-entry" className={`change-entry ${change.id === selectedId ? 'change-active' : ''}`} aria-current={change.id === selectedId ? 'step' : undefined} onClick={() => setSelectedId(change.id)}>
                  <span className="change-topline"><span>Change {change.number}</span><time>{change.time}</time></span>
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
          <div className="session-breadcrumb"><span>Sessions</span><ChevronRight size={13} /><span>{view.session.project}</span><span className="sample-label">Sample session</span></div>
          <div className="session-title"><h1>{view.session.name}</h1><span className="branch"><GitBranch size={14} />{view.session.branch}</span></div>
          <div className="session-meta"><span>GitHub Copilot</span><span aria-hidden="true">/</span><span>November 12, 2026</span><span aria-hidden="true">/</span><span>{view.changes.length} changes</span></div>
        </header>
        <motion.div className="diagram-region" initial={reducedMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
          <DiagramCanvas view={view} />
        </motion.div>
        <footer className="session-footer"><span><FileCode2 size={14} />{selectedChange ? `Change ${selectedChange.number}` : 'Session'}<span className="footer-separator" />{selectedChange?.summary}</span><span>Local workspace</span></footer>
      </main>
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}