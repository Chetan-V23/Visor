import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readRuntime, writeJsonAtomic } from '../packages/bridge/src/node'
import type { RawHook } from '../packages/bridge/src/index'
import { hookConfiguration } from '../apps/hook/src/install'

let app: ElectronApplication
let page: Page
let rendererErrors: string[]
let dataFolder: string
let captureFolder: string

test.beforeEach(async () => {
  rendererErrors = []
  dataFolder = await mkdtemp(join(tmpdir(), 'visor-electron-'))
  captureFolder = join(dataFolder, 'captures')
  app = await electron.launch({
    args: [resolve('apps/desktop/out/main/index.js')],
    env: { ...process.env, VISOR_DATA_DIR: dataFolder, VISOR_CAPTURE_DIR: captureFolder }
  })
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
})

test.afterEach(async () => {
  await app?.close()
  expect(await readRuntime(dataFolder)).toBeNull()
  await rm(dataFolder, { recursive: true, force: true })
  expect(rendererErrors).toEqual([])
})

test('shows the Step 1 diagram and method signature on hover', async () => {
  await expect(page.getByRole('heading', { name: 'Refactor the checkout flow' })).toBeVisible()
  await expect(page.getByTestId('class-node')).toHaveCount(3)
  await expect(page.locator('.react-flow__edge')).toHaveCount(2)
  await expect(page.getByTestId('change-entry')).toHaveCount(4)
  await expect(page.getByTestId('change-entry').first()).toContainText('Change 4')
  await page.getByRole('button', { name: 'added add_item(self, item)', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toContainText('def add_item(self, item: Item) -> None')
  await expect(page.getByRole('tooltip')).toContainText('Add an item to the cart and update its total.')
  await page.mouse.move(5, 5)
  await expect(page.locator('.method-tooltip')).toHaveCount(0)
})

test('uses the requested colors and keeps the renderer isolated', async () => {
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(242, 212, 121)')
  await expect(page.locator('.diagram-panel')).toHaveCSS('background-color', 'rgb(217, 122, 43)')
  await expect(page.locator('.method-added').first()).toHaveCSS('color', 'rgb(111, 175, 79)')
  await expect(page.locator('.method-deleted').first()).toHaveCSS('color', 'rgb(196, 74, 58)')
  await expect(page.locator('.method-unchanged').first()).toHaveCSS('color', 'rgb(0, 0, 0)')
  await expect(page.locator('.method-unchanged').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect(await page.evaluate(() => 'require' in window)).toBe(false)
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents
    if (!contents || !('getLastWebPreferences' in contents) || typeof contents.getLastWebPreferences !== 'function') {
      throw new Error('Electron did not expose runtime web preferences for the security check.')
    }
    const result: unknown = contents.getLastWebPreferences()
    return result
  })
  expect(preferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false })
})

test('supports zoom controls, change selection, and Settings', async () => {
  const before = await page.getByRole('status', { name: 'Zoom level' }).textContent()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Zoom level' })).not.toHaveText(before ?? '')
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await page.getByTestId('change-entry').nth(2).click()
  await expect(page.getByTestId('change-entry').nth(2)).toHaveAttribute('aria-current', 'step')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('dialog')).toContainText('#C44A3A')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('fits desktop and narrow desktop windows without overflow', async () => {
  for (const [width, height] of [[1400, 900], [800, 650]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
    }, { width: width ?? 800, height: height ?? 650 })
    await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
    await expect(page.getByTestId('class-node')).toHaveCount(3)
    await expect.poll(() => page.evaluate(() => {
      const canvas = document.querySelector('.diagram-canvas')?.getBoundingClientRect()
      return canvas && [...document.querySelectorAll('.class-node')].every((node) => {
        const bounds = node.getBoundingClientRect()
        return bounds.left >= canvas.left && bounds.right <= canvas.right && bounds.top >= canvas.top && bounds.bottom <= canvas.bottom
      })
    })).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `test-results/visor-${width}.png`, fullPage: true })
  }
})

test('supports keyboard tooltips and the mobile renderer layout', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await expect(page.getByTestId('class-node')).toHaveCount(3)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const method = page.getByRole('button', { name: 'added add_item(self, item)', exact: true })
  await method.focus()
  await expect(page.locator('.method-tooltip')).toContainText('def add_item(self, item: Item) -> None')
  await page.keyboard.press('Escape')
  await expect(page.locator('.method-tooltip')).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.mouse.move(0, 0)
  await page.screenshot({ path: 'test-results/visor-mobile.png', fullPage: true })
})

