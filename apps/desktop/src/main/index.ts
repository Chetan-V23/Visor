import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { dataFolder, removeOwnedRuntime, writeJsonAtomic } from '@visor/bridge/node'
import { listPendingHooks, readPendingHook, removePendingHook } from '@visor/bridge/pending'
import { methodCodeRequestSchema, rawHookSchema } from '@visor/bridge'
import Parser from 'web-tree-sitter'
import { contentHash, methodCode, PythonExtractor } from '@visor/core'
import { openDatabase, SqliteChangeStore } from '@visor/store'
import { HookMonitor } from './hook-monitor'
import { startHookServer } from './hook-server'
import { ChangePipeline } from './change-pipeline'
import { snapshotPolicy, workspaceRoot } from '@visor/bridge/workspace'

app.setName('Visor')
const folder = dataFolder()
mkdirSync(folder, { recursive: true })
app.setPath('userData', folder)
let window: BrowserWindow | null = null
let server: Awaited<ReturnType<typeof startHookServer>> | null = null
let monitor: HookMonitor | null = null
let database: ReturnType<typeof openDatabase> | null = null
let parser: Parser | null = null
let pipeline: ChangePipeline | null = null
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
    const require = createRequire(join(__dirname, 'index.js'))
    const nativeRoot = dirname(require.resolve('better-sqlite3/package.json'))
    database = openDatabase(join(folder, 'visor.db'), join(nativeRoot, `build/visor-electron-${process.versions.modules}`, 'better_sqlite3.node'))
    const store = new SqliteChangeStore(database, ['001_initial', '002_indexes', '003_semantic'].map((name, index) => ({ version: index + 1, sql: readFileSync(require.resolve(`@visor/store/migrations/${name}.sql`), 'utf8') })))
    await Parser.init()
    parser = new Parser()
    parser.setLanguage(await Parser.Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')))
    const extractor = new PythonExtractor(parser)
    pipeline = new ChangePipeline({
      store, extractors: [extractor],
      onNormalized: (events, error) => {
        if (error) console.warn(`[Visor] ${error}`)
        monitor?.recordNormalization(events, error ?? null)
        if (events.some((event) => event.kind === 'session.started' || event.kind === 'prompt.submitted' || event.kind === 'session.ended') && window && !window.isDestroyed()) window.webContents.send('visor:sessions:changed')
      },
      onChangeAdded: (stored) => {
        if (window && !window.isDestroyed()) window.webContents.send('visor:changes:added', stored.change)
      }
    })
    for (const pending of await listPendingHooks(folder)) {
      pipeline.enqueue(pending.raw, pending)
      await pipeline.flush()
      if (store.hasEvent(pending.raw.id)) await removePendingHook(folder, pending.raw.id)
    }
    server = await startHookServer({ onRaw: async (raw) => {
      monitor?.ingest(raw)
      const pending = readPendingHook(folder, raw.id)
      pipeline?.enqueue(pending?.raw ?? raw, pending ?? undefined)
      if (pending) {
        await pipeline?.flush()
        if (store.hasEvent(pending.raw.id)) await removePendingHook(folder, pending.raw.id)
      }
    }, onQueries: (document) => {
      try {
        const root = workspaceRoot(document.workspaceRoot)
        if (!snapshotPolicy(root)(document.file) || !store.hasSourceVersion(root, document.file, document.hash)) return null
        const text = store.getBlob(document.hash)
        if (text === null) return null
        const positions = extractor.extract(document.file, text).analysis?.relations.flatMap((relation) => [relation.from, relation.to].flatMap((reference) => reference.range && !reference.name.startsWith('py:') ? [reference.range.start] : [])) ?? []
        return positions.filter((position, index) => positions.findIndex((candidate) => candidate.line === position.line && candidate.column === position.column) === index).slice(0, 512)
      } catch { return null }
    }, onSemantic: (document) => {
      try {
        const root = workspaceRoot(document.workspaceRoot)
        const allowed = snapshotPolicy(root)
        if (!allowed(document.file) || document.definitions.some((entry) => entry.targets.some((target) => !allowed(target.file)))) return false
        if (!store.putSemantic({ ...document, workspaceRoot: root })) return false
        for (const session of store.listSessions()) {
          if (session.project.id !== contentHash(process.platform === 'win32' ? root.toLowerCase() : root)) continue
          const latest = store.latestChange(session.id)
          if (latest && window && !window.isDestroyed()) window.webContents.send('visor:changes:added', latest.change)
        }
        return true
      } catch { return false }
    } })
    monitor = new HookMonitor({
      port: server.runtime.port,
      dataFolder: folder,
      captureFolder: app.isPackaged ? null : process.env.VISOR_CAPTURE_DIR ?? resolve(__dirname, '../../../../fixtures/raw-hooks'),
      onFileChange: focusWindow,
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
    ipcMain.handle('visor:history:sessions', (event) => {
      requireRenderer(event)
      return store.listSessions()
    })
    ipcMain.handle('visor:history:changes', (event, sessionId: unknown) => {
      requireRenderer(event)
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) throw new Error('Invalid session identity.')
      return pipeline?.listChanges(sessionId) ?? []
    })
    ipcMain.handle('visor:history:get', (event, id: unknown) => {
      requireRenderer(event)
      const stored = store.getChange(rawHookSchema.shape.id.parse(id))
      return stored ? pipeline?.snapshot(stored) ?? stored : null
    })
    ipcMain.handle('visor:history:method', (event, request: unknown) => {
      requireRenderer(event)
      const { changeId, methodId } = methodCodeRequestSchema.parse(request)
      const raw = store.getChange(changeId)
      const selected = raw ? pipeline?.snapshot(raw) ?? raw : null
      if (!selected) return null
      const { change, model } = selected
      const previous = change.cause.kind === 'baseline' ? selected : store.previousChange(change.sessionId, change.seq)
      const afterOwner = model.classes.find((symbol) => symbol.methods.some((method) => method.id === methodId))
      const beforeOwner = previous?.model.classes.find((symbol) => symbol.methods.some((method) => method.id === methodId))
      const file = afterOwner?.file ?? beforeOwner?.file
      if (!file) return null
      let beforeMethod = beforeOwner?.methods.find((method) => method.id === methodId)
      const afterMethod = afterOwner?.methods.find((method) => method.id === methodId)
      for (const delta of change.delta) {
        if (delta.op === 'member.change' && delta.before.kind === 'method' && delta.before.id === methodId) beforeMethod = delta.before
        if (delta.op === 'member.remove' && delta.member.kind === 'method' && delta.member.id === methodId) beforeMethod = delta.member
      }
      const affected = change.files.find((entry) => entry.path === file)
      const beforeText = change.cause.kind === 'baseline' ? store.sourceAtChange(change.sessionId, change.seq, file)
        : affected ? affected.beforeHash === null ? null : store.getBlob(affected.beforeHash) : store.sourceAtChange(change.sessionId, change.seq - 1, file)
      const afterText = store.sourceAtChange(change.sessionId, change.seq, file)
      return methodCode({ file,
        before: beforeMethod?.range && beforeText !== null ? { text: beforeText, range: beforeMethod.range } : null,
        after: afterMethod?.range && afterText !== null ? { text: afterText, range: afterMethod.range } : null
      })
    })
    createWindow()
    await writeJsonAtomic(join(folder, 'runtime.json'), server.runtime)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else focusWindow()
    })
  }).catch(() => {
    database?.close()
    parser?.delete()
    dialog.showErrorBox('Visor startup failed', 'The local database or hook server could not start. Check access to the Visor data folder and run pnpm rebuild:sqlite after changing Electron versions.')
    app.quit()
  })

  app.on('before-quit', (event) => {
    if (shuttingDown || !server) return
    event.preventDefault()
    shuttingDown = true
    const ownedServer = server
    void (async () => {
      await ownedServer.close()
      await pipeline?.flush()
      await monitor?.flush()
      database?.close()
      parser?.delete()
      await removeOwnedRuntime(folder, ownedServer.runtime)
    })().catch(() => {}).finally(() => app.quit())
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})