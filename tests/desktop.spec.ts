import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readRuntime, writeJsonAtomic } from '../packages/bridge/src/node'
import { rawHookSchema, type RawHook } from '../packages/bridge/src/index'
import { visorEventSchema } from '../packages/protocol/src/index'
import { openDatabase, SqliteChangeStore } from '../packages/store/src/index'
import { hookConfiguration } from '../apps/hook/src/install'
import { seedHistory } from '../apps/cli/src/seed-history'
import { contentHash, createChange } from '../packages/core/src/index'

let app: ElectronApplication
let page: Page
let rendererErrors: string[]
let dataFolder: string
let captureFolder: string

test('persists captured NIfTI edits and a follow-up body edit across restarting Electron', async () => {
  const workspace = join(dataFolder, 'workspace')
  await mkdir(workspace)
  const before = await readFile(resolve('fixtures/python/nifti-before.py'), 'utf8')
  const after = await readFile(resolve('fixtures/python/nifti-after.py'), 'utf8')
  await writeFile(join(workspace, 'image_compare.py'), before)
  await expect.poll(async () => await readRuntime(dataFolder)).not.toBeNull()
  let runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('Runtime was not published.')
  const send = async (raw: RawHook) => {
    if (!runtime) throw new Error('No runtime.')
    const response = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(raw) })
    expect(response.status).toBe(202)
  }
  const database = openDatabase(join(dataFolder, 'visor.db'))
  const store = new SqliteChangeStore(database, [])
  const loadCapture = async (file: string): Promise<RawHook> => {
    const raw = rawHookSchema.parse(JSON.parse(await readFile(resolve('fixtures/raw-hooks', file), 'utf8')))
    const input = raw.payload.tool_input
    if (typeof input !== 'object' || input === null || Array.isArray(input) || typeof input.input !== 'string') throw new Error('Captured patch changed shape.')
    return { ...raw, payload: { ...raw.payload, cwd: workspace, tool_input: { ...input, input: input.input.replace('<workspace>\\image_compare.py', join(workspace, 'image_compare.py')) } } }
  }
  const pre = await loadCapture('preToolUse-4.json')
  const post = await loadCapture('postToolUse-3.json')
  const sessionId = String(post.payload.session_id)
  try {
    await send(pre)
    await expect.poll(() => store.listChanges(sessionId).length).toBe(1)
    await expect(page.getByTestId('class-node')).toHaveCount(2)
    await expect(page.locator('.method-edited-dot')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1 })).not.toContainText(sessionId)
    await send({ id: randomUUID(), source: 'copilot', event: 'userPromptSubmitted', receivedAt: Date.now(), payload: { cwd: workspace, session_id: sessionId, prompt: 'Compare the sandbox images\nContinue testing' } })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compare the sandbox images Continue testing')
    await writeFile(join(workspace, 'image_compare.py'), after)
    await send(post)
    await send(post)
    await expect.poll(() => store.listChanges(sessionId).map((change) => change.seq)).toEqual([1, 0])
    await expect(page.getByTestId('class-node')).toHaveCount(2)
    await expect(page.getByRole('heading', { name: 'NpyImage', exact: true })).toHaveCount(0)
    await expectDiagramFramed()
    await expect.poll(() => page.evaluate(() => {
      const nodes = [...document.querySelectorAll('.class-node')].map((node) => node.getBoundingClientRect())
      return nodes.every((node, index) => nodes.slice(index + 1).every((other) => node.right <= other.left || other.right <= node.left || node.bottom <= other.top || other.bottom <= node.top))
    })).toBe(true)
    await page.screenshot({ path: 'test-results/visor-live-nifti.png', fullPage: true })
    await expect(page.getByTestId('change-entry').first()).toHaveAttribute('aria-current', 'step')
    await page.getByTestId('change-entry').last().click()
    await expect(page.getByRole('switch', { name: 'Live' })).not.toBeChecked()
    await expect(page.getByTestId('class-node')).toHaveCount(2)
    await expect(page.locator('.method-edited-dot')).toHaveCount(0)
    expect(store.latestChange(sessionId)?.model.classes.map((symbol) => symbol.name)).toEqual(['NpyImage', 'NiftiImage', 'Main'])
    const followUp: RawHook = { id: randomUUID(), source: 'copilot', event: 'preToolUse', receivedAt: Date.now(), payload: { cwd: workspace, session_id: sessionId, tool_name: 'edit_file', tool_use_id: 'test-follow-up', tool_input: { filePath: 'image_compare.py' } } }
    await send(followUp)
    await expect.poll(() => store.pendingFiles(sessionId, 'test-follow-up').length).toBe(1)
    const modified = after.replace(/(        self\.compare)\(\)(\r?\n)/, '$1_nifti()$2        return None$2')
    expect(modified).not.toBe(after)
    await writeFile(join(workspace, 'image_compare.py'), modified)
    await send({ ...followUp, id: randomUUID(), event: 'postToolUse' })
    await expect.poll(() => store.listChanges(sessionId).map((change) => change.seq)).toEqual([2, 1, 0])
    await expect(page.getByTestId('class-node')).toHaveCount(2)
    await expect(page.getByTestId('change-entry').last()).toHaveAttribute('aria-current', 'step')
    await page.getByRole('switch', { name: 'Live' }).check()
    await expect(page.getByTestId('class-node')).toHaveCount(1)
    await expect(page.getByTestId('class-node').filter({ has: page.getByRole('heading', { name: 'Main', exact: true }) })).toHaveAttribute('data-change', 'modified')
    expect(store.latestChange(sessionId)?.change.delta).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'member.change', after: expect.objectContaining({ name: 'run' }) })]))
    const main = page.getByTestId('class-node').filter({ has: page.getByRole('heading', { name: 'Main', exact: true }) })
    const run = main.getByRole('button', { name: 'edited run', exact: true })
    await expect(run.locator('.method-edited-dot')).toBeVisible()
    await expect(run.locator('.method-edited-dot')).toHaveCSS('background-color', 'rgb(242, 212, 121)')
    await expect(main.getByRole('button', { name: 'unchanged __init__', exact: true }).locator('.method-edited-dot')).toHaveCount(0)
    await expect(main.locator('.method-edited-dot')).toHaveCount(1)
    await page.evaluate(() => document.fonts.ready)
    await page.mouse.move(0, 0)
    await page.screenshot({ path: 'test-results/visor-method-edited-desktop.png', fullPage: true })
    await run.hover()
    const tooltip = page.locator('.method-tooltip')
    await expect(tooltip).toContainText('def run(self) -> None:')
    await expect(tooltip.locator('.code-deleted')).toContainText('self.compare()')
    await expect(tooltip.locator('.code-added').first()).toContainText('self.compare_nifti()')
    await expect(tooltip.locator('.code-added').last()).toContainText('return None')
    await expect(tooltip.locator('.code-deleted').first()).toHaveCSS('color', 'rgb(196, 74, 58)')
    await expect(tooltip.locator('.code-added').first()).toHaveCSS('color', 'rgb(111, 175, 79)')
    await expect(tooltip.locator('.code-unchanged').first()).toHaveCSS('color', 'rgb(0, 0, 0)')
    expect(await tooltip.locator('.code-line').evaluateAll((lines) => lines.every((line, index) => index === 0 || line.getBoundingClientRect().top >= (lines[index - 1]?.getBoundingClientRect().bottom ?? 0) - 1))).toBe(true)
    await tooltip.hover()
    await expect(tooltip).toBeVisible()
    await page.screenshot({ path: 'test-results/visor-method-code-desktop.png', fullPage: true })
    await tooltip.focus()
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await page.mouse.move(0, 0)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
    await page.mouse.move(0, 0)
    await main.getByRole('button', { name: 'unchanged __init__', exact: true }).focus()
    await expect(tooltip).toContainText('self.image_a')
    await expect.poll(() => tooltip.evaluate((panel) => { const bounds = panel.getBoundingClientRect(); return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight })).toBe(true)
    await page.screenshot({ path: 'test-results/visor-method-code-mobile.png', fullPage: true })
    await page.keyboard.press('Escape')
    await expect(tooltip).toHaveCount(0)
    await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
    await page.mouse.move(0, 0)
    await expect(run.locator('.method-edited-dot')).toBeVisible()
    await page.screenshot({ path: 'test-results/visor-method-edited-mobile.png', fullPage: true })
    await page.setViewportSize({ width: 1400, height: 900 })
    const expected = store.listChanges(sessionId)
    await app.close()
    app = await electron.launch({ args: [resolve('apps/desktop/out/main/index.js')], env: { ...process.env, VISOR_DATA_DIR: dataFolder, VISOR_CAPTURE_DIR: captureFolder } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await expect.poll(async () => await readRuntime(dataFolder)).not.toBeNull()
    runtime = await readRuntime(dataFolder)
    expect(store.listChanges(sessionId)).toEqual(expected)
    await send(post)
    await expect.poll(() => store.listChanges(sessionId).length).toBe(3)
    await expect(page.getByRole('button', { name: 'edited run', exact: true }).locator('.method-edited-dot')).toBeVisible()
    expect(database.prepare('SELECT COUNT(*) AS count FROM change_files').get()).toEqual({ count: 3 })
    expect(await page.evaluate(async (id) => window.visorHistory?.listChanges(id), sessionId)).toEqual(expected)
    const newest = expected[0]
    if (!newest) throw new Error('No saved change.')
    expect(await page.evaluate(async (id) => window.visorHistory?.getChange(id), newest.id)).toEqual(store.getChange(newest.id))
    const baseline = expected.at(-1)
    if (!baseline) throw new Error('No baseline.')
    const historicalCode = await page.evaluate((changeId) => window.visorHistory?.getMethodCode({ changeId, methodId: 'py:image_compare.py::Main.run' }), baseline.id)
    expect(historicalCode?.lines).toEqual([
      { kind: 'unchanged', text: '    def run(self) -> None:' },
      { kind: 'unchanged', text: '        self.compare()' }
    ])
    expect(await page.evaluate((changeId) => window.visorHistory?.getMethodCode({ changeId, methodId: 'py:image_compare.py::DoesNotExist.run' }), newest.id)).toBeNull()
    expect(await page.evaluate(async () => window.visorHistory?.listSessions())).toEqual(store.listSessions())
    const dump = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/cli/src/index.ts'), 'dump', '--session', sessionId], { env: { ...process.env, VISOR_DATA_DIR: dataFolder }, windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString() })
      child.on('error', reject)
      child.on('close', (code) => { if (code === 0) resolveOutput(stdout); else reject(new Error(stderr || 'Dump CLI failed.')) })
    })
    expect(JSON.parse(dump)).toEqual([...expected].reverse().map((change) => store.getChange(change.id)))
  } finally { database.close() }
})

