import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/500.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/space-grotesk/500.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/space-grotesk/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@xyflow/react/dist/style.css'
import '@visor/theme/tokens.css'
import './styles.css'
import { App } from './App'
import { fixtureSource } from './diagram/fixture-source'

const root = document.getElementById('root')
if (!root) throw new Error('Visor cannot find its renderer root.')

createRoot(root).render(
  <React.StrictMode>
    <App source={fixtureSource} />
  </React.StrictMode>
)