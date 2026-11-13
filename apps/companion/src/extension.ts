import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import { dataFolder, readRuntime } from '@visor/bridge/node'
import { pathSchema, semanticQueryResponseSchema, semanticDocumentSchema, type SemanticDocument } from '@visor/protocol'

function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }
function localPath(root: vscode.WorkspaceFolder, uri: vscode.Uri): string | null {
  if (uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath !== root.uri.fsPath) return null
  const path = pathSchema.safeParse(relative(root.uri.fsPath, uri.fsPath).replace(/\\/g, '/'))
  return path.success ? path.data : null
}

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.isTrusted) return
  const output = vscode.window.createOutputChannel('Visor Companion')
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const busy = new Set<string>()
  const pending = new Map<string, vscode.Uri>()
  let disposed = false
  const update = async (uri: vscode.Uri): Promise<void> => {
    const key = uri.toString()
    if (disposed) return
    if (busy.has(key)) { pending.set(key, uri); return }
    const root = vscode.workspace.getWorkspaceFolder(uri)
    if (!root || uri.scheme !== 'file' || !uri.path.endsWith('.py')) return
    busy.add(key)
    try {
      const configured = vscode.workspace.getConfiguration('visor').get<string>('dataFolder', '')
      const runtime = await readRuntime(configured || dataFolder())
      if (!runtime) return
      const document = await vscode.workspace.openTextDocument(uri)
      const file = localPath(root, uri)
      if (!file || document.isDirty) return
      const version = document.version
      const sourceHash = hash(document.getText())
      const headers = { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }
      const source = { v: 1 as const, workspaceRoot: root.uri.fsPath, file, hash: sourceHash }
      const url = `http://127.0.0.1:${runtime.port}`
      const response = await fetch(`${url}/semantic/queries`, { method: 'POST', headers, body: JSON.stringify(source), signal: AbortSignal.timeout(2000) })
      if (!response.ok) return
      const { positions } = semanticQueryResponseSchema.parse(await response.json())
      const definitions: SemanticDocument['definitions'] = []
      const targetVersions = new Map<vscode.TextDocument, number>()
      const deadline = Date.now() + 10000
      const lookup = async (command: string, point: vscode.Position): Promise<(vscode.Location | vscode.LocationLink)[]> => {
        const remaining = Math.min(1500, deadline - Date.now())
        if (remaining <= 0) return []
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await new Promise<(vscode.Location | vscode.LocationLink)[]>((resolve, reject) => {
            timer = setTimeout(() => resolve([]), remaining)
            vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(command, uri, point).then((locations) => resolve(locations ?? []), reject)
          })
        } catch { return [] }
        finally { if (timer) clearTimeout(timer) }
      }
      for (const position of positions) {
        if (disposed || document.version !== version || document.isDirty) return
        if (Date.now() >= deadline) break
        const point = new vscode.Position(position.line - 1, position.column)
        const types = await lookup('vscode.executeTypeDefinitionProvider', point)
        const locations = types.length ? types : await lookup('vscode.executeDefinitionProvider', point)
        const targets: SemanticDocument['definitions'][number]['targets'] = []
        for (const location of locations.slice(0, 32)) {
          const targetUri = 'targetUri' in location ? location.targetUri : location.uri
          const targetRange = 'targetUri' in location ? location.targetSelectionRange ?? location.targetRange : location.range
          const targetFile = localPath(root, targetUri)
          if (!targetFile) continue
          const target = await vscode.workspace.openTextDocument(targetUri)
          if (target.isDirty) continue
          if (targetVersions.has(target) && targetVersions.get(target) !== target.version) return
          targetVersions.set(target, target.version)
          targets.push({ file: targetFile, hash: hash(target.getText()), range: { start: { line: targetRange.start.line + 1, column: targetRange.start.character }, end: { line: targetRange.end.line + 1, column: targetRange.end.character } } })
        }
        if (targets.length) definitions.push({ position, targets })
      }
      if (disposed || document.version !== version || document.isDirty) return
      if ([...targetVersions].some(([target, targetVersion]) => target.isDirty || target.version !== targetVersion)) return
      const facts = semanticDocumentSchema.parse({ ...source, provider: 'vscode-language-server', definitions })
      const saved = await fetch(`${url}/semantic`, { method: 'POST', headers, body: JSON.stringify(facts), signal: AbortSignal.timeout(2000) })
      if (saved.ok) output.appendLine(`Updated ${file}: ${definitions.length} resolved reference positions.`)
    } catch { output.appendLine('Semantic refresh unavailable. Visor continues using source analysis.') }
    finally {
      busy.delete(key)
      const next = pending.get(key)
      pending.delete(key)
      if (next && !disposed) schedule(next)
    }
  }
  const schedule = (uri: vscode.Uri) => {
    const key = uri.toString()
    const previous = timers.get(key)
    if (previous) clearTimeout(previous)
    timers.set(key, setTimeout(() => { timers.delete(key); void update(uri) }, 800))
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.py')
  context.subscriptions.push(output, watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule),
    vscode.workspace.onDidSaveTextDocument((document) => schedule(document.uri)),
    vscode.commands.registerCommand('visor.refreshRelations', async () => {
      const files = await vscode.workspace.findFiles('**/*.py', '**/{.git,node_modules,.venv,venv}/**', 500)
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Refreshing Visor relationships', cancellable: true }, async (progress, cancellation) => {
        for (const uri of files) {
          if (disposed || cancellation.isCancellationRequested) return
          progress.report({ message: vscode.workspace.asRelativePath(uri), increment: 100 / files.length })
          await update(uri)
        }
      })
    }), { dispose: () => { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); pending.clear() } })
  for (const document of vscode.workspace.textDocuments) schedule(document.uri)
}