test('ignores documentation-only edits and hides legacy entries after restarting Electron', async () => {
  const workspace = join(dataFolder, 'documentation-workspace')
  await mkdir(workspace)
  const before = 'class A:\n    def run(self):\n        return 1\n'
  await writeFile(join(workspace, 'a.py'), before)
  await writeFile(join(workspace, 'a.diagram.md'), 'run(self)\n')
  await expect.poll(() => readRuntime(dataFolder)).not.toBeNull()
  const runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('Missing runtime.')
  const sessionId = 'documentation-history'
  const raw = (event: string, payload: RawHook['payload'] = {}): RawHook => ({ id: randomUUID(), source: 'copilot', event, receivedAt: Date.now(), payload: { cwd: workspace, session_id: sessionId, ...payload } })
  const send = async (event: RawHook) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) })
    expect(response.status).toBe(202)
  }
  const database = openDatabase(join(dataFolder, 'visor.db'))
  const store = new SqliteChangeStore(database, [])
  try {
    await send(raw('sessionStart'))
    await expect(page.getByTestId('change-entry')).toHaveCount(1)
    await expect(page.locator('.change-count')).toHaveText('0')
    await expect(page.locator('.session-meta')).toContainText('0 changes')
    await expect(page.locator('.session-footer')).not.toContainText('Change 0')
    expect(store.sourceAtChange(sessionId, 0, 'a.py')).toBe(before)
    const codeInput = { tool_name: 'edit_file', tool_use_id: 'code-edit', tool_input: { filePath: 'a.py' } }
    await send(raw('preToolUse', codeInput))
    await expect.poll(() => store.pendingFiles(sessionId, 'code-edit').length).toBe(1)
    await writeFile(join(workspace, 'a.py'), before.replace('return 1', 'return 2'))
    await send(raw('postToolUse', codeInput))
    await expect(page.getByTestId('change-entry')).toHaveCount(2)
    await expect(page.locator('.change-count')).toHaveText('1')
    await expect(page.locator('.session-meta')).toContainText('1 change')
    await expect(page.getByTestId('change-entry').locator('.change-topline > span')).toHaveText(['Change 1', 'Baseline'])
    await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
    expect(store.sourceAtChange(sessionId, 1, 'a.py')).toBe(before.replace('return 1', 'return 2'))
    await page.getByTestId('change-entry').last().click()
    await expect(page.getByTestId('class-node')).toHaveAttribute('data-change', 'unchanged')
    await expect(page.locator('.session-footer')).not.toContainText('Change 0')
    await expect(page.locator('.session-footer')).toContainText('Baseline')
    await page.getByTestId('change-entry').first().click()
    await expect(page.getByRole('switch', { name: 'Live' })).toBeChecked()
    await expect(page.locator('.session-footer')).toContainText('Change 1')
    const code = store.latestChange(sessionId)
    const session = store.listSessions()[0]
    if (!code || !session) throw new Error('Missing code history.')
    const documentationInput = { tool_name: 'apply_patch', tool_use_id: 'documentation-edit', tool_input: { input: '*** Begin Patch\n*** Update File: a.diagram.md\n@@\n-run(self)\n+run(self, value)\n*** End Patch' } }
    await send(raw('preToolUse', documentationInput))
    await expect.poll(() => store.pendingFiles(sessionId, 'documentation-edit').length).toBe(1)
    await writeFile(join(workspace, 'a.diagram.md'), 'run(self, value)\n')
    const post = raw('postToolUse', documentationInput)
    await send(post)
    await expect.poll(() => store.hasEvent(post.id)).toBe(true)
    expect(store.listChanges(sessionId).map((change) => change.seq)).toEqual([1, 0])
    await expect(page.getByTestId('change-entry')).toHaveCount(2)
    await expect(page.getByTestId('change-entry').first()).toHaveAttribute('aria-current', 'step')
    const event = visorEventSchema.parse({
      v: 1, id: randomUUID(), sessionId, seq: store.nextEventSequence(sessionId), ts: Date.now(), source: 'copilot', kind: 'edit.applied',
      payload: { tool: 'apply_patch', files: ['a.diagram.md'], intent: 'edit', outcome: 'succeeded' }
    })
    if (event.kind !== 'edit.applied') throw new Error('Expected legacy edit.')
    const text = 'run(self, value, extra)\n'
    const legacy = createChange(event, store.nextChangeSequence(sessionId), code.model, code.model, [{ path: 'a.diagram.md', before: 'run(self, value)\n', after: text }])
    store.commit(event, { id: session.project.id, root: workspace, name: session.project.name, branch: '' }, {
      change: { change: legacy, model: code.model }, snapshots: [{ path: 'a.diagram.md', text }]
    })
    expect(store.listChanges(sessionId).map((change) => change.seq)).toEqual([2, 1, 0])
    await app.close()
    app = await electron.launch({ args: [resolve('apps/desktop/out/main/index.js')], env: { ...process.env, VISOR_DATA_DIR: dataFolder, VISOR_CAPTURE_DIR: captureFolder } })
    page = await app.firstWindow()
    page.on('pageerror', (error) => rendererErrors.push(error.message))
    await expect(page.getByTestId('change-entry')).toHaveCount(2)
    await expect(page.locator('.change-count')).toHaveText('1')
    await expect(page.getByTestId('change-entry').first()).toHaveAttribute('aria-current', 'step')
    await expect(page.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
    await expect(page.getByText('No classes', { exact: true })).toHaveCount(0)
    const visible = await page.evaluate((id) => window.visorHistory?.listChanges(id), sessionId)
    expect(visible?.map((change) => change.id)).toEqual([code.change.id, store.listChanges(sessionId).at(-1)?.id])
    expect(store.getChange(legacy.id)?.change).toEqual(legacy)
    await page.screenshot({ path: 'test-results/visor-code-only-history.png', fullPage: true })
  } finally { database.close() }
})

