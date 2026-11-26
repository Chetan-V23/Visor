import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  appConfigSchema, isFileChangeHook, isHookProvider, MAX_HOOK_BYTES, rawHookSchema, rawPayloadSchema,
  type RawHook, type Runtime
} from '@visor/bridge'
import { dataFolder, readRuntime } from '@visor/bridge/node'
import { savePendingHook } from '@visor/bridge/pending'
import { normalizeHook } from '@visor/core'
import { quotePowerShell, quoteWindowsArgument } from './windows'

async function healthyRuntime(folder: string, timeout = 500): Promise<Runtime | null> {
  const runtime = await readRuntime(folder)
  if (!runtime) return null
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
      headers: { Authorization: `Bearer ${runtime.token}` },
      signal: AbortSignal.timeout(Math.max(1, timeout)),
      redirect: 'error'
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('ok' in body) || !('pid' in body)) return null
    return body.ok === true && body.pid === runtime.pid ? runtime : null
  } catch { return null }
}

async function launchApp(folder: string): Promise<boolean> {
  let configInput: unknown = {}
  try { configInput = JSON.parse(await readFile(join(folder, 'config.json'), 'utf8')) } catch {}
  const config = appConfigSchema.safeParse(configInput)
  const override = process.env.VISOR_APP_PATH
  const appPath = override ?? (config.success ? config.data.appPath : null)
  const appArgs = override ? [] : config.success ? config.data.appArgs : []
  if (!appPath || !isAbsolute(appPath)) return false
  if (process.platform === 'win32') {
    return launchWindowsApp({ appPath, appArgs, folder })
  }
  const env: NodeJS.ProcessEnv = { ...process.env, VISOR_DATA_DIR: folder }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  return new Promise<boolean>((resolve) => {
    const child = spawn(appPath, appArgs, { detached: true, stdio: 'ignore', windowsHide: true, env })
    child.once('error', () => resolve(false))
    child.once('spawn', () => { child.unref(); resolve(true) })
  })
}

async function launchWindowsApp({ appPath, appArgs, folder }: {
  appPath: string
  appArgs: string[]
  folder: string
}): Promise<boolean> {
  const bootstrap = [
    "$ErrorActionPreference = 'Stop'",
    `$env:VISOR_DATA_DIR = ${quotePowerShell(folder)}`,
    `$env:VISOR_CAPTURE_DIR = ${process.env.VISOR_CAPTURE_DIR ? quotePowerShell(process.env.VISOR_CAPTURE_DIR) : '$null'}`,
    '$env:ELECTRON_RUN_AS_NODE = $null',
    '$env:ELECTRON_RENDERER_URL = $null',
    '$process = New-Object System.Diagnostics.Process',
    `$process.StartInfo.FileName = ${quotePowerShell(appPath)}`,
    `$process.StartInfo.Arguments = ${quotePowerShell(appArgs.map(quoteWindowsArgument).join(' '))}`,
    '$process.StartInfo.UseShellExecute = $false',
    '$process.StartInfo.CreateNoWindow = $true',
    '$null = $process.Start()'
  ].join('\n')
  const encodedBootstrap = Buffer.from(bootstrap, 'utf16le').toString('base64')
  const broker = [
    "$ErrorActionPreference = 'Stop'",
    '$shell = New-Object -ComObject Shell.Application',
    `$shell.ShellExecute('powershell.exe', '-NoProfile -NonInteractive -EncodedCommand ${encodedBootstrap}', '', 'open', 0)`
  ].join('\n')
  const encodedBroker = Buffer.from(broker, 'utf16le').toString('base64')
  return new Promise<boolean>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedBroker], {
      stdio: 'ignore', windowsHide: true
    })
    child.once('error', () => resolve(false))
    child.once('close', (code) => resolve(code === 0))
  })
}

export async function forwardRaw({ event, input, source = 'copilot', folder = dataFolder() }: {
  event: string | undefined
  input: unknown
  source?: string
  folder?: string
}): Promise<void> {
  if (!isHookProvider(source)) return
  const payload = rawPayloadSchema.safeParse(input)
  if (!payload.success) return
  const parsed = rawHookSchema.safeParse({
    id: randomUUID(), source, event, receivedAt: Date.now(), payload: payload.data
  })
  if (!parsed.success) return

  let runtime = await healthyRuntime(folder)
  if (!runtime) {
    if (!isFileChangeHook(parsed.data)) return
    const root = typeof parsed.data.payload.cwd === 'string' ? parsed.data.payload.cwd : ''
    const normalized = normalizeHook(parsed.data, { workspaceRoot: root, workspaceId: root, seq: 0 })
    const edit = normalized.ok ? normalized.events[0] : undefined
    if (edit?.kind === 'edit.pending' || edit?.kind === 'edit.applied') {
      try { await savePendingHook(folder, parsed.data, edit.payload.files) } catch {}
    }
    if (!await launchApp(folder)) return
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      runtime = await healthyRuntime(folder, Math.min(200, deadline - Date.now()))
      if (runtime) break
      await delay(Math.min(50, Math.max(0, deadline - Date.now())))
    }
  }
  if (!runtime) return
  await postRaw({ runtime, raw: parsed.data })
}

async function postRaw({ runtime, raw }: { runtime: Runtime; raw: RawHook }): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(raw),
      signal: AbortSignal.timeout(500),
      redirect: 'error'
    })
    await response.arrayBuffer()
  } catch {}
}

export async function forwardStdin(event: string | undefined, source?: string): Promise<void> {
  process.stdin.setEncoding('utf8')
  let text = ''
  let bytes = 0
  const timer = setTimeout(() => process.stdin.destroy(), 500)
  try {
    for await (const chunk of process.stdin) {
      const value = String(chunk)
      bytes += Buffer.byteLength(value)
      if (bytes > MAX_HOOK_BYTES) return
      text += value
    }
    clearTimeout(timer)
    const input: unknown = JSON.parse(text)
    await forwardRaw({ event, input, source })
  } catch {} finally { clearTimeout(timer) }
}
