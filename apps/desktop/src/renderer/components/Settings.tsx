import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './IconButton'

export function Settings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)

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
        <dl className="session-settings"><div><dt>Data source</dt><dd>Sample fixture</dd></div><div><dt>Language</dt><dd>Python</dd></div></dl>
      </section>
    </dialog>
  )
}