test('localizes a multi-file patch to touched classes in a larger workspace', async () => {
  const workspace = join(dataFolder, 'larger-workspace')
  await mkdir(join(workspace, 'Constants'), { recursive: true })
  await mkdir(join(workspace, 'UIControls', 'Views'), { recursive: true })
  await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(workspace, `unrelated_${index}.py`), `class Unrelated${index}:\n    pass\n\nclass Other${index}:\n    pass\n`)))
  const headerPath = join(workspace, 'UIControls', 'Views', 'CMBDHeaderView.py')
  const bootstrapPath = join(workspace, 'CMBDStandaloneBootstrapper.py')
  const constantsPath = join(workspace, 'Constants', 'CMBDUserMessageConstants.py')
  const header = 'class CMBDHeaderView:\n    def __init__(self):\n        self.show_message_button = None\n\nclass UntouchedHeaderHelper:\n    pass\n'
  const bootstrap = 'from UIControls.Views.CMBDHeaderView import CMBDHeaderView\n\nclass CMBDStandaloneBootstrapper:\n    def __init__(self):\n        self.header = CMBDHeaderView()\n    def connect_buttons(self):\n        pass\n\nclass UntouchedBootstrapHelper:\n    pass\n'
  await Promise.all([writeFile(headerPath, header), writeFile(bootstrapPath, bootstrap), writeFile(constantsPath, 'EXISTING_TEXT = "Existing"\n')])
  await expect.poll(() => readRuntime(dataFolder)).not.toBeNull()
  const runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('Missing runtime.')
  const patch = `*** Begin Patch\n*** Update File: ${constantsPath}\n@@\n+SHOW_MESSAGE_BUTTON_TEXT = "Show Message"\n*** Update File: ${headerPath}\n@@\n-        self.show_message_button = None\n+        self.show_message_button = QPushButton()\n*** Update File: ${bootstrapPath}\n@@\n-        pass\n+        self.header.show_message_button.clicked.connect(self.__show_message)\n+    def __show_message(self):\n+        return "Button Pressed"\n*** End Patch`
  const hook: RawHook = { id: randomUUID(), source: 'copilot', event: 'preToolUse', receivedAt: Date.now(), payload: { cwd: workspace, session_id: 'localized-patch', tool_name: 'apply_patch', tool_use_id: 'localized-edit', tool_input: { input: patch, explanation: 'Add the standalone message button.' } } }
  const send = async (event: RawHook) => fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) })
  expect((await send(hook)).status).toBe(202)
  await expect(page.getByTestId('class-node')).toHaveCount(84)
  const changedHeader = header.replace('self.show_message_button = None', 'self.show_message_button = QPushButton()')
  const changedBootstrap = bootstrap.replace('        pass\n', '        self.header.show_message_button.clicked.connect(self.__show_message)\n    def __show_message(self):\n        return "Button Pressed"\n')
  await Promise.all([writeFile(headerPath, changedHeader), writeFile(bootstrapPath, changedBootstrap), writeFile(constantsPath, 'EXISTING_TEXT = "Existing"\nSHOW_MESSAGE_BUTTON_TEXT = "Show Message"\n')])
  expect((await send({ ...hook, id: randomUUID(), event: 'postToolUse' })).status).toBe(202)
  await expect(page.getByTestId('change-entry')).toHaveCount(2)
  await expect(page.getByTestId('class-node')).toHaveCount(2)
  await expect(page.getByTestId('class-node').locator('h2')).toHaveText(['CMBDStandaloneBootstrapper', 'CMBDHeaderView'])
  await expect(page.locator('.relation-label')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'UntouchedHeaderHelper', exact: true })).toHaveCount(0)
  const stored = await page.evaluate(async () => {
    const newest = (await window.visorHistory?.listChanges('localized-patch'))?.[0]
    return newest ? window.visorHistory?.getChange(newest.id) : null
  })
  expect(stored?.model.classes).toHaveLength(84)
  expect(stored?.change.files.map((file) => file.path).sort()).toEqual(['CMBDStandaloneBootstrapper.py', 'Constants/CMBDUserMessageConstants.py', 'UIControls/Views/CMBDHeaderView.py'])
  await expectDiagramFramed()
  await page.screenshot({ path: 'test-results/visor-localized-edit-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await expectDiagramFramed()
  await page.screenshot({ path: 'test-results/visor-localized-edit-mobile.png', fullPage: true })
})

