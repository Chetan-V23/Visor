import { useEffect, useRef, useState } from 'react'
import type { HookSnapshot } from '@visor/bridge'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'

export function Settings({ hooks, preview, onClose }: { hooks: HookSnapshot | null; preview: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [debugEnabled, setDebugEnabled] = useState(hooks?.debugEnabled ?? false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setDebugEnabled(hooks?.debugEnabled ?? false) }, [hooks?.debugEnabled])

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  return (
    <dialog ref={dialog} className="settings-dialog" onCancel={onClose} onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="settings-content" aria-labelledby="settings-title">
        <header><h2 id="settings-title">Settings</h2><IconButton label="Close settings" onClick={onClose}><X size={20} /></IconButton></header>
        <h3>Appearance</h3>
        <dl className="palette-list">
          <div><dt><span className="color-swatch swatch-app" />App background</dt><dd>#F2D479</dd></div>
          <div><dt><span className="color-swatch swatch-diagram" />Diagram background</dt><dd>#D97A2B</dd></div>
          <div><dt><span className="color-swatch swatch-added" />Added text</dt><dd>#6FAF4F</dd></div>
          <div><dt><span className="color-swatch swatch-deleted" />Deleted text</dt><dd>#C44A3A</dd></div>
        </dl>
        <h3>Session</h3>
        <dl className="session-settings"><div><dt>Data source</dt><dd>{preview ? 'Sample fixture' : 'Stored history'}</dd></div><div><dt>Language</dt><dd>Python</dd></div></dl>
        {hooks && <>
          <h3>Hook connection</h3>
          <dl className="session-settings">
            <div><dt>Server</dt><dd>127.0.0.1:{hooks.port}</dd></div>
            <div><dt>Data folder</dt><dd className="settings-path">{hooks.dataFolder}</dd></div>
            {hooks.captureFolder && <div><dt>Capture folder</dt><dd className="settings-path">{hooks.captureFolder}</dd></div>}
          </dl>
          {hooks.devMode && <>
            <label className="debug-toggle"><span>Raw hook capture</span><input type="checkbox" checked={debugEnabled} onChange={(event) => {
              const enabled = event.currentTarget.checked
              setDebugEnabled(enabled)
              setError(null)
              void window.visorHooks?.setDebugEnabled(enabled).then((snapshot) => {
                setDebugEnabled(snapshot.debugEnabled)
              }).catch(() => {
                setDebugEnabled(hooks.debugEnabled)
                setError('Could not update the debug setting.')
              })
            }} /></label>
            <p role="alert" className="settings-error">{error ?? hooks.captureError ?? hooks.normalizationError}</p>
            {hooks.debugEnabled && <section className="raw-events" aria-labelledby="normalized-events-title">
              <h3 id="normalized-events-title">Normalized events <span>{hooks.normalizedEvents?.length ?? 0}</span></h3>
              <ol>{hooks.normalizedEvents?.map((event) => <li key={event.id} data-testid="normalized-hook-entry">
                <details><summary><span>{event.kind}</span><time>{new Date(event.ts).toLocaleTimeString()}</time></summary><pre>{JSON.stringify(event, null, 2)}</pre></details>
              </li>)}</ol>
            </section>}
            {hooks.debugEnabled && <section className="raw-events" aria-labelledby="raw-events-title">
              <h3 id="raw-events-title">Raw hook events <span>{hooks.events.length}</span></h3>
              <ol>
                {hooks.events.map((raw) => <li key={raw.id} data-testid="raw-hook-entry">
                  <details><summary><span>{raw.event}</span><time>{new Date(raw.receivedAt).toLocaleTimeString()}</time></summary><pre>{JSON.stringify(raw.payload, null, 2)}</pre></details>
                </li>)}
              </ol>
              {hooks.events.length === 0 && <p className="raw-empty">No events received</p>}
            </section>}
          </>}
        </>}
      </section>
    </dialog>
  )
}