test('receives raw hooks through the CLI and shows a sanitized dev capture', async () => {
  await expect.poll(() => readRuntime(dataFolder)).not.toBeNull()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Raw hook capture' }).check()
  const events = ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'agentStop']
  for (const event of events) {
    const input = JSON.stringify({ sessionId: 'sandbox-session-42', cwd: 'D:\\private\\sandbox', toolName: 'edit', token: 'must-not-capture' })
    const result = await new Promise<number | null>((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve('apps/hook/bin/visor-hook.cjs'), event], {
        env: { ...process.env, VISOR_DATA_DIR: dataFolder }, stdio: ['pipe', 'ignore', 'ignore']
      })
      child.once('error', reject)
      child.once('close', resolveResult)
      child.stdin.end(input)
    })
    expect(result).toBe(0)
  }
  await expect(page.getByTestId('raw-hook-entry')).toHaveCount(5)
  await expect(page.getByTestId('raw-hook-entry').locator('summary > span')).toHaveText(events)
  await expect.poll(async () => (await readdir(captureFolder)).length).toBe(5)
  const capture = await readFile(join(captureFolder, 'sessionStart-1.json'), 'utf8')
  expect(capture).not.toContain('must-not-capture')
  expect(capture).not.toContain('private')
  const snapshot = await page.evaluate(() => window.visorHooks?.getSnapshot())
  expect(snapshot).toMatchObject({ sessionId: 'sandbox-session-42', debugEnabled: true })
  expect(snapshot).not.toHaveProperty('token')
  await page.screenshot({ path: 'test-results/visor-hook-debug.png', fullPage: true })
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'sandbox-session-42', exact: true })).toBeVisible()
  await expect(page.getByTestId('class-node')).toHaveCount(3)
})

test('focuses the same window when a second app process starts', async () => {
  const runtime = await readRuntime(dataFolder)
  const executable = await app.evaluate(() => process.execPath)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
  const exitCode = await new Promise<number | null>((resolveResult, reject) => {
    const child = spawn(executable, [resolve('apps/desktop/out/main/index.js')], {
      env: { ...process.env, VISOR_DATA_DIR: dataFolder, VISOR_CAPTURE_DIR: captureFolder }, stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('close', resolveResult)
  })
  expect(exitCode).toBe(0)
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(false)
  expect(await readRuntime(dataFolder)).toEqual(runtime)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('cold PowerShell hook exits while its launched Electron app remains alive', async () => {
  test.skip(process.platform !== 'win32', 'The registered hook uses Windows PowerShell.')
  const coldFolder = await mkdtemp(join(tmpdir(), 'visor-cold-hook-'))
  const executable = await app.evaluate(() => process.execPath)
  await writeJsonAtomic(join(coldFolder, 'config.json'), {
    appPath: executable, appArgs: [resolve('apps/desktop/out/main/index.js')]
  })
  const hook = hookConfiguration({ nodePath: process.execPath, hookPath: resolve('apps/hook/bin/visor-hook.cjs') }).hooks.sessionStart?.[0]
  if (!hook) throw new Error('The installer did not create a sessionStart command.')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', hook.powershell], {
    env: { ...process.env, VISOR_DATA_DIR: coldFolder, VISOR_CAPTURE_DIR: join(coldFolder, 'captures'), VISOR_APP_PATH: undefined },
    stdio: 'pipe'
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const completion = new Promise<{ code: number | null; timedOut: boolean }>((resolveResult, reject) => {
    const deadline = setTimeout(() => resolveResult({ code: child.exitCode, timedOut: true }), 5000)
    child.once('error', (error) => { clearTimeout(deadline); reject(error) })
    child.once('close', (code) => { clearTimeout(deadline); resolveResult({ code, timedOut: false }) })
  })
  child.stdin.end('{"sessionId":"cold-hook-regression"}')
  try {
    const result = await completion
    expect({ ...result, stdout, stderr }).toEqual({ code: 0, timedOut: false, stdout: '{}\n', stderr: '' })
    const runtime = await readRuntime(coldFolder)
    expect(runtime).not.toBeNull()
    if (!runtime) throw new Error('The hook did not launch Electron.')
    process.kill(runtime.pid, 0)
  } finally {
    if (child.exitCode === null) child.kill()
    const runtime = await readRuntime(coldFolder)
    if (runtime) {
      try { process.kill(runtime.pid) } catch {}
    }
    await rm(coldFolder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('restores an existing window on SessionStart without another app launch', async () => {
  const runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('The test app did not publish its runtime.')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
  const raw: RawHook = { id: randomUUID(), source: 'copilot', event: 'SessionStart', receivedAt: Date.now(), payload: { session_id: 'second-session' } }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, {
    method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(raw)
  })
  expect(response.status).toBe(202)
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(false)
  await expect(page.getByRole('heading', { name: 'second-session', exact: true })).toBeVisible()
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})