test('includes all project classes mentioned in a replacement call without showing the whole workspace', async () => {
  const workspace = join(dataFolder, 'mentioned-workspace')
  await mkdir(workspace)
  await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(workspace, `unrelated_${index}.py`), `class Unrelated${index}:\n    pass\n\nclass Other${index}:\n    pass\n`)))
  const before = 'from pathlib import Path\nimport numpy as np\n\nclass JpegLossless:\n    def __init__(self, path):\n        self.path = path\n        self.data = None\n\nclass JpegImageFlipper:\n    def __init__(self, first: JpegLossless, second: JpegLossless):\n        self.first = first\n        self.second = second\n    def display(self):\n        pass\n\nclass Main:\n    IMAGE_A_PATH = "a.jpg"\n    def __init__(self):\n        self.jpeg_lossless_a = JpegLossless(self.IMAGE_A_PATH)\n        self.jpeg_lossless_b = JpegLossless("b.jpg")\n    def run(self):\n        JpegImageFlipper(self.jpeg_lossless_a, self.jpeg_lossless_b).display()\n\nclass UnmentionedHelper:\n    pass\n'
  const replacements = [
    { filePath: 'image_compare.py', oldString: 'class Main:\n    IMAGE_A_PATH', newString: 'class Flipper(JpegLossless):\n    def __init__(self, path: str | Path):\n        super().__init__(path)\n        self.flipped_data: np.ndarray = np.rot90(self.data, 3).copy()\n\n\nclass Main:\n    IMAGE_A_PATH' },
    { filePath: 'image_compare.py', oldString: '        JpegImageFlipper(self.jpeg_lossless_a, self.jpeg_lossless_b).display()\n', newString: '        JpegImageFlipper(self.jpeg_lossless_a, self.jpeg_lossless_b).display()\n        self.flippers = (Flipper(self.jpeg_lossless_a.path), Flipper(self.jpeg_lossless_b.path))\n' }
  ]
  await writeFile(join(workspace, 'image_compare.py'), before)
  await expect.poll(() => readRuntime(dataFolder)).not.toBeNull()
  const runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('Missing runtime.')
  const hook: RawHook = { id: randomUUID(), source: 'copilot', event: 'PreToolUse', receivedAt: Date.now(), payload: { cwd: workspace, session_id: 'mentioned-classes', tool_name: 'multi_replace_string_in_file', tool_use_id: 'flipper-edit', tool_input: { explanation: 'Add Flipper class and call it after JpegImageFlipper.', replacements } } }
  const send = async (event: RawHook) => fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) })
  expect((await send(hook)).status).toBe(202)
  await expect(page.getByTestId('class-node')).toHaveCount(84)
  const after = replacements.reduce((source, replacement) => source.replace(replacement.oldString, replacement.newString), before)
  expect(after).not.toBe(before)
  await writeFile(join(workspace, 'image_compare.py'), after)
  expect((await send({ ...hook, id: randomUUID(), event: 'PostToolUse' })).status).toBe(202)
  await expect(page.getByTestId('change-entry')).toHaveCount(2)
  await expect(page.getByTestId('class-node')).toHaveCount(4)
  await expect(page.getByTestId('class-node').locator('h2')).toHaveText(['JpegLossless', 'JpegImageFlipper', 'Flipper', 'Main'])
  const node = (name: string) => page.getByTestId('class-node').filter({ has: page.getByRole('heading', { name, exact: true }) })
  await expect(node('JpegLossless')).toHaveAttribute('data-change', 'unchanged')
  await expect(node('JpegImageFlipper')).toHaveAttribute('data-change', 'unchanged')
  await expect(node('Flipper')).toHaveAttribute('data-change', 'added')
  await expect(node('Main')).toHaveAttribute('data-change', 'modified')
  const inheritance = page.locator('.react-flow__edge[data-id^="inherits:py:image_compare.py::Flipper->py:image_compare.py::JpegLossless:"]')
  await expect(inheritance).toHaveCount(1)
  expect(await inheritance.locator('.react-flow__edge-path').evaluate((path) => {
    const id = path.getAttribute('marker-end')?.match(/^url\(['"]?#([^'")]+)['"]?\)$/)?.[1]
    return id ? document.getElementById(id)?.tagName : null
  })).toBe('marker')
  await expect(page.getByRole('heading', { name: 'UnmentionedHelper', exact: true })).toHaveCount(0)
  const stored = await page.evaluate(async () => {
    const latest = (await window.visorHistory?.listChanges('mentioned-classes'))?.[0]
    return latest ? window.visorHistory?.getChange(latest.id) : null
  })
  expect(stored?.model.classes).toHaveLength(85)
  expect(stored?.change.cause).toMatchObject({ mentionedClasses: expect.arrayContaining(['Flipper', 'JpegImageFlipper', 'JpegLossless', 'Main'].map((name) => `py:image_compare.py::${name}`)) })
  await expectDiagramFramed()
  await page.mouse.move(0, 0)
  await page.screenshot({ path: 'test-results/visor-mentioned-classes-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await page.mouse.move(0, 0)
  await expectDiagramFramed()
  await page.screenshot({ path: 'test-results/visor-mentioned-classes-mobile.png', fullPage: true })
})

