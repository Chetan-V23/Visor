import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { loadSourceParsers, replay } from '@visor/core'
import { dataFolder } from '@visor/bridge/node'
import { openDatabase, SqliteChangeStore } from '@visor/store'
import { loadFrames } from './fixtures'

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'dump' && args[0] === '--session' && args[1]) {
    const path = join(dataFolder(), 'visor.db')
    await access(path)
    const database = openDatabase(path)
    try {
      const store = new SqliteChangeStore(database, [])
      process.stdout.write(`${JSON.stringify(store.listChanges(args[1]).reverse().map((change) => store.getChange(change.id)), null, 2)}\n`)
    } finally { database.close() }
    return
  }
  const target = args[0]
  if (command !== 'replay' || !target) throw new Error('Usage: pnpm visor replay <fixture-session> | pnpm visor dump --session <id>')
  const require = createRequire(import.meta.url)
  const registry = await loadSourceParsers((grammar) => require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`))
  try { process.stdout.write(`${JSON.stringify(replay(await loadFrames(resolve(target)), registry.extractors), null, 2)}\n`) }
  finally { registry.dispose() }
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Visor command failed.'}\n`)
  process.exitCode = 1
})