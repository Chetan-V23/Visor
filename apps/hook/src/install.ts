import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { appConfigSchema, type AppConfig } from '@visor/bridge'
import { dataFolder, writeJsonAtomic } from '@visor/bridge/node'
import { quotePowerShell } from './windows'

export const hookEvents = ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'agentStop']

function quoteBash(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }

export function hookConfiguration({ nodePath, hookPath }: { nodePath: string; hookPath: string }) {
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

async function preserveOrWrite(path: string, value: unknown): Promise<void> {
  let existing: string | null = null
  try { existing = await readFile(path, 'utf8') } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  if (existing !== null) {
    const input: unknown = JSON.parse(existing)
    if (JSON.stringify(input) !== JSON.stringify(value)) {
      throw new Error(`Existing configuration differs. Refusing to overwrite ${path}.`)
    }
    return
  }
  await writeJsonAtomic(path, value)
}

export async function installHooks({ workspace, config, folder = dataFolder(), hookPath, nodePath = process.execPath }: {
  workspace: string
  config: AppConfig
  folder?: string
  hookPath: string
  nodePath?: string
}): Promise<string> {
  const validated = appConfigSchema.parse(config)
  if (![workspace, hookPath, nodePath, validated.appPath].every(isAbsolute)) {
    throw new Error('Workspace, launcher, Node, and hook paths must be absolute.')
  }
  const hookFile = join(workspace, '.github', 'hooks', 'visor.json')
  const hooks = hookConfiguration({ nodePath, hookPath })
  await preserveOrWrite(hookFile, hooks)
  await preserveOrWrite(join(folder, 'config.json'), validated)
  return hookFile
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    workspace: { type: 'string' },
    'app-path': { type: 'string' },
    'app-entry': { type: 'string' }
  } })
  if (!values.workspace) throw new Error('Provide --workspace <sandbox-folder>.')
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