test('shows source-backed ownership and signals and enriches only matching historical versions', async () => {
  const workspace = join(dataFolder, 'workspace')
  await mkdir(workspace)
  const source = 'class Base:\n    pass\n\nclass Viewer(Base):\n    def refresh(self):\n        pass\n    def clear(self):\n        pass\n\nclass Loader:\n    completed = Signal()\n\nclass Image:\n    pass\n\nclass Main:\n    def __init__(self, path, viewer: Viewer, viewers: list[Viewer]):\n        self.loader = Loader(path) if path else None\n        self.viewer = viewer\n        self.viewers = viewers\n        self.image_a = Image()\n        self.image_b = Image()\n        self.external = build_viewer()\n        self.loader.completed.connect(self.viewer.refresh)\n'
  await writeFile(join(workspace, 'main.py'), source)
  await expect.poll(async () => readRuntime(dataFolder)).not.toBeNull()
  const runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('Missing runtime.')
  const headers = { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }
  const endpoint = `http://127.0.0.1:${runtime.port}`
  const send = async (path: string, body: unknown) => fetch(`${endpoint}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const hook: RawHook = { id: randomUUID(), source: 'copilot', event: 'preToolUse', receivedAt: Date.now(), payload: { cwd: workspace, session_id: 'relations', tool_name: 'edit_file', tool_use_id: 'relations-edit', tool_input: { filePath: 'main.py' } } }
  expect((await send('/hooks/raw', hook)).status).toBe(202)
  await expect(page.getByTestId('class-node')).toHaveCount(5)
  await expect(page.locator('.relation-label')).toHaveCount(6)
  await expect(page.locator('.relation-label').filter({ hasText: 'Composition: image_a / image_b' })).toHaveCount(1)
  await expect(page.locator('.relation-label').filter({ hasText: 'Aggregation: viewers' })).toHaveCount(1)
  await expect(page.locator('.relation-label').filter({ hasText: 'Association: viewer' })).toHaveCount(1)
  const signal = page.locator('.relation-label').filter({ hasText: 'Signal/Event: completed -> refresh' })
  await expect(signal).toHaveAttribute('title', /main.py:.*Explicit signal\/event subscription/)
  await signal.focus()
  await expect(signal).toBeFocused()
  expect(await page.locator('.react-flow__edge-path').evaluateAll((paths) => paths.filter((path) => path.getAttribute('marker-start')).length)).toBe(3)
  expect(await page.locator('.react-flow__edge-path').evaluateAll((paths) => paths.filter((path) => path.getAttribute('marker-start')).map((path) => {
    const reference = path.getAttribute('marker-start') ?? ''
    const markerId = reference.match(/^url\(['"]?#([^'")]+)['"]?\)$/)?.[1]
    return markerId ? document.getElementById(markerId)?.tagName ?? reference : reference
  }))).toEqual(['marker', 'marker', 'marker'])
  expect(await page.locator('.react-flow__edge-path').evaluateAll((paths) => paths.filter((path) => path.getAttribute('marker-start')).every((path) => {
    const svgPath = path as SVGPathElement
    const matrix = svgPath.getScreenCTM()
    if (!matrix) return false
    const point = svgPath.getPointAtLength(0).matrixTransform(matrix)
    return [...document.querySelectorAll('[data-testid="class-node"]')].every((node) => { const bounds = node.getBoundingClientRect(); return point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom })
  }))).toBe(true)
  expect(await page.locator('.react-flow__edge-path').evaluateAll((paths) => paths.some((path) => path.getAttribute('style')?.includes('stroke-dasharray: 6, 4') || path.getAttribute('style')?.includes('stroke-dasharray: 6 4')))).toBe(true)
  await expectDiagramFramed()
  expect(await page.locator('.relation-label').evaluateAll((labels) => labels.every((label, index) => labels.slice(index + 1).every((other) => { const first = label.getBoundingClientRect(); const second = other.getBoundingClientRect(); return first.right <= second.left || second.right <= first.left || first.bottom <= second.top || second.bottom <= first.top })))).toBe(true)
  expect(await page.locator('.relation-label').evaluateAll((labels) => labels.every((label) => [...document.querySelectorAll('[data-testid="class-node"]')].every((node) => { const first = label.getBoundingClientRect(); const second = node.getBoundingClientRect(); return first.right <= second.left || second.right <= first.left || first.bottom <= second.top || second.bottom <= first.top })))).toBe(true)
  await page.screenshot({ path: 'test-results/visor-ownership-signals-desktop.png', fullPage: true })
  const query = { v: 1, workspaceRoot: workspace, file: 'main.py', hash: contentHash(source) }
  expect((await send('/semantic/queries', { ...query, hash: 'a'.repeat(64) })).status).toBe(409)
  const response = await send('/semantic/queries', query)
  expect(response.status).toBe(200)
  const requests: { positions: { line: number; column: number }[] } = await response.json()
  const referenceLine = source.split('\n').findIndex((line) => line.includes('self.external =')) + 1
  expect(requests.positions).toContainEqual({ line: referenceLine, column: 13 })
  const targetLine = source.split('\n').findIndex((line) => line.startsWith('class Viewer')) + 1
  const facts = { ...query, provider: 'electron-contract-test', definitions: [{ position: { line: referenceLine, column: 13 }, targets: [{ file: 'main.py', hash: query.hash, range: { start: { line: targetLine, column: 6 }, end: { line: targetLine, column: 12 } } }] }] }
  expect((await send('/semantic', { ...facts, hash: 'b'.repeat(64) })).status).toBe(409)
  expect((await send('/semantic', facts)).status).toBe(202)
  await expect(page.locator('.relation-label').filter({ hasText: 'Association: external / viewer' })).toHaveCount(1)
  const changed = source.replace('completed.connect(self.viewer.refresh)', 'completed.connect(self.viewer.clear)')
  await writeFile(join(workspace, 'main.py'), changed)
  expect((await send('/hooks/raw', { ...hook, id: randomUUID(), event: 'postToolUse' })).status).toBe(202)
  await expect(page.getByTestId('change-entry')).toHaveCount(2)
  await expect(page.getByTestId('class-node')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'Main', exact: true })).toBeVisible()
  await expect(page.getByTestId('class-node').filter({ has: page.getByRole('heading', { name: 'Viewer', exact: true }) })).toHaveAttribute('data-change', 'unchanged')
  await expect(page.locator('.relation-label')).toHaveCount(3)
  await expect(page.getByRole('heading', { name: 'Base', exact: true })).toHaveCount(0)
  const currentLabels = await page.evaluate(async () => {
    const latest = (await window.visorHistory?.listChanges('relations'))?.[0]
    return latest ? (await window.visorHistory?.getChange(latest.id))?.model.relations.map((relation) => relation.label) : undefined
  })
  expect(currentLabels).not.toContain('external / viewer')
  expect(currentLabels).toContain('viewer')
  expect(currentLabels).toContain('completed -> clear')
  expect(currentLabels).not.toContain('completed -> refresh')
  await page.getByTestId('change-entry').last().click()
  await expect(page.locator('.relation-label').filter({ hasText: 'Association: external / viewer' })).toHaveCount(1)
  await expect(page.locator('.relation-label').filter({ hasText: 'Signal/Event: completed -> clear' })).toHaveCount(0)
  await page.mouse.move(0, 0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await expectDiagramFramed()
  await page.screenshot({ path: 'test-results/visor-ownership-signals-mobile.png', fullPage: true })
})

test('opens an actual native SQLite database in Electron and reads it with Node', async () => {
  await expect.poll(async () => await readRuntime(dataFolder)).not.toBeNull()
  const file = join(dataFolder, 'visor.db')
  expect((await readFile(file)).subarray(0, 16).toString()).toBe('SQLite format 3\u0000')
  const database = openDatabase(file)
  try { expect(database.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]) }
  finally { database.close() }
})

test('normalizes an actual captured patch in the running app and ignores a resend', async () => {
  const workspace = join(dataFolder, 'workspace')
  await mkdir(workspace)
  const capture = rawHookSchema.parse(JSON.parse(await readFile(resolve('fixtures/raw-hooks/postToolUse-3.json'), 'utf8')))
  const input = capture.payload.tool_input
  if (typeof input !== 'object' || input === null || Array.isArray(input) || typeof input.input !== 'string') throw new Error('The real patch input changed shape.')
  const raw: RawHook = { ...capture, payload: { ...capture.payload, cwd: workspace, tool_input: { ...input, input: input.input.replace('<workspace>\\image_compare.py', join(workspace, 'image_compare.py')) } } }
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Raw hook capture' }).check()
  await expect.poll(async () => await readRuntime(dataFolder)).not.toBeNull()
  const runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('Runtime was not published.')
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(raw) })
    expect(response.status).toBe(202)
  }
  await expect(page.getByTestId('normalized-hook-entry')).toHaveCount(1)
  await expect(page.getByTestId('normalized-hook-entry')).toContainText('edit.applied')
  const normalized = await page.evaluate(async () => (await window.visorHooks?.getSnapshot())?.normalizedEvents)
  expect(visorEventSchema.array().safeParse(normalized).success).toBe(true)
  expect(normalized?.[0]?.payload).toMatchObject({ files: ['image_compare.py'], outcome: 'unknown' })
})

test.beforeEach(async ({}, info) => {
  rendererErrors = []
  dataFolder = await mkdtemp(join(tmpdir(), 'visor-electron-'))
  captureFolder = join(dataFolder, 'captures')
  if (/Step 1 diagram|requested colors|zoom controls|fits desktop|keyboard tooltips|stored history/.test(info.title)) {
    const require = createRequire(resolve('apps/desktop/package.json'))
    const migrations = await Promise.all(['001_initial', '002_indexes', '003_semantic'].map(async (name, index) => ({ version: index + 1, sql: await readFile(require.resolve(`@visor/store/migrations/${name}.sql`), 'utf8') })))
    seedHistory(join(dataFolder, 'visor.db'), dataFolder, JSON.parse(await readFile(resolve('fixtures/sessions/four-changes/history.json'), 'utf8')), migrations)
  }
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

async function expectDiagramFramed() {
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector('.diagram-canvas')?.getBoundingClientRect()
    const nodes = [...document.querySelectorAll('.class-node')].map((node) => node.getBoundingClientRect())
    return canvas && nodes.length > 0 && nodes.every((bounds) => bounds.left >= canvas.left && bounds.right <= canvas.right && bounds.top >= canvas.top && bounds.bottom <= canvas.bottom)
  })).toBe(true)
}

test('starts empty when no session has been observed', async () => {
  await expect(page.getByRole('heading', { name: 'No session', exact: true })).toBeVisible()
  await expect(page.getByTestId('class-node')).toHaveCount(0)
  await expect(page.getByTestId('change-entry')).toHaveCount(0)
  await expect(page.getByText('No classes', { exact: true })).toBeVisible()
})

test('loads stored history snapshots, marks changed classes, and supports keyboard and Live selection', async () => {
  await expect(page.getByTestId('change-entry')).toHaveCount(4)
  await expect(page.getByTestId('change-entry').locator('.change-topline > span')).toHaveText(['Change 4', 'Change 3', 'Change 2', 'Change 1'])
  await expect(page.getByRole('switch', { name: 'Live' })).toBeChecked()
  await page.getByTestId('change-entry').nth(2).click()
  await expect(page.getByRole('switch', { name: 'Live' })).not.toBeChecked()
  await expect(page.getByTestId('class-node')).toHaveCount(1)
  await expect(page.getByRole('heading', { name: 'CheckoutService', exact: true })).toHaveCount(0)
  const cart = page.getByTestId('class-node').filter({ has: page.getByRole('heading', { name: 'Cart', exact: true }) })
  await expect(cart).toHaveAttribute('data-change', 'modified')
  await expect(cart).toHaveCSS('animation-name', 'visor-change-glow')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('change-entry').last()).toHaveAttribute('aria-current', 'step')
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('change-entry').nth(2)).toHaveAttribute('aria-current', 'step')
  await page.getByRole('switch', { name: 'Live' }).check()
  await expect(page.getByTestId('change-entry').first()).toHaveAttribute('aria-current', 'step')
  await expect(page.getByTestId('class-node')).toHaveCount(2)
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await expectDiagramFramed()
  await page.screenshot({ path: 'test-results/visor-history-desktop.png', fullPage: true })
})

test('supports stored history session switching without losing paused selection', async () => {
  await expect(page.getByTestId('change-entry')).toHaveCount(4)
  await expect(page.getByTestId('change-entry').first()).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('switch', { name: 'Live' })).toBeChecked()
  const sessions = await page.evaluate(() => window.visorHistory?.listSessions())
  const original = sessions?.[0]?.id
  expect(original).toBeTruthy()
  const workspace = join(dataFolder, 'second-project')
  await mkdir(workspace)
  await writeFile(join(workspace, 'second.py'), 'class Second:\n    pass\n')
  const runtime = await readRuntime(dataFolder)
  if (!runtime || !original) throw new Error('Expected runtime and seeded session.')
  const second = 'second-session'
  const send = async (event: string, payload: RawHook['payload'] = {}) => {
    const response = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, { method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: randomUUID(), source: 'copilot', event, receivedAt: Date.now(), payload: { cwd: workspace, session_id: second, ...payload } }) })
    expect(response.status).toBe(202)
  }
  await send('sessionStart')
  await expect(page.getByRole('combobox', { name: 'Session' })).toHaveValue(second)
  await expect(page.getByRole('heading', { name: 'Second', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Session' }).selectOption(original)
  await expect(page.getByTestId('change-entry')).toHaveCount(4)
  await page.getByTestId('change-entry').nth(2).click()
  await expect(page.getByRole('switch', { name: 'Live' })).not.toBeChecked()
  await expect(page.getByRole('heading', { name: 'Cart', exact: true })).toBeVisible()
  const input = { tool_name: 'edit_file', tool_use_id: 'second-edit', tool_input: { filePath: 'second.py' } }
  await send('preToolUse', input)
  await writeFile(join(workspace, 'second.py'), 'class Second:\n    def run(self):\n        return 2\n')
  await send('postToolUse', input)
  await expect.poll(async () => (await page.evaluate((id) => window.visorHistory?.listChanges(id), second))?.length).toBe(2)
  await expect(page.getByRole('combobox', { name: 'Session' })).toHaveValue(original)
  await expect(page.getByTestId('change-entry').nth(2)).toHaveAttribute('aria-current', 'step')
  await expect(page.getByRole('heading', { name: 'Cart', exact: true })).toBeVisible()
})

test('shows the Step 1 diagram and method signature on hover', async () => {
  await expect(page.getByRole('heading', { name: 'Refactor the checkout flow' })).toBeVisible()
  await expect(page.getByTestId('class-node')).toHaveCount(2)
  await expect(page.locator('.react-flow__edge')).toHaveCount(1)
  await expect(page.getByTestId('change-entry')).toHaveCount(4)
  await expect(page.getByTestId('change-entry').first()).toContainText('Change 4')
  await page.evaluate(async () => { await document.fonts.ready })
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
  await expect(page.locator('.method-added .method-edited-dot, .method-deleted .method-edited-dot')).toHaveCount(0)
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
    await expect(page.getByTestId('class-node')).toHaveCount(2)
    await expectDiagramFramed()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `test-results/visor-${width}.png`, fullPage: true })
  }
})

test('supports keyboard tooltips and the mobile renderer layout', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Fit diagram', exact: true }).click()
  await expect(page.getByTestId('class-node')).toHaveCount(2)
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
  const workspace = join(dataFolder, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'diagram.py'), 'class Alpha:\n    pass\n\nclass Beta:\n    pass\n\nclass Gamma:\n    pass\n')
  await expect.poll(() => readRuntime(dataFolder)).not.toBeNull()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Raw hook capture' }).check()
  const events = ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'agentStop']
  for (const event of events) {
    const input = JSON.stringify({ sessionId: 'sandbox-session-42', cwd: workspace, toolName: 'read_file', toolInput: { filePath: 'diagram.py' }, prompt: 'Compare the sandbox classes', stop_hook_active: false, token: 'must-not-capture' })
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
  await expect(page.getByRole('heading', { name: 'Compare the sandbox classes', exact: true })).toBeVisible()
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
  const hook = hookConfiguration({ nodePath: process.execPath, hookPath: resolve('apps/hook/bin/visor-hook.cjs') }).hooks.preToolUse?.[0]
  if (!hook) throw new Error('The installer did not create a preToolUse command.')
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
  child.stdin.end('{"sessionId":"cold-hook-regression","tool_name":"create_file"}')
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

test('leaves an existing window minimized for session and read events, but restores it for an edit', async () => {
  const runtime = await readRuntime(dataFolder)
  if (!runtime) throw new Error('The test app did not publish its runtime.')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
  const raw: RawHook = { id: randomUUID(), source: 'copilot', event: 'SessionStart', receivedAt: Date.now(), payload: { session_id: 'second-session' } }
  const response = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, {
    method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(raw)
  })
  expect(response.status).toBe(202)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true)
  const read: RawHook = { ...raw, id: randomUUID(), event: 'PreToolUse', payload: { session_id: 'second-session', tool_name: 'read_file' } }
  const readResponse = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, {
    method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(read)
  })
  expect(readResponse.status).toBe(202)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(true)
  const edit: RawHook = { ...read, id: randomUUID(), payload: { session_id: 'second-session', tool_name: 'multi_replace_string_in_file' } }
  const editResponse = await fetch(`http://127.0.0.1:${runtime.port}/hooks/raw`, {
    method: 'POST', headers: { Authorization: `Bearer ${runtime.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(edit)
  })
  expect(editResponse.status).toBe(202)
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMinimized())).toBe(false)
  await expect(page.getByRole('heading', { name: 'No session', exact: true })).toBeVisible()
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})