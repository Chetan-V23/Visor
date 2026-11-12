import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { dataFolder, removeOwnedRuntime, writeJsonAtomic } from '@visor/bridge/node'
import { HookMonitor } from './hook-monitor'
import { startHookServer } from './hook-server'

app.setName('Visor')
const folder = dataFolder()
mkdirSync(folder, { recursive: true })
app.setPath('userData', folder)
let window: BrowserWindow | null = null
let server: Awaited<ReturnType<typeof startHookServer>> | null = null
let monitor: HookMonitor | null = null
let shuttingDown = false

function focusWindow(): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function requireRenderer(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('IPC caller is not the Visor renderer.')
  }
}

function createWindow(): void {
  window = new BrowserWindow({
    title: 'Visor',
    width: 1400,
    height: 900,
    minWidth: 760,
    minHeight: 580,
    backgroundColor: '#F2D479',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('closed', () => { window = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', focusWindow)
  void app.whenReady().then(async () => {
    server = await startHookServer({ onRaw: (raw) => monitor?.ingest(raw) })
    monitor = new HookMonitor({
      port: server.runtime.port,
      dataFolder: folder,
      captureFolder: app.isPackaged ? null : process.env.VISOR_CAPTURE_DIR ?? resolve(__dirname, '../../../../fixtures/raw-hooks'),
      onSessionStart: focusWindow,
      onSnapshot: (snapshot) => {
        if (window && !window.isDestroyed()) window.webContents.send('visor:hooks:snapshot', snapshot)
      }
    })
    ipcMain.handle('visor:hooks:get', (event) => {
      requireRenderer(event)
      return monitor?.snapshot()
    })
    ipcMain.handle('visor:hooks:debug', (event, enabled: unknown) => {
      requireRenderer(event)
      if (typeof enabled !== 'boolean') throw new Error('Debug setting must be a boolean.')
      return monitor?.setDebugEnabled(enabled)
    })
    createWindow()
    await writeJsonAtomic(join(folder, 'runtime.json'), server.runtime)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else focusWindow()
    })
  }).catch(() => {
    dialog.showErrorBox('Visor startup failed', 'The local hook server could not start. Check access to the Visor data folder.')
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (shuttingDown || !server) return
    event.preventDefault()
    shuttingDown = true
    const ownedServer = server
    void (async () => {
      await ownedServer.close()
      await monitor?.flush()
      await removeOwnedRuntime(folder, ownedServer.runtime)
    })().catch(() => {}).finally(() => app.quit())
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})