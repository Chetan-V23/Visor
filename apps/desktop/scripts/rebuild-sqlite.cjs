const { execFileSync } = require('node:child_process')
const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const { dirname, join, resolve } = require('node:path')
const { rebuild } = require('@electron/rebuild')

async function main() {
  const root = resolve(__dirname, '../../..')
  const storeRequire = createRequire(join(root, 'packages/store/package.json'))
  const desktopRequire = createRequire(join(root, 'apps/desktop/package.json'))
  const packageRoot = dirname(storeRequire.resolve('better-sqlite3/package.json'))
  const electronPath = desktopRequire('electron')
  const electronVersion = desktopRequire('electron/package.json').version
  const abi = execFileSync(electronPath, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8'
  }).trim()
  const target = join(packageRoot, `build/visor-electron-${abi}`)
  const stamp = join(target, 'runtime.json')
  const identity = JSON.stringify({ electronVersion, node: process.versions.modules, platform: process.platform, arch: process.arch })
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === identity && existsSync(join(target, 'better_sqlite3.node'))) {
    process.stdout.write('SQLite Node and Electron bindings are ready.\n')
    return
  }
  const binding = join(packageRoot, 'build/Release/better_sqlite3.node')
  const backup = join(packageRoot, 'build/visor-node/better_sqlite3.node')
  mkdirSync(dirname(backup), { recursive: true })
  copyFileSync(binding, backup)
  try {
    await rebuild({ buildPath: join(root, 'packages/store'), electronVersion, onlyModules: ['better-sqlite3'], force: true })
    mkdirSync(target, { recursive: true })
    copyFileSync(binding, join(target, 'better_sqlite3.node'))
    writeFileSync(stamp, identity)
  } finally { copyFileSync(backup, binding) }
  process.stdout.write(`Prepared SQLite for Electron ${electronVersion}; restored the Node binding.\n`)
}
void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'SQLite rebuild failed.'}\n`)
  process.exitCode = 1
})