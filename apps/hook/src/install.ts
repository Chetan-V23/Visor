import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { appConfigSchema, hookProviders, isHookProvider, rawPayloadSchema, type AppConfig, type HookProvider } from '@visor/bridge'
import { dataFolder, writeJsonAtomic } from '@visor/bridge/node'
import { quotePowerShell } from './windows'

export const hookEvents = Object.keys(hookProviders.copilot.events)

function quoteBash(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

type Launcher = { nodePath: string; hookPath: string }

export function hookConfiguration({ nodePath, hookPath }: Launcher) {
  return {
    version: 1,
    hooks: Object.fromEntries(hookEvents.map((event) => [event, [{
      type: 'command',
      powershell: `& ${[nodePath, hookPath, event].map(quotePowerShell).join(' ')}`,
      bash: [nodePath, hookPath, event].map(quoteBash).join(' '),
      timeoutSec: 5
    }]]))
  }
}

const hookFiles = {
  copilot: ['.github', 'hooks', 'visor.json'],
  codex: ['.codex', 'hooks.json'],
  'claude-code': ['.claude', 'settings.local.json']
} satisfies Record<HookProvider, string[]>

function lifecycleConfiguration(provider: Exclude<HookProvider, 'copilot'>, { nodePath, hookPath }: Launcher) {
  return Object.fromEntries(Object.keys(hookProviders[provider].events).map((event) => {
    const args = [hookPath, event, provider]
    const command = [nodePath, ...args].map(quoteBash).join(' ')
    const powershell = `& ${[nodePath, ...args].map(quotePowerShell).join(' ')}`
    const handler: Record<string, string | number> = provider === 'codex'
      ? { type: 'command', command, commandWindows: powershell, timeout: 5 }
      : process.platform === 'win32'
        ? { type: 'command', command: powershell, shell: 'powershell', timeout: 5 }
        : { type: 'command', command, timeout: 5 }
    return [event, { hooks: [handler] }]
  }))
}

async function readJson(path: string): Promise<unknown> {
  let existing: string
  try { existing = await readFile(path, 'utf8') } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    return undefined
  }
  return JSON.parse(existing.replace(/^\uFEFF/, ''))
}

function checkOwnedConfig(path: string, existing: unknown, desired: unknown): void {
  if (existing !== undefined && !isDeepStrictEqual(existing, desired)) {
    throw new Error(`Existing configuration differs. Refusing to overwrite ${path}.`)
  }
}

function mergeLifecycleHooks(path: string, previous: unknown, provider: Exclude<HookProvider, 'copilot'>, launcher: Launcher) {
  const settings = rawPayloadSchema.safeParse(previous === undefined ? {} : previous)
  if (!settings.success) throw new Error(`Invalid settings in ${path}.`)
  const hooks = rawPayloadSchema.safeParse(settings.data.hooks === undefined ? {} : settings.data.hooks)
  if (!hooks.success) throw new Error(`Invalid hook configuration in ${path}.`)
  for (const [event, group] of Object.entries(lifecycleConfiguration(provider, launcher))) {
    const groups = hooks.data[event] ?? []
    if (!Array.isArray(groups)) throw new Error(`Expected a list of ${event} hooks in ${path}.`)
    if (!groups.some((existing) => isDeepStrictEqual(existing, group))) hooks.data[event] = [...groups, group]
  }
  return { ...settings.data, hooks: hooks.data }
}

export async function installHooks({ workspace, config, folder = dataFolder(), hookPath, nodePath = process.execPath, provider = 'copilot' }: {
  workspace: string
  config: AppConfig
  folder?: string
  hookPath: string
  nodePath?: string
  provider?: HookProvider
}): Promise<string> {
  const validated = appConfigSchema.parse(config)
  if (![workspace, hookPath, nodePath, validated.appPath].every(isAbsolute)) {
    throw new Error('Workspace, launcher, Node, and hook paths must be absolute.')
  }
  const hookFile = join(workspace, ...hookFiles[provider])
  const configFile = join(folder, 'config.json')
  const existingConfig = await readJson(configFile)
  const existingHooks = await readJson(hookFile)
  checkOwnedConfig(configFile, existingConfig, validated)
  const launcher = { nodePath, hookPath }
  const hooks = provider === 'copilot'
    ? hookConfiguration(launcher)
    : mergeLifecycleHooks(hookFile, existingHooks, provider, launcher)
  if (provider === 'copilot') checkOwnedConfig(hookFile, existingHooks, hooks)
  if (existingConfig === undefined) await writeJsonAtomic(configFile, validated)
  if (!isDeepStrictEqual(existingHooks, hooks)) await writeJsonAtomic(hookFile, hooks)
  return hookFile
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    workspace: { type: 'string' },
    provider: { type: 'string', default: 'copilot' },
    'app-path': { type: 'string' },
    'app-entry': { type: 'string' }
  } })
  if (!values.workspace) throw new Error('Provide --workspace <sandbox-folder>.')
  if (!isHookProvider(values.provider)) throw new Error(`Choose --provider ${Object.keys(hookProviders).join(', ')}.`)
  const desktopFolder = resolve(__dirname, '../../desktop')
  const desktopRequire = createRequire(join(desktopFolder, 'package.json'))
  const defaultApp: unknown = values['app-path'] ?? desktopRequire('electron')
  const config = appConfigSchema.parse({
    appPath: defaultApp,
    appArgs: values['app-entry'] ? [resolve(values['app-entry'])] : values['app-path'] ? [] : [join(desktopFolder, 'out', 'main', 'index.js')]
  })
  const path = await installHooks({
    workspace: resolve(values.workspace),
    config,
    provider: values.provider,
    hookPath: resolve(__dirname, '../bin/visor-hook.cjs')
  })
  process.stdout.write(`Registered Visor hooks at ${path}\n`)
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Hook registration failed.'}\n`)
    process.exitCode = 1
  })
}
